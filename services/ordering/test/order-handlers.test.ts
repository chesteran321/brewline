import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { handler as createOrder } from '../src/handlers/create-order';
import { handler as getOrder } from '../src/handlers/get-order';
import { handler as listOrders } from '../src/handlers/list-orders';
import type { CreateOrderInput, CreateOrderResult, OrderRepo } from '../src/lib/order-repo';
import type { OrderItem } from '../src/lib/order-model';
import { encodeCursor } from '../src/lib/order-model';
import { setOrderRepoForTesting } from '../src/lib/runtime';

const A = `t_${'A'.repeat(26)}`;
const ORDER_ID = `o_${'1'.repeat(26)}`;
const order: OrderItem = {
  pk: `TENANT#${A}`, sk: `ORDER#${'1'.repeat(26)}`, entity: 'Order', order_id: ORDER_ID, tenant_id: A, status: 'CREATED',
  payment_status: 'PAID_MOCK', items: [{ product_id: 'p-0001', name: 'x', qty_kg: 3, price_per_kg: 1000, line_total: 3000 }],
  total: 3000, currency: 'TWD', created_by: 'sub-1', created_at: '2026-11-13T04:00:00.000Z', idempotency_key: 'k'.repeat(16),
};

let nextResult: CreateOrderResult = { kind: 'created', order };
let nextError: Error | undefined;
const calls: CreateOrderInput[] = [];
const listCalls: Array<[string, number, string | undefined]> = [];
const fake = {
  createOrder: async (i: CreateOrderInput) => {
    calls.push(i);
    if (nextError) throw nextError;
    return nextResult;
  },
  getOrder: async (t: string, id: string) => (t === A && id === ORDER_ID ? order : undefined),
  listOrders: async (t: string, limit: number, after?: string) => {
    listCalls.push([t, limit, after]);
    return { orders: [order], lastSk: order.sk };
  },
} as unknown as OrderRepo;

interface Opts {
  scopes?: string[];
  tenant?: string | null;
  key?: string | null;
  body?: unknown;
  id?: string;
  query?: Record<string, string>;
}
function event(o: Opts = {}): APIGatewayProxyEventV2WithJWTAuthorizer {
  const scopes = o.scopes ?? ['brewline/orders.read', 'brewline/orders.write'];
  const claims: Record<string, string> = { sub: 'sub-1', scope: scopes.join(' ') };
  if (o.tenant !== null) claims.tenant_id = o.tenant ?? A;
  return {
    headers: o.key === null ? {} : { 'idempotency-key': o.key ?? 'key-0000000000000001' },
    body: o.body === undefined ? JSON.stringify({ items: [{ product_id: 'p-0001', qty_kg: 3 }] }) : typeof o.body === 'string' ? o.body : JSON.stringify(o.body),
    isBase64Encoded: false,
    pathParameters: o.id === undefined ? undefined : { id: o.id },
    queryStringParameters: o.query,
    requestContext: { authorizer: { jwt: { claims, scopes } } },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}
const parse = (r: { body?: string }) => JSON.parse(r.body ?? '{}');

beforeAll(() => setOrderRepoForTesting(fake));
afterAll(() => setOrderRepoForTesting(undefined));
beforeEach(() => {
  nextResult = { kind: 'created', order };
  nextError = undefined;
  calls.length = 0;
  listCalls.length = 0;
});

describe('POST /orders', () => {
  test('201 with the public DTO; tenant and sub come from the JWT, order id is a fresh ULID', async () => {
    const r = await createOrder(event());
    expect(r.statusCode).toBe(201);
    expect(parse(r)).toMatchObject({ order_id: ORDER_ID, total: 3000 });
    expect(parse(r)).not.toHaveProperty('tenant_id');
    expect(calls[0]).toMatchObject({ tenantId: A, createdBy: 'sub-1', idempotencyKey: 'key-0000000000000001' });
    expect(calls[0]!.orderId).toMatch(/^o_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  test.each([
    [{ kind: 'replayed', order }, 200, undefined],
    [{ kind: 'idempotency_mismatch' }, 422, 'idempotency_key_reused'],
    [{ kind: 'unknown_products', productIds: ['p-9999'] }, 400, 'unknown_products'],
    [{ kind: 'insufficient_stock', productIds: ['p-0001'] }, 409, 'insufficient_stock'],
    [{ kind: 'throttled' }, 503, 'try_again'],
    [{ kind: 'busy' }, 503, 'try_again'],
  ] as Array<[CreateOrderResult, number, string | undefined]>)('%o → %i', async (result, status, code) => {
    nextResult = result;
    const r = await createOrder(event());
    expect(r.statusCode).toBe(status);
    if (code) expect(parse(r).error.code).toBe(code);
  });

  // 反向 / Negative
  test('missing scope → 403 (staff)', async () => {
    expect((await createOrder(event({ scopes: ['brewline/catalog.read', 'brewline/admin'] }))).statusCode).toBe(403);
  });
  test('no or malformed tenant claim → 403, repo never called', async () => {
    expect((await createOrder(event({ tenant: null }))).statusCode).toBe(403);
    expect((await createOrder(event({ tenant: 't_1' }))).statusCode).toBe(403);
    expect(calls).toHaveLength(0);
  });
  test('missing or bad Idempotency-Key → 400', async () => {
    expect((await createOrder(event({ key: null }))).statusCode).toBe(400);
    expect((await createOrder(event({ key: 'short' }))).statusCode).toBe(400);
  });
  test.each([
    ['not JSON', '{'],
    ['qty 501', { items: [{ product_id: 'p-0001', qty_kg: 501 }] }],
    ['negative qty', { items: [{ product_id: 'p-0001', qty_kg: -1 }] }],
    ['client-supplied price', { items: [{ product_id: 'p-0001', qty_kg: 1, price_per_kg: 1 }] }],
    ['too large', { items: [{ product_id: 'p-0001', qty_kg: 1 }], pad: 'x'.repeat(20_000) }],
  ])('invalid body (%s) → 400 with limits, input not echoed', async (_n, body) => {
    const r = await createOrder(event({ body }));
    expect(r.statusCode).toBe(400);
    expect(parse(r).error.limits).toEqual({ max_lines: 25, min_qty_kg: 1, max_qty_kg: 500 });
    expect(r.body).not.toContain('xxxxxxxx');
    expect(calls).toHaveLength(0);
  });
  test('AccessDenied from DynamoDB (isolation bug) → 500, no details', async () => {
    nextError = Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
    const r = await createOrder(event());
    expect(r.statusCode).toBe(500);
    expect(r.body).not.toContain('denied');
  });
});

describe('GET /orders/{id}', () => {
  test('200 for own order', async () => {
    const r = await getOrder(event({ id: ORDER_ID }));
    expect(r.statusCode).toBe(200);
    expect(parse(r).order_id).toBe(ORDER_ID);
  });
  test('another tenant → 404 (not 403: existence is not revealed)', async () => {
    expect((await getOrder(event({ id: ORDER_ID, tenant: `t_${'B'.repeat(26)}` }))).statusCode).toBe(404);
  });
  test('bad id → 400; missing scope → 403', async () => {
    expect((await getOrder(event({ id: 'o_bad' }))).statusCode).toBe(400);
    expect((await getOrder(event({ id: ORDER_ID, scopes: ['brewline/catalog.read'] }))).statusCode).toBe(403);
  });
});

describe('GET /orders', () => {
  test('200 with items and next_token; default limit 20', async () => {
    const r = await listOrders(event());
    expect(r.statusCode).toBe(200);
    expect(parse(r).items).toHaveLength(1);
    expect(typeof parse(r).next_token).toBe('string');
    expect(listCalls[0]).toEqual([A, 20, undefined]);
  });
  test('passes a valid cursor; rejects tampered cursor, bad limit, unknown params', async () => {
    await listOrders(event({ query: { limit: '5', next_token: encodeCursor(order.sk) } }));
    expect(listCalls[0]).toEqual([A, 5, order.sk]);
    expect((await listOrders(event({ query: { next_token: 'garbage' } }))).statusCode).toBe(400);
    expect((await listOrders(event({ query: { limit: '51' } }))).statusCode).toBe(400);
    expect((await listOrders(event({ query: { tenant_id: 't_x' } }))).statusCode).toBe(400);
  });
  test('no tenant → 403', async () => {
    expect((await listOrders(event({ tenant: null }))).statusCode).toBe(403);
  });
});
