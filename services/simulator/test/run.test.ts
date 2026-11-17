import { AdminInitiateAuthCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { mockClient } from 'aws-sdk-client-mock';
import { SimulatorConfig } from '../src/config';
import { HOURS, planDay, planHour } from '../src/generator';
import { PACE_MS, SEED_PRODUCT_IDS, handler, setDepsForTesting } from '../src/run';
import { simUsers } from '../src/tenants';

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
const creds = Object.fromEntries(simUsers('x', 40).map((u) => [u.username, `Pw-${u.index}-123456!`]));

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
      method: init.method ?? 'GET', path: url.pathname, key: headers['idempotency-key'],
      token: headers.authorization!.replace('Bearer ', ''), body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    reqs.push(req);
    if (req.path === '/products') {
      const items = SEED_PRODUCT_IDS.map((id) => ({ id, stock_status: catalogStatus[id] ?? 'in_stock' }));
      return new Response(JSON.stringify({ items }), { status: 200 });
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
  expect(sleeps.length).toBe(orderReqs().length - 1);
  expect(sleeps.every((ms) => ms >= PACE_MS)).toBe(true);
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

test('negative: invalid config → throws before signing in', async () => {
  state('running');
  ssm.on(GetParameterCommand, { Name: '/c' }).resolves({ Parameter: { Value: JSON.stringify({ ...CONFIG, extra: 1 }) } });
  await expect(handler({})).rejects.toThrow();
  expect(cog.commandCalls(AdminInitiateAuthCommand)).toHaveLength(0);
});
