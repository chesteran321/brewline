import { AdminInitiateAuthCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { mockClient } from 'aws-sdk-client-mock';
import { SimulatorConfig } from '../src/config';
import { HOURS, planDay, planHour } from '../src/generator';
import { PACE_MS, SEED_PRODUCT_IDS, handler, setDepsForTesting } from '../src/run';
import { ROASTER_USERNAME, simUsers } from '../src/tenants';
import { gunzipSync } from 'node:zlib';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { seeds as shipmentSeeds } from '../../shipment/src/seeds';
import { assertCoordinatesFinal } from '../src/run';
import { bookingBody, bookingsDue, positionsForWindow, voyageDryRun } from '../src/voyages';

const cog = mockClient(CognitoIdentityProviderClient);
const ssm = mockClient(SSMClient);

const CONFIG: SimulatorConfig = {
  poolSize: 40, initialActive: 30, ordersPerDay: { min: 5, max: 40 }, linesPerOrder: { min: 1, max: 3 },
  kgPerLine: { min: 1, max: 5 }, duplicateOrderRate: 0.02, seed: 'x', activationStartMonth: '2026-11',
};
const ENV = {
  STATE_PARAM: '/s', CONFIG_PARAM: '/c', CREDENTIALS_PARAM: '/p', USER_POOL_ID: 'pool',
  SIMULATOR_CLIENT_ID: 'sim-client', API_ENDPOINT: 'https://api.example.com',
};
const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
const creds = { ...Object.fromEntries(simUsers('x', 40).map((u) => [u.username, `Pw-${u.index}-123456!`])), [ROASTER_USERNAME]: 'Pw-roaster-123456!' };

// 找一個「10 點有很多單、有重複下單」的日期 / Pick a date whose 10:00 hour has orders, including a duplicate.
const DATE = (() => {
  for (let i = 0; i < 400; i++) {
    const d = new Date(Date.UTC(2027, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
    const p = planHour(CONFIG, d, 10, SEED_PRODUCT_IDS);
    if (p.length >= 3 && p.some((o) => o.duplicate)) return d;
  }
  throw new Error('no suitable date');
})();
const PLAN = planHour(CONFIG, DATE, 10, SEED_PRODUCT_IDS);
const NOW = new Date(`${DATE}T02:05:00Z`); // 10:05 台北 / Taipei

interface Req { method: string; path: string; key?: string; token: string; body?: any }
let reqs: Req[];
let orderResponder: (req: Req, nth: number) => { status: number; body?: object };
let adminResponder: (req: Req) => { status: number; body?: object };
let catalogStatus: Record<string, string>;
let sleeps: number[];

setDepsForTesting({
  cognito: new CognitoIdentityProviderClient({ region: 'ap-east-2' }),
  ssm: new SSMClient({ region: 'ap-east-2' }),
  sleep: async (ms) => { sleeps.push(ms); },
  now: () => NOW,
  fetch: (async (url: URL, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    const req: Req = {
      method: init.method ?? 'GET', path: url.pathname + url.search, key: headers['idempotency-key'],
      token: headers.authorization!.replace('Bearer ', ''), body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    reqs.push(req);
    if (req.path === '/products') {
      const items = SEED_PRODUCT_IDS.map((id) => ({ id, stock_status: catalogStatus[id] ?? 'in_stock' }));
      return new Response(JSON.stringify({ items }), { status: 200 });
    }
    if (req.path.startsWith('/admin/')) {
      const r = adminResponder(req);
      return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
    }
    const nth = reqs.filter((r) => r.key === req.key).length;
    const r = orderResponder(req, nth);
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
  }) as unknown as typeof fetch,
});

beforeEach(() => {
  Object.assign(process.env, ENV);
  cog.reset();
  ssm.reset();
  reqs = [];
  sleeps = [];
  catalogStatus = {};
  orderResponder = (req, nth) => ({ status: nth === 1 ? 201 : 200, body: { order_id: `o_${req.key}` } });
  adminResponder = () => ({ status: 200, body: { items: [] } });
  ssm.on(GetParameterCommand, { Name: '/c' }).resolves({ Parameter: { Value: JSON.stringify(CONFIG) } });
  ssm.on(GetParameterCommand, { Name: '/p' }).resolves({ Parameter: { Value: JSON.stringify(creds) } });
  cog.on(AdminInitiateAuthCommand).callsFake((input) => ({
    AuthenticationResult: { AccessToken: jwt({ synthetic: 'true', username: input.AuthParameters.USERNAME }) },
  }));
});
const state = (v: string) => ssm.on(GetParameterCommand, { Name: '/s' }).resolves({ Parameter: { Value: v } });
const orderReqs = () => reqs.filter((r) => r.path === '/orders');
const userOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()).username as string;

// --- 開關 / Kill switch (SIM-N-001) ---
test('paused: no sign-in, no API call', async () => {
  state('paused');
  expect(await handler({ source: 'schedule' })).toEqual({ outcome: 'paused' });
  expect(cog.commandCalls(AdminInitiateAuthCommand)).toHaveLength(0);
  expect(reqs).toHaveLength(0);
});

test('fail safe: unreadable state → paused', async () => {
  ssm.on(GetParameterCommand, { Name: '/s' }).rejects(Object.assign(new Error('x'), { name: 'AccessDeniedException' }));
  expect(await handler({})).toEqual({ outcome: 'paused' });
  expect(reqs).toHaveLength(0);
});

test('manual probe while paused: reads the catalog, places no orders', async () => {
  state('paused');
  expect(await handler({ probe: true })).toMatchObject({ outcome: 'probe_ok', state: 'paused', status: 200, products: 8, synthetic: true });
  expect(orderReqs()).toHaveLength(0);
});

// --- 下單 / Ordering ---
test('running: places the planned orders through the public API as the planned cafés', async () => {
  state('running');
  const out = await handler({ source: 'schedule' });
  expect(out).toMatchObject({ outcome: 'simulated', date: DATE, hour: 10, planned: PLAN.length, violations: [] });
  const firsts = orderReqs().filter((r, i, a) => a.findIndex((x) => x.key === r.key) === i);
  expect(firsts).toHaveLength(PLAN.length);
  PLAN.forEach((o, i) => {
    expect(firsts[i]).toMatchObject({ method: 'POST', key: o.idempotencyKey, body: { items: o.items } });
    expect(userOf(firsts[i]!.token)).toBe(`sim-${String(o.tenantIndex).padStart(3, '0')}@example.com`);
  });
  // 只有 simulator client / Simulator client only.
  expect(cog.commandCalls(AdminInitiateAuthCommand).every((c) => c.args[0].input.ClientId === 'sim-client')).toBe(true);
});

test('duplicate injection: resent with the same key, 200 + same order id counts as ok (SIM-F-008)', async () => {
  state('running');
  const out = (await handler({})) as any;
  const dups = PLAN.filter((o) => o.duplicate).length;
  expect(out.duplicatesSent).toBe(dups);
  expect(out.duplicatesOk).toBe(dups);
  for (const o of PLAN.filter((x) => x.duplicate)) expect(orderReqs().filter((r) => r.key === o.idempotencyKey)).toHaveLength(2);
});

test('pacing: ≤ 1 request per second between API calls (SIM-N-002)', async () => {
  state('running');
  await handler({});
  // 咖啡廳的請求間隔 1 秒；烘焙廠另有自己的間隔（admin 路由）/ Café pacing; the roastery paces its own calls.
  expect(sleeps.filter((ms) => ms >= PACE_MS).length).toBe(orderReqs().length - 1);
});

test('each café signs in once per run', async () => {
  state('running');
  await handler({});
  const users = cog.commandCalls(AdminInitiateAuthCommand).map((c) => c.args[0].input.AuthParameters!.USERNAME);
  expect(new Set(users).size).toBe(users.length);
});

test('low / out-of-stock products are dropped; an order with nothing left is skipped (D4)', async () => {
  state('running');
  catalogStatus = Object.fromEntries(SEED_PRODUCT_IDS.map((id) => [id, 'low']));
  const out = (await handler({})) as any;
  expect(out.outcomes.skipped_no_stock).toBe(PLAN.length);
  expect(orderReqs()).toHaveLength(0);
});

test('re-running the same hour replays (200) and is not a violation', async () => {
  state('running');
  orderResponder = (req) => ({ status: 200, body: { order_id: `o_${req.key}` } });
  const out = (await handler({})) as any;
  expect(out.outcomes.replayed).toBe(PLAN.length);
  expect(out.violations).toEqual([]);
});

test('409 insufficient stock is expected, not a violation', async () => {
  state('running');
  orderResponder = () => ({ status: 409 });
  const out = (await handler({})) as any;
  expect(out.outcomes.insufficient_stock).toBe(PLAN.length);
  expect(out.duplicatesSent).toBe(0);
});

test('503 is retried once with the same key', async () => {
  state('running');
  orderResponder = (req, nth) => (nth === 1 ? { status: 503 } : { status: nth === 2 ? 201 : 200, body: { order_id: `o_${req.key}` } });
  const out = (await handler({})) as any;
  expect(out.outcomes.created).toBe(PLAN.length);
  expect(out.violations).toEqual([]);
});

// --- 反向：預期沒達成 → 丟錯（D9）/ Negative: unmet expectations throw ---
test.each([
  ['403 on POST', () => { orderResponder = () => ({ status: 403 }); }],
  ['500 on POST', () => { orderResponder = () => ({ status: 500 }); }],
  ['duplicate creates a second order', () => { orderResponder = (req, nth) => ({ status: 201, body: { order_id: `o_${req.key}_${nth}` } }); }],
])('violation: %s → throws after finishing the hour', async (_n, arrange) => {
  state('running');
  arrange();
  await expect(handler({})).rejects.toThrow('simulator expectations failed');
});

test('probe failure (no synthetic claim) → throws before ordering', async () => {
  state('running');
  cog.on(AdminInitiateAuthCommand).resolves({ AuthenticationResult: { AccessToken: jwt({}) } });
  await expect(handler({})).rejects.toThrow('probe failed');
  expect(orderReqs()).toHaveLength(0);
});

test('outside 08–19 Taipei: nothing planned', async () => {
  state('running');
  setDepsForTesting({ now: () => new Date(`${DATE}T13:05:00Z`) }); // 21:05 Taipei
  const out = (await handler({})) as any;
  setDepsForTesting({ now: () => NOW });
  expect(out).toMatchObject({ outcome: 'simulated', hour: 21, planned: 0 });
  expect(orderReqs()).toHaveLength(0);
});

// --- dry run（SIM-F-009）---
test('dry run: plan hash for a date, no switch, no sign-in, no API; same input → same hash', async () => {
  state('paused');
  const a = (await handler({ dryRun: true, date: '2027-03-15' })) as any;
  const b = (await handler({ dryRun: true, date: '2027-03-15' })) as any;
  expect(a).toEqual(b);
  expect(a.outcome).toBe('dry_run');
  expect(a.orders).toBe(planDay(CONFIG, '2027-03-15', SEED_PRODUCT_IDS).length);
  expect(a.perHour).toHaveLength(HOURS.length);
  expect(a.perHour.reduce((x: number, y: number) => x + y, 0)).toBe(a.orders);
  expect(cog.commandCalls(AdminInitiateAuthCommand)).toHaveLength(0);
  expect(reqs).toHaveLength(0);
});

// --- P2b-1：航程 dry run（SIM-F-009）/ Voyage dry run ---
test('voyages dry run: hash equals the local generator, no switch, no sign-in, no API, no S3', async () => {
  state('paused');
  const voyages = { timeScale: 24, startDate: '2026-11-22' };
  ssm.on(GetParameterCommand, { Name: '/c' }).resolves({ Parameter: { Value: JSON.stringify({ ...CONFIG, voyages }) } });
  const a = (await handler({ voyages: 'dryRun', date: '2026-11-30' })) as any;
  expect(a).toEqual({ outcome: 'voyages_dry_run', ...voyageDryRun(CONFIG.seed, voyages, '2026-11-30') });
  expect(a.positions).toBeGreaterThan(0);
  expect(cog.commandCalls(AdminInitiateAuthCommand)).toHaveLength(0);
  expect(reqs).toHaveLength(0);
});

test('negative: voyages actions other than dryRun are rejected in P2b-1; config without voyages fails loudly', async () => {
  state('running');
  await expect(handler({ voyages: 'positions' })).rejects.toThrow(/dryRun/);
  await expect(handler({ voyages: 'dryRun', date: '2026-11-30' })).rejects.toThrow(/voyages settings/);
  ssm.on(GetParameterCommand, { Name: '/c' }).resolves({ Parameter: { Value: JSON.stringify({ ...CONFIG, voyages: { timeScale: 0, startDate: '2026-11-22' } }) } });
  await expect(handler({ voyages: 'dryRun' })).rejects.toThrow();
  expect(cog.commandCalls(AdminInitiateAuthCommand)).toHaveLength(0);
  expect(reqs).toHaveLength(0);
});

test('negative: invalid config → throws before signing in', async () => {
  state('running');
  ssm.on(GetParameterCommand, { Name: '/c' }).resolves({ Parameter: { Value: JSON.stringify({ ...CONFIG, extra: 1 }) } });
  await expect(handler({})).rejects.toThrow();
  expect(cog.commandCalls(AdminInitiateAuthCommand)).toHaveLength(0);
});

// --- 模擬烘焙廠（S2d）/ Simulated roastery ---
const syntheticOrder = (id: string, status: string) => ({
  order_id: id, tenant_id: 't_01AAAAAAAAAAAAAAAAAAAAAAAA', status, synthetic: true, status_history: [],
  allocations: [{ product_id: 'p-0001', qty_kg: 3, allocated_kg: 0, roast_ids: [] }],
});
const adminReqs = () => reqs.filter((r) => r.path.startsWith('/admin/'));

test('roastery runs after the cafés in the same run, as the roaster (confirm every hour)', async () => {
  state('running');
  const out = (await handler({})) as any;
  // 10:05：每小時的確認＋10 時的完成 / 10:05: hourly confirm plus the 10:00 completion step.
  expect(out.roastery.map((r: any) => r.step)).toEqual(['confirm', 'complete']);
  const firstAdmin = reqs.findIndex((r) => r.path.startsWith('/admin/'));
  const lastOrder = reqs.map((r) => r.path).lastIndexOf('/orders');
  expect(firstAdmin).toBeGreaterThan(lastOrder);
  expect(new Set(adminReqs().map((r) => userOf(r.token)))).toEqual(new Set([ROASTER_USERNAME]));
});

test('roastery step failure → run throws after the cafés ordered (roastery count in the message)', async () => {
  state('running');
  adminResponder = (req) => (req.method === 'GET' ? { status: 200, body: { items: [syntheticOrder('o_X', 'CREATED')] } } : { status: 500 });
  await expect(handler({})).rejects.toThrow(/cafe 0, roastery [1-9]/);
  expect(orderReqs().length).toBeGreaterThan(0); // 咖啡廳照常下單 / cafés still ordered
});

test('manual roastery step while paused: runs only that step, places no café orders', async () => {
  state('paused');
  const out = (await handler({ roastery: 'ship' })) as any;
  expect(out).toMatchObject({ outcome: 'roastery', roastery: [{ step: 'ship', violations: [] }] });
  expect(orderReqs()).toHaveLength(0);
  expect(adminReqs().map((r) => r.path)).toEqual(['/admin/orders?status=ROASTED&limit=50']);
  const tokens = new Set(adminReqs().map((r) => userOf(r.token)));
  expect([...tokens]).toEqual([ROASTER_USERNAME]);
});

test('negative: unknown manual roastery step → throws before signing in', async () => {
  state('running');
  await expect(handler({ roastery: 'burn-it-all' })).rejects.toThrow('unknown roastery step');
  expect(cog.commandCalls(AdminInitiateAuthCommand)).toHaveLength(0);
});

test('negative: roaster token without synthetic claim → roastery violation, cafés unaffected', async () => {
  state('running');
  cog.on(AdminInitiateAuthCommand).callsFake((input) => ({
    AuthenticationResult: { AccessToken: jwt(input.AuthParameters.USERNAME === ROASTER_USERNAME ? { username: ROASTER_USERNAME } : { synthetic: 'true', username: input.AuthParameters.USERNAME }) },
  }));
  await expect(handler({})).rejects.toThrow(/roastery 1/);
  expect(adminReqs()).toHaveLength(0);
});

// --- P2b-2：位置段與訂艙段 / Positions and shipments segments ---
describe('P2b-2 segments', () => {
  const s3m = mockClient(S3Client);
  const voyages = { timeScale: 24, startDate: '2026-11-23' };
  const cfgV = { ...CONFIG, voyages };
  const provisional = () => ({ ...shipmentSeeds(), coordinatesStatus: 'provisional' as const });
  // 找一個「有訂艙該建立」的整點 / An hour at which bookings are due.
  const dueAt = (() => {
    for (let t = Date.parse('2026-12-01T00:05:00Z'); ; t += 3_600_000) if (bookingsDue(CONFIG.seed, voyages, t).length > 0) return t;
  })();
  beforeEach(() => {
    s3m.reset();
    s3m.on(PutObjectCommand).resolves({});
    ssm.on(GetParameterCommand, { Name: '/c' }).resolves({ Parameter: { Value: JSON.stringify(cfgV) } });
    process.env.LAKE_BUCKET = 'lake-bucket';
    setDepsForTesting({ s3: new S3Client({ region: 'ap-east-2' }), shipmentSeeds: shipmentSeeds, now: () => new Date(dueAt) });
  });
  afterEach(() => {
    delete process.env.LAKE_BUCKET;
    setDepsForTesting({ now: () => NOW, shipmentSeeds: shipmentSeeds });
  });

  test('positions: writes the previous 30-minute window as gzip JSON Lines to raw/positions/source=sim/; no sign-in, no API', async () => {
    state('running');
    const at = Date.parse('2026-12-03T05:20:00Z');
    setDepsForTesting({ now: () => new Date(at) });
    const out = (await handler({ segment: 'positions' })) as any;
    expect(out).toMatchObject({ outcome: 'positions', key: 'raw/positions/source=sim/dt=2026-12-03/0430.jsonl.gz', written: true });
    const put = s3m.commandCalls(PutObjectCommand)[0]!.args[0].input;
    expect(put).toMatchObject({ Bucket: 'lake-bucket', Key: out.key });
    expect(put.ServerSideEncryption).toBeUndefined(); // 預設加密套用 CMK / default encryption applies the CMK
    const lines = gunzipSync(put.Body as Buffer).toString('utf8').trim().split('\n');
    expect(lines).toHaveLength(out.records);
    expect(lines.map((l) => JSON.parse(l))).toEqual(positionsForWindow(CONFIG.seed, voyages, at - 30 * 60_000 - (at % (30 * 60_000)), at - (at % (30 * 60_000))));
    expect(cog.commandCalls(AdminInitiateAuthCommand)).toHaveLength(0);
    expect(reqs).toHaveLength(0);
    // 指定 at：寫那個時間窗（補寫）/ With `at`: that window.
    const back = (await handler({ segment: 'positions', at: '2026-12-03T04:00:00Z' })) as any;
    expect(back.key).toBe('raw/positions/source=sim/dt=2026-12-03/0400.jsonl.gz');
  });
  test('negative: positions while paused → nothing written; provisional coordinates → throws, nothing written; unknown segment → throws', async () => {
    state('paused');
    expect(await handler({ segment: 'positions' })).toEqual({ outcome: 'paused' });
    state('running');
    setDepsForTesting({ shipmentSeeds: provisional });
    await expect(handler({ segment: 'positions' })).rejects.toThrow(/provisional/);
    await expect(handler({ segment: 'nope' })).rejects.toThrow(/unknown segment/);
    expect(s3m.commandCalls(PutObjectCommand)).toHaveLength(0);
    expect(() => assertCoordinatesFinal(provisional())).toThrow();
    expect(() => assertCoordinatesFinal(shipmentSeeds())).not.toThrow();
  });
  test('shipments: due bookings go through POST /admin/shipments as the simulated roaster (201 / 200 are fine)', async () => {
    state('running');
    let n = 0;
    adminResponder = (req) => (req.path === '/admin/shipments' ? { status: n++ === 0 ? 201 : 200, body: {} } : { status: 200, body: { items: [] } });
    const out = (await handler({ segment: 'shipments' })) as any;
    const due = bookingsDue(CONFIG.seed, voyages, dueAt);
    expect(out).toMatchObject({ outcome: 'shipments', due: due.length, violations: [] });
    const posts = reqs.filter((r) => r.path === '/admin/shipments');
    expect(posts.map((r) => r.key)).toEqual(due.map((p) => p.idempotencyKey));
    expect(posts.every((r) => userOf(r.token) === ROASTER_USERNAME)).toBe(true);
    expect(posts[0]!.body).toEqual(bookingBody(due[0]!));
  });
  test('negative: a booking answered 400/422 is a violation (→ throws → run-errors alarm); provisional coordinates book nothing', async () => {
    state('running');
    adminResponder = (req) => (req.path === '/admin/shipments' ? { status: 422, body: { error: { code: 'idempotency_key_reused' } } } : { status: 200, body: { items: [] } });
    await expect(handler({ segment: 'shipments' })).rejects.toThrow(/idempotency_key_reused/);
    reqs = [];
    setDepsForTesting({ shipmentSeeds: provisional });
    await expect(handler({ segment: 'shipments' })).rejects.toThrow(/provisional/);
    expect(reqs.filter((r) => r.path === '/admin/shipments')).toHaveLength(0);
  });
});
