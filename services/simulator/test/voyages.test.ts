import { distanceKm } from '../../shipment/src/geo';
import { CreateShipmentRequestSchema, SIM_VESSEL_ID } from '../../shipment/src/model';
import { seeds } from '../../shipment/src/seeds';
import {
  DAY_MS,
  DWELL_MS,
  HOUR_MS,
  POSITION_INTERVAL_MS,
  VESSEL_NAMES,
  VoyageSettings,
  bookingBody,
  bookingsDue,
  positionAt,
  positionsForWindow,
  positionsKey,
  shipmentsDeparting,
  voyageDryRun,
} from '../src/voyages';

const SEED = 'brewline-dev-sim-2026';
const PROD: VoyageSettings = { timeScale: 1, startDate: '2026-11-22' };
const DEV: VoyageSettings = { timeScale: 24, startDate: '2026-11-22' };
const START = Date.parse('2026-11-22T00:00:00Z');
const sd = seeds();
const portOf = (code: string) => [sd.ports.get(code)!.lat, sd.ports.get(code)!.lon] as const;

describe('voyage planner', () => {
  test('deterministic: same inputs → same plan; seed or settings change it', () => {
    const a = shipmentsDeparting(SEED, PROD, START, START + 60 * DAY_MS);
    expect(shipmentsDeparting(SEED, PROD, START, START + 60 * DAY_MS)).toEqual(a);
    expect(shipmentsDeparting('other-seed', PROD, START, START + 60 * DAY_MS)).not.toEqual(a);
    expect(shipmentsDeparting(SEED, DEV, START, START + 60 * DAY_MS)).not.toEqual(a);
  });
  test('only plannable lots (no Dev test lots, no Taiwan lot); every lot ships once per 28-day cycle (Prod)', () => {
    const ships = shipmentsDeparting(SEED, PROD, START + 30 * DAY_MS, START + 30 * DAY_MS + 28 * DAY_MS);
    expect(ships.map((s) => s.lot_id).sort()).toEqual(['L-2026-001', 'L-2026-002', 'L-2026-003', 'L-2026-004', 'L-2026-005', 'L-2026-006', 'L-2026-007']);
  });
  test('E12: nothing whose booking opens before startDate', () => {
    for (const s of [PROD, DEV]) {
      for (const p of shipmentsDeparting(SEED, s, START - 30 * DAY_MS, START + 90 * DAY_MS)) expect(p.bookingOpensAt).toBeGreaterThanOrEqual(START);
    }
  });
  test('voyage lengths: Prod 3–45 days; Dev ×24 under 2 days', () => {
    for (const p of shipmentsDeparting(SEED, PROD, START, START + 60 * DAY_MS)) {
      const days = (p.eta - p.etd) / DAY_MS;
      expect(days).toBeGreaterThan(3);
      expect(days).toBeLessThan(45);
      expect(p.speedKn).toBeGreaterThanOrEqual(14);
      expect(p.speedKn).toBeLessThanOrEqual(18);
    }
    for (const p of shipmentsDeparting(SEED, DEV, START, START + 10 * DAY_MS)) expect(p.eta - p.etd).toBeLessThan(2 * DAY_MS);
  });
  test('Dev ×24 has departures and arrivals every day (E9)', () => {
    const ships = shipmentsDeparting(SEED, DEV, START, START + 20 * DAY_MS);
    for (let d = 3; d < 15; d++) {
      const from = START + d * DAY_MS;
      expect(ships.some((p) => p.etd >= from && p.etd < from + DAY_MS)).toBe(true);
      expect(ships.some((p) => p.eta >= from && p.eta < from + DAY_MS)).toBe(true);
    }
  });
  test.each([['Prod', PROD, 200], ['Dev', DEV, 15]] as const)('%s: a vessel is never on two voyages at once', (_n, s, days) => {
    const ships = shipmentsDeparting(SEED, s, START, START + days * DAY_MS);
    const byVessel = new Map<string, Array<[number, number]>>();
    for (const p of ships) {
      expect(p.vessel_id).toMatch(SIM_VESSEL_ID);
      const spans = byVessel.get(p.vessel_id) ?? [];
      spans.push([p.etd - DWELL_MS, p.eta + DWELL_MS]);
      byVessel.set(p.vessel_id, spans);
    }
    for (const spans of byVessel.values()) {
      spans.sort((a, b) => a[0] - b[0]);
      for (let i = 1; i < spans.length; i++) expect(spans[i]![0]).toBeGreaterThan(spans[i - 1]![1]);
    }
  });
  test('vessel names are unique fictional "Demo …" names', () => {
    expect(new Set(VESSEL_NAMES).size).toBe(VESSEL_NAMES.length);
    for (const n of VESSEL_NAMES) expect(n.startsWith('Demo ')).toBe(true);
  });
});

describe('bookings', () => {
  test.each([['Prod', PROD], ['Dev', DEV]] as const)('%s: every shipment is booked by an 08:05–19:05 Taipei run before its POL dwell starts', (_n, s) => {
    const booked = new Set<string>();
    for (let t = START; t < START + 40 * DAY_MS; t += HOUR_MS) {
      const taipeiHour = new Date(t + 8 * HOUR_MS).getUTCHours();
      if (taipeiHour < 8 || taipeiHour > 19) continue;
      const run = t + 5 * 60_000; // :05
      for (const p of bookingsDue(SEED, s, run)) {
        expect(run).toBeLessThan(p.etd - DWELL_MS);
        booked.add(p.idempotencyKey);
      }
    }
    const window = shipmentsDeparting(SEED, s, START + 3 * DAY_MS, START + 35 * DAY_MS);
    expect(window.length).toBeGreaterThan(0);
    for (const p of window) expect(booked.has(p.idempotencyKey)).toBe(true);
  });
  test('booking body is accepted by the API schema and the departure window', () => {
    const now = START + 10 * DAY_MS;
    const due = bookingsDue(SEED, PROD, now);
    expect(due.length).toBeGreaterThanOrEqual(0);
    for (const p of shipmentsDeparting(SEED, PROD, START + 5 * DAY_MS, START + 60 * DAY_MS)) {
      const b = bookingBody(p);
      expect(CreateShipmentRequestSchema.safeParse(b).success).toBe(true);
      // API：開航時刻在「昨天」到 120 天後之間（以訂艙時刻計）/ Departure within the API window at booking time.
      expect(p.etd - p.bookingOpensAt).toBeLessThan(120 * DAY_MS);
      expect(p.idempotencyKey).toMatch(/^simship-[0-9a-f]{32}$/);
    }
  });
});

describe('positions', () => {
  test.each([['Prod', PROD], ['Dev', DEV]] as const)('%s: dwell inside the POL geofence, leaves it after departure, moored at POD', (_n, s) => {
    for (const p of shipmentsDeparting(SEED, s, START + 5 * DAY_MS, START + 40 * DAY_MS)) {
      const route = sd.routes.get(p.route_id)!;
      const pol = portOf(route.pol.locode);
      const pod = portOf(route.pod.locode);
      // 開航前 12 小時：每 30 分都在 POL 15 km 內、航速 0 / Dwell: inside 15 km, speed 0.
      for (let t = p.etd - DWELL_MS; t <= p.etd; t += POSITION_INTERVAL_MS) {
        const r = positionAt(SEED, p, t)!;
        expect(distanceKm([r.lat, r.lon], pol)).toBeLessThan(15);
        expect(r.sog).toBe(0);
        expect(r.nav_status).toBe(5);
      }
      // 開航後 1.5 小時內離開 20 km（偵測器的 DEPA 會落在 ±1 小時內）/ Out of 20 km within 1.5 h.
      const firstOut = [1, 2, 3].map((i) => positionAt(SEED, p, p.etd + i * POSITION_INTERVAL_MS)!).find((r) => distanceKm([r.lat, r.lon], pol) > 20);
      expect(firstOut).toBeDefined();
      expect(firstOut!.nav_status).toBe(0);
      expect(firstOut!.sog).toBeGreaterThan(12);
      // 抵港後停泊 / Moored at POD after arrival.
      const after = positionAt(SEED, p, p.eta + POSITION_INTERVAL_MS)!;
      expect(distanceKm([after.lat, after.lon], pod)).toBeLessThan(15);
      expect(after.sog).toBe(0);
      expect(after.destination).toBe(route.pod.locode);
      expect(positionAt(SEED, p, p.eta + DWELL_MS + 1)).toBeUndefined();
      expect(positionAt(SEED, p, p.etd - DWELL_MS - 1)).toBeUndefined();
    }
  });
  test('a window is deterministic, sorted, every 30 minutes, synthetic, and carries no booking or container numbers', () => {
    const from = START + 10 * DAY_MS;
    const recs = positionsForWindow(SEED, DEV, from, from + POSITION_INTERVAL_MS);
    expect(recs.length).toBeGreaterThan(0);
    expect(positionsForWindow(SEED, DEV, from, from + POSITION_INTERVAL_MS)).toEqual(recs);
    expect(new Set(recs.map((r) => r.ts))).toEqual(new Set([new Date(from).toISOString().replace('.000Z', 'Z')]));
    const text = JSON.stringify(recs);
    expect(text).not.toMatch(/BLDEMO|DMQU/);
    for (const r of recs) expect(r.synthetic).toBe(true);
    const day = positionsForWindow(SEED, DEV, from, from + DAY_MS);
    const sorted = [...day].sort((a, b) => a.ts.localeCompare(b.ts) || a.vessel_id.localeCompare(b.vessel_id));
    expect(day).toEqual(sorted);
  });
  test('object key follows the E3 entry point', () => {
    expect(positionsKey(Date.parse('2026-11-25T03:30:00Z'))).toBe('raw/positions/source=sim/dt=2026-11-25/0330.jsonl.gz');
  });
});

describe('dry run (SIM-F-009)', () => {
  test('same date → same hash; different date → different hash', () => {
    const a = voyageDryRun(SEED, DEV, '2026-11-30');
    expect(voyageDryRun(SEED, DEV, '2026-11-30')).toEqual(a);
    expect(voyageDryRun(SEED, DEV, '2026-12-01').hash).not.toBe(a.hash);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.positions).toBeGreaterThan(0);
    expect(a.bookings.length).toBeGreaterThan(0);
    expect(() => voyageDryRun(SEED, DEV, '2026-13-01')).toThrow();
    expect(() => voyageDryRun(SEED, { timeScale: 0, startDate: '2026-11-22' }, '2026-11-30')).toThrow();
  });
});
