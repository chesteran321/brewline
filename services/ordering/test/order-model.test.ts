import { ulid, ULID_PATTERN } from '../src/lib/ulid';
import {
  CreateOrderRequestSchema,
  IdempotencyKeySchema,
  MAX_LINES,
  OrderIdSchema,
  decodeCursor,
  encodeCursor,
  orderIdFromSk,
  orderSk,
  requestHash,
  toPublicOrder,
} from '../src/lib/order-model';

describe('ulid', () => {
  test('26 Crockford characters, time-ordered', () => {
    const a = ulid(1_000, Buffer.alloc(10, 0xff));
    const b = ulid(2_000, Buffer.alloc(10, 0));
    expect(a).toMatch(ULID_PATTERN);
    expect(b).toMatch(ULID_PATTERN);
    expect(a < b).toBe(true); // 時間較早排前面，與亂數無關 / earlier time sorts first regardless of randomness
    expect(ulid(0, Buffer.alloc(10, 0))).toBe('0'.repeat(26));
  });
  test('rejects bad input', () => {
    expect(() => ulid(-1)).toThrow();
    expect(() => ulid(1, Buffer.alloc(9))).toThrow();
  });
});

describe('CreateOrderRequestSchema', () => {
  const line = (n: number, qty = 1) => ({ product_id: `p-${String(n).padStart(4, '0')}`, qty_kg: qty });
  test('accepts 1..25 lines with 1..500 kg', () => {
    expect(CreateOrderRequestSchema.safeParse({ items: [line(1, 1)] }).success).toBe(true);
    expect(CreateOrderRequestSchema.safeParse({ items: Array.from({ length: MAX_LINES }, (_, i) => line(i + 1, 500)) }).success).toBe(true);
  });
  test.each([
    ['no items', { items: [] }],
    ['26 lines', { items: Array.from({ length: 26 }, (_, i) => line(i + 1)) }],
    ['qty 0', { items: [line(1, 0)] }],
    ['negative qty (would increase stock)', { items: [line(1, -5)] }],
    ['qty 501', { items: [line(1, 501)] }],
    ['fractional qty', { items: [line(1, 1.5)] }],
    ['duplicate product', { items: [line(1), line(1)] }],
    ['bad product id', { items: [{ product_id: 'DROP', qty_kg: 1 }] }],
    ['extra field (price from client)', { items: [{ ...line(1), price_per_kg: 1 }] }],
    ['extra top-level field', { items: [line(1)], tenant_id: 't_x' }],
    ['not an object', 'x'],
  ])('rejects %s', (_name, body) => {
    expect(CreateOrderRequestSchema.safeParse(body).success).toBe(false);
  });
});

test('requestHash ignores line order but not quantities', () => {
  const a = { items: [{ product_id: 'p-0001', qty_kg: 1 }, { product_id: 'p-0002', qty_kg: 2 }] };
  const b = { items: [{ product_id: 'p-0002', qty_kg: 2 }, { product_id: 'p-0001', qty_kg: 1 }] };
  const c = { items: [{ product_id: 'p-0001', qty_kg: 1 }, { product_id: 'p-0002', qty_kg: 3 }] };
  expect(requestHash(a)).toBe(requestHash(b));
  expect(requestHash(a)).not.toBe(requestHash(c));
});

test('idempotency key and order id formats', () => {
  expect(IdempotencyKeySchema.safeParse('550e8400-e29b-41d4-a716-446655440000').success).toBe(true);
  expect(IdempotencyKeySchema.safeParse('short').success).toBe(false);
  expect(IdempotencyKeySchema.safeParse('x'.repeat(65)).success).toBe(false);
  expect(IdempotencyKeySchema.safeParse('has space in it 1234').success).toBe(false);
  const id = `o_${ulid()}`;
  expect(OrderIdSchema.safeParse(id).success).toBe(true);
  expect(orderIdFromSk(orderSk(id))).toBe(id);
  expect(OrderIdSchema.safeParse('o_short').success).toBe(false);
});

test('cursor round-trips and rejects tampering', () => {
  const sk = `ORDER#${ulid()}`;
  expect(decodeCursor(encodeCursor(sk))).toBe(sk);
  expect(decodeCursor('not-base64-json')).toBeUndefined();
  // 想把游標指到別的實體 / point the cursor at another entity
  expect(decodeCursor(Buffer.from(JSON.stringify({ sk: 'IDEMP#x' })).toString('base64url'))).toBeUndefined();
  expect(decodeCursor(Buffer.from(JSON.stringify({ sk, pk: 'TENANT#other' })).toString('base64url'))).toBeUndefined();
});

test('public order DTO is an allow-list', () => {
  const dto = toPublicOrder({
    pk: 'TENANT#t', sk: 'ORDER#x', entity: 'Order', order_id: `o_${'0'.repeat(26)}`, tenant_id: `t_${'0'.repeat(26)}`,
    status: 'CREATED', payment_status: 'PAID_MOCK',
    items: [{ product_id: 'p-0001', name: 'A', qty_kg: 1, price_per_kg: 10, line_total: 10 }],
    total: 10, currency: 'TWD', created_by: 'sub-123', created_at: '2026-11-13T00:00:00.000Z', idempotency_key: 'k'.repeat(16),
  });
  for (const f of ['pk', 'sk', 'entity', 'tenant_id', 'created_by', 'idempotency_key', 'gsi1pk']) expect(dto).not.toHaveProperty(f);
  expect(dto).toMatchObject({ status: 'CREATED', payment_status: 'PAID_MOCK', total: 10 });
});
