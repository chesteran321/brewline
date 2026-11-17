import { IdempotencyKeySchema } from '../../ordering/src/lib/order-model';
import { SimulatorConfig } from '../src/config';
import {
  HOURS, activeTenants, dailyCount, hourlyCounts, idempotencyKey, planDay, planHash, planHour, taipeiNow,
} from '../src/generator';

const CFG: SimulatorConfig = {
  poolSize: 40, initialActive: 30, ordersPerDay: { min: 5, max: 40 }, linesPerOrder: { min: 1, max: 3 },
  kgPerLine: { min: 1, max: 5 }, duplicateOrderRate: 0.02, seed: 'test-seed', activationStartMonth: '2026-11',
};
const PRODUCTS = ['p-0001', 'p-0002', 'p-0003', 'p-0004', 'p-0005', 'p-0006', 'p-0007', 'p-0008'];

function days(from: string, n: number): string[] {
  const d0 = new Date(`${from}T00:00:00Z`).getTime();
  return Array.from({ length: n }, (_, i) => new Date(d0 + i * 86_400_000).toISOString().slice(0, 10));
}
const year = days('2027-01-01', 365);

describe('reproducibility (SIM-F-009)', () => {
  test('same seed + date → identical plan and hash; another seed → different', () => {
    expect(planDay(CFG, '2027-03-15', PRODUCTS)).toEqual(planDay(CFG, '2027-03-15', PRODUCTS));
    expect(planHash(planDay(CFG, '2027-03-15', PRODUCTS))).toBe(planHash(planDay(CFG, '2027-03-15', PRODUCTS)));
    expect(planHash(planDay({ ...CFG, seed: 'other' }, '2027-03-15', PRODUCTS))).not.toBe(planHash(planDay(CFG, '2027-03-15', PRODUCTS)));
  });

  test('catalog order does not matter', () => {
    expect(planDay(CFG, '2027-03-15', [...PRODUCTS].reverse())).toEqual(planDay(CFG, '2027-03-15', PRODUCTS));
  });

  test('a single hour equals that hour’s slice of the day plan (re-running an hour replays it)', () => {
    const day = planDay(CFG, '2027-03-15', PRODUCTS);
    for (const h of HOURS) expect(planHour(CFG, '2027-03-15', h, PRODUCTS)).toEqual(day.filter((o) => o.hour === h));
  });
});

describe('volume and shape (D4, SIM-F-003)', () => {
  test('every day stays within the configured range; hourly counts sum to the day', () => {
    for (const d of year) {
      const n = dailyCount(CFG, d);
      expect(n).toBeGreaterThanOrEqual(5);
      expect(n).toBeLessThanOrEqual(40);
      expect(hourlyCounts(CFG, d).reduce((a, b) => a + b, 0)).toBe(n);
    }
  });

  test('weekday effect: Mondays order more than Sundays; season: December more than July', () => {
    const avg = (pred: (d: string) => boolean) => {
      const sel = year.filter(pred);
      return sel.reduce((a, d) => a + dailyCount(CFG, d), 0) / sel.length;
    };
    const dow = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
    expect(avg((d) => dow(d) === 1)).toBeGreaterThan(avg((d) => dow(d) === 0) * 2);
    expect(avg((d) => d.slice(5, 7) === '12')).toBeGreaterThan(avg((d) => d.slice(5, 7) === '07'));
  });

  test('morning peak: 10:00 gets more orders than 19:00 over a year', () => {
    const totals = HOURS.map(() => 0);
    for (const d of year) hourlyCounts(CFG, d).forEach((c, i) => (totals[i]! += c));
    expect(totals[HOURS.indexOf(10)]!).toBeGreaterThan(totals[HOURS.indexOf(19)]! * 5);
  });

  test('orders: 1–3 distinct products, 1–5 kg each, valid keys, active tenants only', () => {
    for (const d of year.slice(0, 60)) {
      const active = activeTenants(CFG, d);
      for (const o of planDay(CFG, d, PRODUCTS)) {
        expect(o.items.length).toBeGreaterThanOrEqual(1);
        expect(o.items.length).toBeLessThanOrEqual(3);
        expect(new Set(o.items.map((i) => i.product_id)).size).toBe(o.items.length);
        for (const i of o.items) expect(i.qty_kg >= 1 && i.qty_kg <= 5 && Number.isInteger(i.qty_kg)).toBe(true);
        expect(IdempotencyKeySchema.safeParse(o.idempotencyKey).success).toBe(true);
        expect(o.tenantIndex >= 1 && o.tenantIndex <= active).toBe(true);
      }
    }
  });

  test('keys are unique across a year', () => {
    const keys = year.flatMap((d) => planDay(CFG, d, PRODUCTS).map((o) => o.idempotencyKey));
    expect(new Set(keys).size).toBe(keys.length);
    expect(idempotencyKey('s', '2027-01-01', 9, 0)).toMatch(/^sim-[0-9a-f]{32}$/);
  });

  test('duplicate injection rate is near the configured 2% (SIM-F-008)', () => {
    const all = year.flatMap((d) => planDay(CFG, d, PRODUCTS));
    const rate = all.filter((o) => o.duplicate).length / all.length;
    expect(rate).toBeGreaterThan(0.005);
    expect(rate).toBeLessThan(0.04);
  });

  test('outside 08–19 there is nothing to do', () => {
    expect(planHour(CFG, '2027-03-15', 7, PRODUCTS)).toEqual([]);
    expect(planHour(CFG, '2027-03-15', 20, PRODUCTS)).toEqual([]);
  });

  test.each(['2027-02-30', '2027/03/01', 'x'])('rejects invalid date %p', (d) => expect(() => dailyCount(CFG, d)).toThrow());
});

describe('tenant activation (SIM-F-001)', () => {
  test('starts at initialActive, grows 1–2 per month, capped at the pool', () => {
    expect(activeTenants(CFG, '2026-11-20')).toBe(30);
    const dec = activeTenants(CFG, '2026-12-01');
    expect(dec - 30).toBeGreaterThanOrEqual(1);
    expect(dec - 30).toBeLessThanOrEqual(2);
    expect(activeTenants(CFG, '2026-12-31')).toBe(dec);
    expect(activeTenants(CFG, '2030-01-01')).toBe(40);
  });
});

test('taipeiNow converts UTC to Asia/Taipei', () => {
  expect(taipeiNow(new Date('2026-11-17T23:30:00Z'))).toEqual({ date: '2026-11-18', hour: 7 });
  expect(taipeiNow(new Date('2026-11-18T01:05:00Z'))).toEqual({ date: '2026-11-18', hour: 9 });
});
