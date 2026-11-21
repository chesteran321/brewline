import { gzipSync } from 'node:zlib';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DWELL_MS,
  POSITION_INTERVAL_MS,
  PlannedShipment,
  VoyageSettings,
  bookingBody,
  positionsForWindow,
  shipmentsDeparting,
} from '../../simulator/src/voyages';
import { ENTER_KM, EXIT_KM, MAX_TRACK_POINTS, TrackPoint, advance, averageKmh, eventId, mergeTrack, pickShipment, plannedKmh } from '../src/detector-core';
import { distanceKm, interpolate, simplify } from '../src/geo';
import { handler, parsePositions, setDepsForTesting } from '../src/handlers/voyage-detector';
import { DcsaTransportEventSchema, PositionRecord, ShipmentItem, bookingReference, equipmentFor, shipmentIdFromKey } from '../src/model';
import { seeds } from '../src/seeds';
import { ShipmentRepo } from '../src/shipment-repo';

const sd = seeds();
const route = sd.routes.get('DJJIB-TWKEL')!;
const POL = [route.pol.lat, route.pol.lon] as const;
const POD = [route.pod.lat, route.pod.lon] as const;
const now = new Date('2026-12-01T00:00:00Z');

const shipmentOf = (p: { lot_id: string; route_id: string; idempotencyKey: string; synthetic?: boolean } & ReturnType<typeof bookingBody>): ShipmentItem => {
  const id = shipmentIdFromKey(p.idempotencyKey);
  const r = sd.routes.get(p.route_id)!;
  return {
    pk: `SHIP#${id}`, sk: 'META', entity: 'Shipment', shipment_id: id, lot_id: p.lot_id, route_id: p.route_id, pol: r.pol.locode, pod: r.pod.locode,
    carrier_booking_reference: bookingReference(id), carrier_voyage_number: p.carrier_voyage_number,
    vessel: { vessel_id: p.vessel_id, vessel_name: p.vessel_name }, equipment: equipmentFor(id),
    planned_departure: p.planned_departure, planned_arrival: p.planned_arrival, status: 'PLANNED', request_hash: 'h', version: 1,
    created_by: 'roastery:x', created_at: 'x', synthetic: true,
  };
};
const fixed = shipmentOf({
  lot_id: 'L-2026-001', route_id: 'DJJIB-TWKEL', idempotencyKey: 'k'.repeat(20), carrier_voyage_number: 'D001E', vessel_id: 'SIMV-01', vessel_name: 'Demo Kestrel',
  planned_departure: '2026-11-25T00:00:00Z', planned_arrival: '2026-12-12T00:00:00Z', lot: undefined,
} as never);
const pos = (ts: string, at: readonly [number, number], sog = 15): PositionRecord => ({ source: 'sim', vessel_id: 'SIMV-01', ts, lat: at[0], lon: at[1], sog, synthetic: true });
const away = (km: number) => interpolate(POL, route.path.points[1]!, km / distanceKm(POL, route.path.points[1]!));

describe('advance (geofence with hysteresis)', () => {
  test('DEPA only after the vessel was seen inside 15 km and then beyond 20 km', () => {
    let r = advance(fixed, route, [pos('2026-11-24T20:00:00Z', POL, 0)], now);
    expect(r).toMatchObject({ status: 'PLANNED', tracking: { at_pol_seen: true } });
    // 15–20 km 之間：不判斷（遲滯）/ Between 15 and 20 km: no decision yet.
    const s1 = { ...fixed, tracking: r.tracking };
    r = advance(s1, route, [pos('2026-11-25T00:30:00Z', away(17))], now);
    expect(r.status).toBe('PLANNED');
    expect(r.events).toEqual([]);
    r = advance({ ...s1, tracking: r.tracking }, route, [pos('2026-11-25T01:00:00Z', away(30))], now);
    // atd＝最後一筆在 POL 內繫泊的時間（不是判斷當下）/ atd = last moored-in-POL time, not the detection time.
    expect(r).toMatchObject({ status: 'DEPARTED', atd: '2026-11-24T20:00:00Z' });
    expect(r.events).toHaveLength(1);
    expect(DcsaTransportEventSchema.parse(r.events[0])).toMatchObject({ transportEventTypeCode: 'DEPA', eventClassifierCode: 'ACT', transportCall: { UNLocationCode: 'DJJIB' } });
    expect(r.events[0]!.eventID).toBe(eventId(fixed.shipment_id, 'DEPA'));
    expect(r.eta).toBeDefined();
  });
  test('without a moored sample, atd falls back to the detection time', () => {
    const r1 = advance(fixed, route, [pos('2026-11-25T00:00:00Z', away(5), 8)], now); // 在港內但在動 / inside, moving
    const r2 = advance({ ...fixed, tracking: r1.tracking }, route, [pos('2026-11-25T01:00:00Z', away(30))], now);
    expect(r2.atd).toBe('2026-11-25T01:00:00Z');
  });
  test('negative: never seen at the POL → no DEPA even far away (booking created after the vessel left)', () => {
    const r = advance(fixed, route, [pos('2026-11-25T05:00:00Z', away(100))], now);
    expect(r.status).toBe('PLANNED');
    expect(r.events).toEqual([]);
  });
  test('ARRI needs both: inside the POD geofence and speed < 1 knot', () => {
    const dep: ShipmentItem = { ...fixed, status: 'DEPARTED', atd: '2026-11-25T01:00:00Z', tracking: { last_position_at: '2026-11-25T01:00:00Z', at_pol_seen: true } };
    let r = advance(dep, route, [pos('2026-12-11T23:00:00Z', POD, 6)], now); // 進港中，還在動 / still moving
    expect(r.status).toBe('DEPARTED');
    r = advance({ ...dep, tracking: r.tracking }, route, [pos('2026-12-11T23:30:00Z', POD, 0)], now);
    expect(r).toMatchObject({ status: 'ARRIVED', ata: '2026-12-11T23:30:00Z', eta: '2026-12-11T23:30:00Z' });
    expect(r.events[0]).toMatchObject({ transportEventTypeCode: 'ARRI', transportCall: { UNLocationCode: 'TWKEL' } });
  });
  test('idempotent: the same positions twice → no change; older positions → ignored', () => {
    const batch = [pos('2026-11-24T20:00:00Z', POL, 0), pos('2026-11-25T01:00:00Z', away(30))];
    const r1 = advance(fixed, route, batch, now);
    const s2 = { ...fixed, status: r1.status, atd: r1.atd, tracking: r1.tracking };
    const r2 = advance(s2, route, batch, now);
    expect(r2.changed).toBe(false);
    expect(r2.events).toEqual([]);
    expect(advance(s2, route, [pos('2026-11-24T23:00:00Z', POL, 0)], now).changed).toBe(false);
  });
  test('ETA: average speed from positions; falls back to the planned speed when the vessel waits at anchor', () => {
    const a = route.path.points[3]!;
    const b = route.path.points[4]!;
    const legKm = distanceKm(a, b);
    const recent: Array<[string, number, number]> = [['2026-11-28T00:00:00Z', a[0], a[1]], ['2026-11-28T06:00:00Z', b[0], b[1]]];
    expect(averageKmh(recent)).toBeCloseTo(legKm / 6, 3);
    const dep: ShipmentItem = { ...fixed, status: 'DEPARTED', atd: 'x', tracking: { last_position_at: '2026-11-27T23:30:00Z', recent: [] } };
    const anchored = advance(dep, route, [pos('2026-11-28T00:00:00Z', b, 0), pos('2026-11-28T06:00:00Z', b, 0)], now);
    const planned = plannedKmh(fixed, route);
    expect(planned).toBeGreaterThan(20);
    expect(Date.parse(anchored.eta!)).toBeGreaterThan(Date.parse('2026-11-28T06:00:00Z'));
  });
  test('pickShipment: not arrived and within the planned window ± 2 days; earliest first', () => {
    const later = { ...fixed, shipment_id: 'sh_LATER', planned_departure: '2026-12-23T00:00:00Z', planned_arrival: '2027-01-09T00:00:00Z' };
    expect(pickShipment([later, fixed], Date.parse('2026-11-30T00:00:00Z'))?.shipment_id).toBe(fixed.shipment_id);
    expect(pickShipment([later, fixed], Date.parse('2026-12-24T00:00:00Z'))?.shipment_id).toBe('sh_LATER');
    expect(pickShipment([{ ...fixed, status: 'ARRIVED' }], Date.parse('2026-11-30T00:00:00Z'))).toBeUndefined();
    expect(pickShipment([fixed], Date.parse('2027-03-01T00:00:00Z'))).toBeUndefined(); // 過期的訂艙不會卡住船 / stale bookings never block
  });
});

describe('track', () => {
  test('simplify keeps first/last and respects the limit; mergeTrack sorts, dedups and caps at 200', () => {
    const pts: TrackPoint[] = Array.from({ length: 1500 }, (_, i) => [i * 0.01, Math.sin(i / 50), new Date(Date.UTC(2026, 10, 1) + i * 60_000).toISOString()]);
    const t = mergeTrack(pts.slice(700), pts.slice(0, 700));
    expect(t.length).toBeLessThanOrEqual(MAX_TRACK_POINTS);
    expect(t[0]).toEqual(pts[0]);
    expect(t.at(-1)).toEqual(pts.at(-1));
    expect(mergeTrack([pts[0]!], [pts[0]!])).toHaveLength(1);
    const small = simplify([[0, 0], [1, 1]] as Array<[number, number]>, 2);
    expect(small).toHaveLength(2);
  });
});

// 回放測試（SHP-F-004）：用模擬器產生「真實答案」已知的航程，加入雜訊、隨機丟 10% 的點、一段 6 小時空白，
// 偵測結果的離港／抵港時間與答案相比，誤差 ≤ 1 小時的比例要 ≥ 90%（預期 100%）。
// Replay: voyages with known truth, 10% dropped points and a 6-hour gap; ≥ 90% within one hour (expect 100%).
describe.each([
  ['Prod scale', { timeScale: 1, startDate: '2026-11-23' } as VoyageSettings, 60],
  ['Dev ×24', { timeScale: 24, startDate: '2026-11-23' } as VoyageSettings, 8],
])('replay (%s)', (_name, cfg, days) => {
  test('departures and arrivals detected within one hour for ≥ 90% (expect 100%)', () => {
    const SEED = 'replay-seed';
    const start = Date.parse('2026-11-26T00:00:00Z');
    const end = start + days * 86_400_000;
    const ships: PlannedShipment[] = shipmentsDeparting(SEED, cfg, start, end - 3 * 86_400_000);
    expect(ships.length).toBeGreaterThan(3);
    let state = new Map(ships.map((p) => [p.vessel_id + p.etd, shipmentOf({ ...bookingBody(p), lot_id: p.lot_id, route_id: p.route_id, idempotencyKey: p.idempotencyKey })]));
    let drop = 0;
    const gapFrom = start + 5 * 86_400_000;
    for (let t = start - DWELL_MS; t < end; t += POSITION_INTERVAL_MS) {
      const recs = positionsForWindow(SEED, cfg, t, t + POSITION_INTERVAL_MS).filter(() => (drop = (drop * 1103515245 + 12345) % 2147483648) % 10 !== 0);
      if (t >= gapFrom && t < gapFrom + 6 * 3_600_000) continue; // 6 小時空白 / six-hour gap
      const byVessel = new Map<string, PositionRecord[]>();
      for (const r of recs) byVessel.set(r.vessel_id, [...(byVessel.get(r.vessel_id) ?? []), r as unknown as PositionRecord]);
      const next = new Map(state);
      for (const [vid, list] of byVessel) {
        const cand = [...state.values()].filter((s) => s.vessel.vessel_id === vid);
        const s = pickShipment(cand, Date.parse(list[0]!.ts));
        if (!s) continue;
        const r = advance(s, sd.routes.get(s.route_id)!, list, now);
        if (!r.changed) continue;
        const key = [...state.entries()].find(([, v]) => v.shipment_id === s.shipment_id)![0];
        next.set(key, { ...s, status: r.status, atd: r.atd, ata: r.ata, eta: r.eta, tracking: r.tracking, version: s.version + 1 });
      }
      state = next;
    }
    let ok = 0;
    let total = 0;
    for (const p of ships) {
      const s = state.get(p.vessel_id + p.etd)!;
      if (p.etd - DWELL_MS >= gapFrom - DWELL_MS && p.etd <= gapFrom + 6 * 3_600_000) continue; // 空白期間開航：不計 / skip the gap
      total += 2;
      if (s.atd && Math.abs(Date.parse(s.atd) - p.etd) <= 3_600_000) ok++;
      if (p.eta + DWELL_MS < end && s.ata && Math.abs(Date.parse(s.ata) - p.eta) <= 3_600_000) ok++;
      else if (p.eta + DWELL_MS >= end) total--; // 還沒抵達：不計 / not arrived yet
    }
    expect(total).toBeGreaterThan(4);
    expect(ok / total).toBeGreaterThanOrEqual(0.9);
    if (process.env.REPLAY_REPORT) console.log(`${_name}: ${ok}/${total} within 1 h`);
  });
});

describe('voyage-detector handler', () => {
  const s3 = mockClient(S3Client);
  const applied: unknown[] = [];
  let candidates: ShipmentItem[] = [];
  const fakeRepo = {
    vesselShipments: async () => candidates,
    getTrack: async () => [],
    applyAdvance: async (...a: unknown[]) => void applied.push(a),
  } as unknown as ShipmentRepo;
  const ev = (key: string, bucket = 'lake') => ({ 'detail-type': 'Object Created', detail: { bucket: { name: bucket }, object: { key, size: 100 } } });
  const body = (lines: string[]) => ({ Body: { transformToByteArray: async () => gzipSync(lines.join('\n')) } }) as never;
  beforeAll(() => {
    process.env.LAKE_BUCKET = 'lake';
    process.env.TABLE_NAME = 'tbl';
  });
  beforeEach(() => {
    s3.reset();
    applied.length = 0;
    candidates = [fixed];
    setDepsForTesting({ repo: fakeRepo, s3: new S3Client({}), now: () => now });
  });
  afterAll(() => setDepsForTesting(undefined));

  test('processes a file: matched vessel advanced; unmatched vessel counted; DEPA counted', async () => {
    s3.on(GetObjectCommand).resolves(
      body([
        JSON.stringify(pos('2026-11-24T20:00:00Z', POL, 0)),
        JSON.stringify(pos('2026-11-25T01:00:00Z', away(30))),
        JSON.stringify({ ...pos('2026-11-25T01:00:00Z', POL), vessel_id: 'SIMV-07' }),
      ]),
    );
    candidates = [fixed];
    const r = await handler(ev('raw/positions/source=sim/dt=2026-11-25/0100.jsonl.gz'));
    expect(r).toMatchObject({ outcome: 'processed', positions: 3, vessels: 2, updated: 2, departures: 1 });
  });
  test('negative: a malformed line rejects the whole file (→ retries → DLQ)', async () => {
    s3.on(GetObjectCommand).resolves(body([JSON.stringify(pos('2026-11-24T20:00:00Z', POL, 0)), '{"vessel_id": "SIMV-01", "lat": 999}']));
    await expect(handler(ev('raw/positions/source=sim/dt=2026-11-25/0100.jsonl.gz'))).rejects.toThrow(/line 2/);
    expect(applied).toHaveLength(0);
    expect(() => parsePositions(gzipSync('not json'))).toThrow(/line 1/);
  });
  test('negative: other prefixes or buckets are ignored without reading S3; non-S3 events throw', async () => {
    expect((await handler(ev('raw/events/dt=2026-11-25/x.gz'))).outcome).toBe('ignored');
    expect((await handler(ev('raw/positions/source=sim/x.jsonl.gz', 'other'))).outcome).toBe('ignored');
    expect(s3.commandCalls(GetObjectCommand)).toHaveLength(0);
    await expect(handler({ 'detail-type': 'Something' })).rejects.toThrow();
  });
  test('vessels without a matching shipment are skipped (not an error)', async () => {
    candidates = [];
    s3.on(GetObjectCommand).resolves(body([JSON.stringify(pos('2026-11-24T20:00:00Z', POL, 0))]));
    expect(await handler(ev('raw/positions/source=sim/dt=2026-11-25/0100.jsonl.gz'))).toMatchObject({ unmatchedVessels: 1, updated: 0 });
  });
});

void ENTER_KM;
void EXIT_KM;
