import {
  AdminOrderView,
  ApiResponse,
  MAX_ALLOCATIONS,
  MAX_BATCH_KG,
  ROASTERY_PACE_MS,
  Roastery,
  addDays,
  batchKey,
  dueForCompletion,
  planBatches,
  restockKg,
  shouldConfirm,
  stepsForHour,
} from '../src/roastery';

const T = 't_01AAAAAAAAAAAAAAAAAAAAAAAA';
const order = (id: string, status: string, lines: Array<[string, number, number?, string[]?]>, history: Array<[string, string]> = []): AdminOrderView => ({
  order_id: id,
  tenant_id: T,
  status,
  synthetic: true,
  status_history: history.map(([to, at]) => ({ to, at })),
  allocations: lines.map(([product_id, qty_kg, allocated_kg = 0, roast_ids = []]) => ({ product_id, qty_kg, allocated_kg, roast_ids })),
});
const oid = (n: number) => `o_${String(n).padStart(26, '0')}`;

describe('schedule by Taipei hour (D8)', () => {
  test.each([
    [8, ['confirm']],
    [9, ['confirm', 'roast']],
    [10, ['confirm', 'complete']],
    [14, ['confirm', 'ship']],
    [16, ['confirm', 'schedule', 'restock']],
    [19, ['confirm']],
  ])('%i:05 → %j', (hour, steps) => {
    expect(stepsForHour(hour)).toEqual(steps);
  });
});

describe('confirmation rate', () => {
  test('deterministic per order and close to 90% over many orders', () => {
    const ids = Array.from({ length: 2000 }, (_, i) => oid(i));
    expect(ids.map((i) => shouldConfirm(i))).toEqual(ids.map((i) => shouldConfirm(i)));
    const rate = ids.filter((i) => shouldConfirm(i)).length / ids.length;
    expect(rate).toBeGreaterThan(0.87);
    expect(rate).toBeLessThan(0.93);
  });
});

describe('planBatches (≤ 15 kg, ≤ 15 orders, an order once per batch)', () => {
  test('packs remaining kilograms per product; already allocated kilograms are skipped', () => {
    const b = planBatches([
      order(oid(2), 'ROASTING_SCHEDULED', [['p-0001', 5], ['p-0002', 3, 3]]),
      order(oid(1), 'ROASTING_SCHEDULED', [['p-0001', 4, 1]]),
    ]);
    expect(b).toEqual([{ product_id: 'p-0001', kg: 8, allocations: [{ tenant_id: T, order_id: oid(1), kg: 3 }, { tenant_id: T, order_id: oid(2), kg: 5 }] }]);
  });

  test('splits into several batches without exceeding limits; totals are preserved', () => {
    const orders = Array.from({ length: 40 }, (_, i) => order(oid(i), 'ROASTING_SCHEDULED', [['p-0004', 1 + (i % 5)]]));
    const b = planBatches(orders);
    for (const x of b) {
      expect(x.kg).toBeLessThanOrEqual(MAX_BATCH_KG);
      expect(x.allocations.length).toBeLessThanOrEqual(MAX_ALLOCATIONS);
      expect(x.allocations.reduce((s, a) => s + a.kg, 0)).toBe(x.kg);
      expect(new Set(x.allocations.map((a) => a.order_id)).size).toBe(x.allocations.length);
    }
    const total = (xs: { kg: number }[]) => xs.reduce((s, a) => s + a.kg, 0);
    expect(total(b)).toBe(orders.reduce((s, o) => s + o.allocations[0]!.qty_kg, 0));
  });

  test('a line larger than the space left is split across batches (never twice in one batch)', () => {
    const b = planBatches([order(oid(1), 'ROASTING_SCHEDULED', [['p-0001', 12]]), order(oid(2), 'ROASTING_SCHEDULED', [['p-0001', 7]])]);
    expect(b.map((x) => x.allocations.map((a) => [a.order_id, a.kg]))).toEqual([[[oid(1), 12], [oid(2), 3]], [[oid(2), 4]]]);
  });

  test('same input → same batches and keys (re-runs replay instead of creating twins)', () => {
    const orders = [order(oid(3), 'ROASTING_SCHEDULED', [['p-0001', 5]]), order(oid(1), 'ROASTING_SCHEDULED', [['p-0001', 2]])];
    const a = planBatches(orders);
    const b = planBatches([...orders].reverse());
    expect(a).toEqual(b);
    expect(batchKey('2026-11-20', a[0]!)).toBe(batchKey('2026-11-20', b[0]!));
    expect(batchKey('2026-11-20', a[0]!)).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    // 反向：日期或內容不同 → 不同的 key / Negative: another date or content → another key.
    expect(batchKey('2026-11-21', a[0]!)).not.toBe(batchKey('2026-11-20', a[0]!));
    expect(batchKey('2026-11-20', { ...a[0]!, kg: a[0]!.kg - 1 })).not.toBe(batchKey('2026-11-20', a[0]!));
  });
});

describe('completion and restock rules', () => {
  test('complete two Taipei calendar days after shipping', () => {
    // 2026-11-19 23:30 台北出貨 = 15:30Z / shipped 23:30 Taipei
    const o = order(oid(1), 'SHIPPED', [['p-0001', 1]], [['SHIPPED', '2026-11-19T15:30:00Z']]);
    expect(dueForCompletion(o, '2026-11-20')).toBe(false);
    expect(dueForCompletion(o, '2026-11-21')).toBe(true);
    expect(dueForCompletion(order(oid(2), 'SHIPPED', [['p-0001', 1]]), '2030-01-01')).toBe(false); // 沒有出貨紀錄 / no history
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  test('restock to the initial level only when low or out; capped; unknown products never', () => {
    expect(restockKg({ product_id: 'p-0001', available_kg: 20, low_threshold_kg: 20, version: 1 })).toBe(100); // 120 − 20
    expect(restockKg({ product_id: 'p-0001', available_kg: 21, low_threshold_kg: 20, version: 1 })).toBe(0);
    expect(restockKg({ product_id: 'p-0005', available_kg: 0, low_threshold_kg: 50, version: 1 })).toBe(250);
    expect(restockKg({ product_id: 'p-9002', available_kg: 0, low_threshold_kg: 5, version: 1 })).toBe(0); // 測試商品 / test product
  });
});

describe('Roastery steps against a fake API', () => {
  type Call = { path: string; method: string; key?: string; body?: any };
  let calls: Call[];
  let sleeps: number[];
  const make = (respond: (c: Call) => ApiResponse) => {
    calls = [];
    sleeps = [];
    return new Roastery(
      async (path, init = {}) => {
        const c = { path, method: init.method ?? 'GET', key: init.key, body: init.body };
        calls.push(c);
        return respond(c);
      },
      async (ms) => { sleeps.push(ms); },
      '2026-11-19',
    );
  };
  const list = (items: AdminOrderView[], next?: string): ApiResponse => ({ status: 200, body: { items, ...(next ? { next_token: next } : {}) } });

  test('confirm: only the 90% picked by hash; 409 invalid_transition counts as already done', async () => {
    const created = Array.from({ length: 30 }, (_, i) => order(oid(i), 'CREATED', [['p-0001', 1]]));
    const picked = created.filter((o) => shouldConfirm(o.order_id));
    const r = make((c) => (c.method === 'GET' ? list(created) : c.path.includes(picked[0]!.order_id) ? { status: 409, body: { error: { code: 'invalid_transition' } } } : { status: 200, body: {} }));
    const s = await r.run('confirm');
    expect(s.violations).toEqual([]);
    expect(s.counts).toMatchObject({ seen: 30, left_for_timeout: 30 - picked.length, advanced: picked.length - 1, already: 1 });
    expect(calls.filter((c) => c.method === 'PATCH').every((c) => c.body.status === 'CONFIRMED')).toBe(true);
    expect(sleeps.every((ms) => ms === ROASTERY_PACE_MS)).toBe(true);
  });

  test('list follows next_token and ignores real orders even if the API returned some', async () => {
    const real = { ...order(oid(99), 'CREATED', [['p-0001', 1]]), synthetic: false };
    const r = make((c) => (c.path.includes('next_token=page2') ? list([order(oid(2), 'CREATED', [['p-0001', 1]])]) : list([order(oid(1), 'CREATED', [['p-0001', 1]]), real], 'page2')));
    const v: string[] = [];
    expect((await r.list('CREATED', v)).map((o) => o.order_id)).toEqual([oid(1), oid(2)]);
  });

  test('schedule: CONFIRMED → ROASTING_SCHEDULED, then batches dated tomorrow with content keys', async () => {
    const confirmed = [order(oid(1), 'CONFIRMED', [['p-0001', 4]]), order(oid(2), 'CONFIRMED', [['p-0002', 2]])];
    const scheduled = confirmed.map((o) => ({ ...o, status: 'ROASTING_SCHEDULED' }));
    const r = make((c) => {
      if (c.method === 'GET') return list(c.path.includes('CONFIRMED') ? confirmed : scheduled);
      if (c.path === '/admin/roasts') return { status: 201, body: {} };
      return { status: 200, body: {} };
    });
    const s = await r.run('schedule');
    expect(s.violations).toEqual([]);
    expect(s.counts).toMatchObject({ advanced: 2, batches_planned: 2, batches_created: 2 });
    const posts = calls.filter((c) => c.path === '/admin/roasts');
    expect(posts.map((p) => p.body.roast_date)).toEqual(['2026-11-20', '2026-11-20']);
    expect(posts.every((p) => /^simroast-[0-9a-f]{40}$/.test(p.key!))).toBe(true);
    expect(posts[0]!.body).toMatchObject({ product_id: 'p-0001', kg: 4, allocations: [{ tenant_id: T, order_id: oid(1), kg: 4 }] });
  });

  test('schedule re-run: 200 replay is fine; 409 over_allocated is a violation', async () => {
    const scheduled = [order(oid(1), 'ROASTING_SCHEDULED', [['p-0001', 4]])];
    let r = make((c) => (c.method === 'GET' ? list(c.path.includes('CONFIRMED') ? [] : scheduled) : { status: 200, body: {} }));
    expect((await r.run('schedule')).counts).toMatchObject({ batches_replayed: 1 });
    r = make((c) => (c.method === 'GET' ? list(c.path.includes('CONFIRMED') ? [] : scheduled) : { status: 409, body: { error: { code: 'over_allocated' } } }));
    expect((await r.run('schedule')).violations).toEqual(['roast p-0001 4 kg → 409 over_allocated']);
  });

  test('roast: every referenced batch → ROASTED (409 invalid_state = already), then only fully allocated orders', async () => {
    const full = order(oid(1), 'ROASTING_SCHEDULED', [['p-0001', 4, 4, ['r_A', 'r_B']]]);
    const partial = order(oid(2), 'ROASTING_SCHEDULED', [['p-0001', 4, 2, ['r_B']]]);
    const r = make((c) => {
      if (c.method === 'GET') return list([full, partial]);
      if (c.path === '/admin/roasts/r_A') return { status: 409, body: { error: { code: 'invalid_state' } } };
      return { status: 200, body: {} };
    });
    const s = await r.run('roast');
    expect(s.violations).toEqual([]);
    expect(s.counts).toMatchObject({ batches_roasted: 1, batches_already: 1, not_fully_allocated: 1, advanced: 1 });
    expect(calls.filter((c) => c.method === 'PATCH' && c.path.includes('/orders/')).map((c) => c.path)).toEqual([`/admin/tenants/${T}/orders/${oid(1)}`]);
  });

  test('ship and complete', async () => {
    let r = make((c) => (c.method === 'GET' ? list([order(oid(1), 'ROASTED', [['p-0001', 1]])]) : { status: 200, body: {} }));
    expect((await r.run('ship')).counts).toMatchObject({ advanced: 1 });
    expect(calls[1]!.body).toEqual({ status: 'SHIPPED' });
    const old = order(oid(1), 'SHIPPED', [['p-0001', 1]], [['SHIPPED', '2026-11-16T03:00:00Z']]);
    const fresh = order(oid(2), 'SHIPPED', [['p-0001', 1]], [['SHIPPED', '2026-11-19T03:00:00Z']]);
    r = make((c) => (c.method === 'GET' ? list([old, fresh]) : { status: 200, body: {} }));
    expect((await r.run('complete')).counts).toMatchObject({ advanced: 1, not_due: 1 });
  });

  test('restock: only low products, with the read version; a version conflict re-reads once', async () => {
    let reads = 0;
    const r = make((c) => {
      if (c.path === '/admin/products/p-0001/stock') {
        reads++;
        return { status: 200, body: { product_id: 'p-0001', available_kg: 10, low_threshold_kg: 20, version: reads } };
      }
      if (c.path.endsWith('/stock')) return { status: 200, body: { product_id: c.path.split('/')[3], available_kg: 999, low_threshold_kg: 1, version: 1 } };
      if (c.path === '/admin/products/p-0001/restock') return c.body.expected_version === 1 ? { status: 409, body: { error: { code: 'version_conflict' } } } : { status: 200, body: {} };
      return { status: 500, body: undefined };
    });
    const s = await r.run('restock');
    expect(s.violations).toEqual([]);
    expect(s.counts).toMatchObject({ restocked: 1, restocked_kg: 110 });
    expect(calls.filter((c) => c.path.endsWith('/restock')).map((c) => c.body)).toEqual([{ kg: 110, expected_version: 1 }, { kg: 110, expected_version: 2 }]);
  });

  test('503 is retried once; other failures are violations', async () => {
    let n = 0;
    const r = make((c) => (c.method === 'GET' ? list([order(oid(1), 'ROASTED', [['p-0001', 1]])]) : ++n === 1 ? { status: 503, body: undefined } : { status: 200, body: {} }));
    expect((await r.run('ship')).violations).toEqual([]);
    const bad = make((c) => (c.method === 'GET' ? { status: 403, body: undefined } : { status: 200, body: undefined }));
    expect((await bad.run('ship')).violations).toEqual(['list ROASTED → 403']);
  });
});
