import { EventEmitter } from 'node:events';
import { gunzipSync } from 'node:zlib';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { mockClient } from 'aws-sdk-client-mock';
import {
  AIS_MESSAGE_TYPES,
  BOX_HALF_DEG,
  MAX_ATTEMPTS,
  backoffMs,
  cleanText,
  dedupe,
  objectKeys,
  parseMessage,
  portBoxes,
  subscription,
  timestampOf,
  vesselIdOf,
} from '../src/ais/spike';
import { Connect, SocketLike, collect, errorCode, handler, logger, setDepsForTesting } from '../src/handlers/ais-sampler';
import { PositionRecordSchema } from '../src/model';
import { parsePositions } from '../src/handlers/voyage-detector';
import { seeds } from '../src/seeds';

const boxes = portBoxes();
const khh = seeds().ports.get('TWKHH')!;
const RX = Date.parse('2026-11-27T02:10:30.400Z');

const position = (o: Record<string, unknown> = {}, meta: Record<string, unknown> = {}) => ({
  MessageType: 'PositionReport',
  MetaData: { MMSI: 416123456, ShipName: 'EVER TEST@@@@  ', latitude: khh.lat, longitude: khh.lon, time_utc: '2026-11-27 02:10:29.987654321 +0000 UTC', ...meta },
  Message: { PositionReport: { Latitude: khh.lat, Longitude: khh.lon, Sog: 0.1, Cog: 123.45, NavigationalStatus: 5, Valid: true, UserID: 416123456, ...o } },
});
const staticMsg = (o: Record<string, unknown> = {}) => ({
  MessageType: 'ShipStaticData',
  MetaData: { MMSI: 416123456, ShipName: 'EVER TEST', latitude: khh.lat, longitude: khh.lon, time_utc: '2026-11-27 02:10:31 +0000 UTC' },
  Message: { ShipStaticData: { Name: 'EVER TEST@@', Type: 71, Destination: 'TW KHH@@@', Valid: true, ...o } },
});

describe('subscription and boxes (F4, F5)', () => {
  test('one box per seeded port (10, spike-only VNSGN included), ±0.3°, latitude first', () => {
    expect(boxes.map((b) => b.locode).sort()).toEqual([...seeds().ports.keys()].sort());
    expect(boxes).toHaveLength(10);
    expect(boxes.map((b) => b.locode)).toContain('VNSGN');
    const b = boxes.find((x) => x.locode === 'TWKHH')!;
    expect(b.corners[0][0]).toBeCloseTo(khh.lat - BOX_HALF_DEG, 6); // [lat, lon]
    expect(b.corners[0][1]).toBeCloseTo(khh.lon - BOX_HALF_DEG, 6);
    expect(b.corners[1][0]).toBeCloseTo(khh.lat + BOX_HALF_DEG, 6);
  });

  test('subscription: APIKey, BoundingBoxes [[lat,lon],[lat,lon]], only PositionReport + ShipStaticData', () => {
    const s = subscription('k', boxes);
    expect(Object.keys(s).sort()).toEqual(['APIKey', 'BoundingBoxes', 'FilterMessageTypes']);
    expect(s.FilterMessageTypes).toEqual(['PositionReport', 'ShipStaticData']);
    expect(AIS_MESSAGE_TYPES).not.toContain('StandardClassBPositionReport');
    expect(s.BoundingBoxes).toHaveLength(10);
    for (const box of s.BoundingBoxes) {
      expect(box).toHaveLength(2);
      for (const [lat, lon] of box) {
        expect(Math.abs(lat!)).toBeLessThanOrEqual(90);
        expect(Math.abs(lon!)).toBeLessThanOrEqual(180);
      }
    }
    // 緯度在前：高雄的緯度約 22.6、經度約 120.3 / Latitude first.
    const kh = s.BoundingBoxes[boxes.findIndex((b) => b.locode === 'TWKHH')]!;
    expect(kh[0]![0]).toBeLessThan(30);
    expect(kh[0]![1]).toBeGreaterThan(100);
  });
});

describe('normalisation (F6)', () => {
  test('a position report becomes a detector-valid record (source=ais, MMSI-<9>, no synthetic flag)', () => {
    const p = parseMessage(position(), RX, boxes);
    expect(p.kind).toBe('position');
    if (p.kind !== 'position') return;
    expect(p.record).toEqual({
      source: 'ais', vessel_id: 'MMSI-416123456', vessel_name: 'EVER TEST', ts: '2026-11-27T02:10:29Z',
      lat: khh.lat, lon: khh.lon, sog: 0.1, cog: 123.5, nav_status: 5,
    });
    expect(p.box).toBe('TWKHH');
    expect(PositionRecordSchema.safeParse(p.record).success).toBe(true);
    expect('synthetic' in p.record).toBe(false);
  });

  test.each([
    ['latitude 91 = not available', { Latitude: 91 }, 'no_position'],
    ['longitude 181 = not available', { Longitude: 181 }, 'no_position'],
    ['SOG 102.3 = not available', { Sog: 102.3 }, 'no_speed'],
    ['SOG above the detector schema (60 kn)', { Sog: 75 }, 'no_speed'],
    ['Valid = false', { Valid: false }, 'invalid'],
    ['missing Sog', { Sog: undefined }, 'bad_position'],
  ])('skipped: %s', (_name, o, reason) => {
    expect(parseMessage(position(o), RX, boxes)).toEqual({ kind: 'skipped', reason });
  });

  test('COG 360 (not available) and nav status 16 are dropped, the record is kept', () => {
    const p = parseMessage(position({ Cog: 360, NavigationalStatus: 16 }), RX, boxes);
    expect(p.kind).toBe('position');
    if (p.kind === 'position') {
      expect(p.record.cog).toBeUndefined();
      expect(p.record.nav_status).toBeUndefined();
    }
  });

  test('time_utc in an unknown shape → receive time (whole seconds)', () => {
    expect(timestampOf('yesterday', RX)).toBe('2026-11-27T02:10:30Z');
    expect(timestampOf(undefined, RX)).toBe('2026-11-27T02:10:30Z');
    expect(timestampOf('2026-11-27 02:10:29 +0000 UTC', RX)).toBe('2026-11-27T02:10:29Z');
    expect(timestampOf('2026-11-27T02:10:29Z', RX)).toBe('2026-11-27T02:10:29Z');
  });

  test('static data: name, ship type, destination cleaned of @ padding', () => {
    const s = parseMessage(staticMsg(), RX, boxes);
    expect(s).toEqual({
      kind: 'static',
      record: { source: 'ais', vessel_id: 'MMSI-416123456', vessel_name: 'EVER TEST', ship_type: 71, destination: 'TW KHH', ts: '2026-11-27T02:10:31Z' },
      box: 'TWKHH',
    });
  });

  test('control and junk: subscription confirmation, server error, other types, no envelope', () => {
    expect(parseMessage({ MessageType: 'SubscriptionConfirmation', Message: { SubscriptionConfirmation: { CompressionEnabled: true } } }, RX, boxes))
      .toEqual({ kind: 'control', compression: true });
    expect(parseMessage({ error: 'Api Key Is Not Valid' }, RX, boxes)).toEqual({ kind: 'control', error: 'Api Key Is Not Valid' });
    expect(parseMessage({ ...position(), MessageType: 'StandardClassBPositionReport' }, RX, boxes)).toEqual({ kind: 'skipped', reason: 'other_type' });
    expect(parseMessage([1, 2], RX, boxes)).toEqual({ kind: 'skipped', reason: 'not_an_envelope' });
  });

  test('helpers: MMSI padding, text cleaning', () => {
    expect(vesselIdOf(12345)).toBe('MMSI-000012345');
    expect(vesselIdOf('416123456')).toBe('MMSI-416123456');
    expect(cleanText('@@@@', 20)).toBeUndefined();
    expect(cleanText('  A\u0000B  C ', 20)).toBe('A B C');
  });

  test('dedupe by vessel and second, sorted by time then vessel', () => {
    const a = { vessel_id: 'MMSI-2', ts: '2026-11-27T02:10:02Z' };
    const b = { vessel_id: 'MMSI-1', ts: '2026-11-27T02:10:02Z' };
    const c = { vessel_id: 'MMSI-1', ts: '2026-11-27T02:10:01Z' };
    expect(dedupe([a, b, c, { ...a }])).toEqual([c, b, a]);
  });

  test('keys follow the simulator layout (UTC date, HHmm)', () => {
    expect(objectKeys(Date.parse('2026-11-27T16:40:12Z'))).toEqual({
      positions: 'raw/positions/source=ais/dt=2026-11-27/1640.jsonl.gz',
      static: 'raw/ais-static/dt=2026-11-27/1640.jsonl.gz',
    });
  });

  test('back-off: 1 s then 2 s; at most 3 attempts (F7)', () => {
    expect(MAX_ATTEMPTS).toBe(3);
    expect([1, 2].map(backoffMs)).toEqual([1000, 2000]);
  });
});

// --- 假 WebSocket / Fake socket ---
class FakeSocket extends EventEmitter implements SocketLike {
  sent: string[] = [];
  closed = false;
  constructor(private readonly script: (s: FakeSocket) => void) {
    super();
    setImmediate(() => this.script(this));
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    if (!this.closed) {
      this.closed = true;
      this.emit('close', 1000);
    }
  }
}
const frame = (o: unknown) => Buffer.from(JSON.stringify(o));

describe('collect()', () => {
  test('subscribes immediately on open and buffers frames until the deadline', async () => {
    let sock!: FakeSocket;
    const connect: Connect = () =>
      (sock = new FakeSocket((s) => {
        s.emit('open');
        s.emit('message', frame(position()), true);
      }));
    const r = await collect(connect, '{"APIKey":"k"}', Date.now, Date.now() + 30);
    expect(sock.sent).toEqual(['{"APIKey":"k"}']);
    expect(r.opened).toBe(true);
    expect(r.frames).toHaveLength(1);
    expect(sock.closed).toBe(true);
  });

  test('a close before any message is a failed attempt (closed_<code>)', async () => {
    const connect: Connect = () => new FakeSocket((s) => s.emit('close', 1008));
    const r = await collect(connect, 'x', Date.now, Date.now() + 1000);
    expect(r.frames).toHaveLength(0);
    expect(r.error).toBe('closed_1008');
  });

  // 診斷（2026-11-26：排程執行只記到 "Error"，看不出原因）/ Diagnostics: keep a secret-free reason per attempt.
  test('handshake refused (unexpected-response) → http_<status>, not opened, with elapsed ms', async () => {
    const connect: Connect = () => new FakeSocket((s) => s.emit('unexpected-response', {}, { statusCode: 429 }));
    const r = await collect(connect, 'x', Date.now, Date.now() + 1000);
    expect(r.error).toBe('http_429');
    expect(r.opened).toBe(false);
    expect(typeof r.ms).toBe('number');
  });

  test('network error keeps its code; a later close does not overwrite it', async () => {
    const connect: Connect = () =>
      new FakeSocket((s) => {
        s.emit('error', Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:443'), { code: 'ECONNREFUSED' }));
        s.emit('close', 1006);
      });
    const r = await collect(connect, 'x', Date.now, Date.now() + 1000);
    expect(r.error).toBe('ECONNREFUSED');
  });
});

describe('errorCode() never returns message text', () => {
  test.each([
    [Object.assign(new Error('getaddrinfo ENOTFOUND stream.aisstream.io'), { code: 'ENOTFOUND' }), 'ENOTFOUND'],
    [Object.assign(new Error('x'), { code: 'ETIMEDOUT' }), 'ETIMEDOUT'],
    [new Error('Opening handshake has timed out'), 'handshake_timeout'],
    [new Error('Unexpected server response: 403'), 'http_403'],
    [Object.assign(new Error('APIKey=secret in url'), { code: 'bad code with spaces' }), 'Error'],
    [{ name: 'Error: secret', message: 'x' }, 'Error'],
    [undefined, 'Error'],
  ])('%#', (err, want) => {
    expect(errorCode(err)).toBe(want);
  });
});

describe('handler', () => {
  const ssm = mockClient(SSMClient);
  const s3 = mockClient(S3Client);
  beforeEach(() => {
    ssm.reset();
    s3.reset();
    process.env.LAKE_BUCKET = 'lake';
    process.env.AIS_KEY_PARAM = '/brewline/dev/ais/api-key';
    process.env.COLLECT_SECONDS = '5';
    ssm.on(GetParameterCommand).resolves({ Parameter: { Value: 'secret-key-value' } });
    s3.on(PutObjectCommand).resolves({});
  });
  afterAll(() => setDepsForTesting(undefined));

  const run = (scripts: Array<(s: FakeSocket) => void>, clockStart = Date.parse('2026-11-27T02:10:00.500Z')) => {
    let t = clockStart;
    const sleeps: number[] = [];
    const sockets: FakeSocket[] = [];
    setDepsForTesting({
      ssm: new SSMClient({}),
      s3: new S3Client({}),
      connect: () => {
        const s = new FakeSocket(scripts[sockets.length] ?? ((x) => x.emit('close', 1006)));
        sockets.push(s);
        return s;
      },
      now: () => (t += 10),
      sleep: async (ms) => void sleeps.push(ms),
    });
    return { sleeps, sockets };
  };

  test('reads the key with decryption, writes positions + static; files parse with the detector; key never logged', async () => {
    // 日誌在測試時是 SILENT → 直接攔截 logger 的呼叫參數 / Logs are silenced in tests, so capture the logger calls.
    const logs: string[] = [];
    const spies = (['info', 'warn', 'error'] as const).map((lvl) =>
      jest.spyOn(logger, lvl).mockImplementation((...args: unknown[]) => void logs.push(JSON.stringify(args))),
    );
    const { sockets } = run([
      (s) => {
        s.emit('open');
        s.emit('message', frame({ MessageType: 'SubscriptionConfirmation', Message: { SubscriptionConfirmation: { CompressionEnabled: true } } }), true);
        s.emit('message', frame(position()), true);
        s.emit('message', frame(position()), true); // 重複 / duplicate
        s.emit('message', frame(position({}, { MMSI: 416000001, time_utc: '2026-11-27 02:10:40 +0000 UTC' })), true);
        s.emit('message', frame(position({ Sog: 102.3 })), true);
        s.emit('message', frame(staticMsg()), true);
        s.emit('message', Buffer.from('not json'), false);
        s.close();
      },
    ]);
    const out = await handler();
    for (const sp of spies) sp.mockRestore();

    expect(ssm.commandCalls(GetParameterCommand)[0]!.args[0].input).toEqual({ Name: '/brewline/dev/ais/api-key', WithDecryption: true });
    expect(JSON.parse(sockets[0]!.sent[0]!).APIKey).toBe('secret-key-value');
    expect(out).toMatchObject({ attempts: 1, positions: 2, statics: 1, vessels: 2, compression: true, skipped: { no_speed: 1, not_json: 1 } });
    expect(out.boxes.find((b) => b.box === 'TWKHH')).toEqual({ box: 'TWKHH', positions: 2, vessels: 2 });

    const puts = s3.commandCalls(PutObjectCommand).map((c) => c.args[0].input);
    expect(puts.map((p) => p.Key)).toEqual(['raw/positions/source=ais/dt=2026-11-27/0210.jsonl.gz', 'raw/ais-static/dt=2026-11-27/0210.jsonl.gz']);
    for (const p of puts) {
      expect(p.Bucket).toBe('lake');
      expect(p.ServerSideEncryption).toBeUndefined(); // 預設加密（CMK）/ default encryption
      expect(p.SSEKMSKeyId).toBeUndefined();
    }
    // 偵測函數用同一個 parser 讀得懂 → 不會進 DLQ / The detector accepts the file.
    const parsed = parsePositions(Buffer.from(puts[0]!.Body as Uint8Array));
    expect(parsed).toHaveLength(2);
    const text = gunzipSync(puts[0]!.Body as Uint8Array).toString();
    expect(text.endsWith('\n')).toBe(true);
    expect(text.split('\n').filter(Boolean)).toHaveLength(2);

    // F10：日誌沒有 key、MMSI、船名、座標 / No key, MMSI, name or coordinates in logs.
    const logText = logs.join('');
    expect(logText).toContain('ais sample');
    for (const forbidden of ['secret-key-value', '416123456', 'EVER TEST', String(khh.lat)]) expect(logText).not.toContain(forbidden);
  });

  test('connection failures back off (1 s, 2 s) and give up after 3 attempts → throws (→ shipment-dlq)', async () => {
    const { sleeps, sockets } = run([(s) => s.emit('close', 1006), (s) => s.emit('close', 1006), (s) => s.emit('close', 1006)]);
    await expect(handler()).rejects.toThrow('no AIS messages after 3 attempt(s): closed_1006, closed_1006, closed_1006');
    expect(sockets).toHaveLength(3);
    expect(sleeps).toEqual([1000, 2000]);
    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
  });

  test('failure log lists each attempt (code, opened, ms) and never the key', async () => {
    const logs: string[] = [];
    const spies = (['info', 'warn', 'error'] as const).map((lvl) =>
      jest.spyOn(logger, lvl).mockImplementation((...args: unknown[]) => void logs.push(JSON.stringify(args))),
    );
    run([
      (s) => s.emit('unexpected-response', {}, { statusCode: 401 }),
      (s) => s.emit('error', Object.assign(new Error('x'), { code: 'ETIMEDOUT' })),
      (s) => {
        s.emit('open');
        s.emit('close', 1008);
      },
    ]);
    await expect(handler()).rejects.toThrow('no AIS messages after 3 attempt(s): http_401, ETIMEDOUT, closed_1008');
    const logText = logs.join('');
    expect(logText).toContain('"attemptLog"');
    expect(logText).toContain('"opened":true');
    expect(logText).not.toContain('secret-key-value');
    for (const sp of spies) sp.mockRestore();
  });

  test('second attempt succeeds after one failure', async () => {
    const { sleeps } = run([
      (s) => s.emit('close', 1006),
      (s) => {
        s.emit('open');
        s.emit('message', frame(position()), true);
        s.close();
      },
    ]);
    const out = await handler();
    expect(out.attempts).toBe(2);
    expect(sleeps).toEqual([1000]);
  });

  test('messages but zero usable positions → throws, nothing written', async () => {
    run([
      (s) => {
        s.emit('open');
        s.emit('message', frame(position({ Latitude: 91 })), true);
        s.close();
      },
    ]);
    await expect(handler()).rejects.toThrow('no usable positions');
    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
  });

  test('empty key parameter → throws before connecting', async () => {
    ssm.on(GetParameterCommand).resolves({ Parameter: { Value: '' } });
    const { sockets } = run([]);
    await expect(handler()).rejects.toThrow('API key parameter is empty');
    expect(sockets).toHaveLength(0);
  });
});
