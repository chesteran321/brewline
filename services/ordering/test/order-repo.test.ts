import { DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { BatchGetCommand, DynamoDBDocumentClient, GetCommand, QueryCommand, ScanCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { OrderRepo } from '../src/lib/order-repo';
import { requestHash } from '../src/lib/order-model';

const ddb = mockClient(DynamoDBDocumentClient);
const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-east-2' }));
const tenantsSeen: string[] = [];
const repo = new OrderRepo((t) => (tenantsSeen.push(t), client), 'tbl', () => 0);

const A = `t_${'A'.repeat(26)}`;
const ORDER_ID = `o_${'1'.repeat(26)}`;
const KEY = 'key-0000000000000001';
const NOW = new Date('2026-11-13T04:00:00.000Z');
const NOW_SEC = Math.floor(NOW.getTime() / 1000);

const meta = (id: string, price = 1000, status = 'active') => ({
  pk: `PRODUCT#${id}`, sk: 'META', entity: 'Product', status, id, name: `Bean ${id}`, name_zh: id, origin_country: 'ET',
  region: 'Guji', process: 'natural', variety: 'X', altitude_m: 1, cup_score: 85, roast_level: 'light',
  flavor_notes: ['a'], price_per_kg: price, currency: 'TWD', lot_id: 'L-2026-001',
});
const request = { items: [{ product_id: 'p-0001', qty_kg: 3 }, { product_id: 'p-0002', qty_kg: 2 }] };
const input = { tenantId: A, createdBy: 'sub-1', idempotencyKey: KEY, request, orderId: ORDER_ID, now: NOW };
const orderRaw = {
  pk: `TENANT#${A}`, sk: `ORDER#${'1'.repeat(26)}`, entity: 'Order', order_id: ORDER_ID, tenant_id: A, status: 'CREATED',
  payment_status: 'PAID_MOCK', items: [{ product_id: 'p-0001', name: 'x', qty_kg: 3, price_per_kg: 1000, line_total: 3000 }],
  total: 3000, currency: 'TWD', created_by: 'sub-1', created_at: NOW.toISOString(), idempotency_key: KEY,
};
const cancel = (...codes: string[]) =>
  new TransactionCanceledException({ message: 'canceled', $metadata: {}, CancellationReasons: codes.map((Code) => ({ Code })) });

beforeEach(() => {
  ddb.reset();
  tenantsSeen.length = 0;
  ddb.on(BatchGetCommand).resolves({ Responses: { tbl: [meta('p-0001', 1000), meta('p-0002', 1500)] } });
  ddb.on(GetCommand).resolves({}); // 沒有冪等記錄 / no idempotency record
});

test('creates: one transaction = idempotency Put + order Put + one stock Update per line', async () => {
  ddb.on(TransactWriteCommand).resolves({});
  const r = await repo.createOrder(input);
  expect(r.kind).toBe('created');
  if (r.kind !== 'created') return;
  expect(r.order.total).toBe(3 * 1000 + 2 * 1500); // 伺服器端定價 / server-side pricing
  expect(r.order.payment_status).toBe('PAID_MOCK');

  const tx = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
  expect(tx).toHaveLength(4);
  expect(tx[0]!.Put).toMatchObject({
    Item: { pk: `TENANT#${A}`, sk: `IDEMP#${KEY}`, request_hash: requestHash(request), expires_at: NOW_SEC + 86400 },
    ConditionExpression: 'attribute_not_exists(pk) OR expires_at < :now',
  });
  expect(tx[1]!.Put).toMatchObject({
    Item: { pk: `TENANT#${A}`, sk: `ORDER#${'1'.repeat(26)}`, gsi1pk: 'STATUS#CREATED', gsi1sk: `${NOW.toISOString()}#${ORDER_ID}` },
    ConditionExpression: 'attribute_not_exists(pk)',
  });
  const upd = tx[2]!.Update!;
  expect(upd.Key).toEqual({ pk: 'PRODUCT#p-0001', sk: 'STOCK' });
  expect(upd.ConditionExpression).toBe('attribute_exists(#pk) AND #a >= :q');
  expect(upd.ExpressionAttributeValues).toMatchObject({ ':q': 3 });
  // IAM 只允許這些欄位（ADR-024）；不能出現 price 等 / IAM allows only these attributes.
  expect(Object.values(upd.ExpressionAttributeNames!).sort()).toEqual(['available_kg', 'pk', 'reserved_kg', 'updated_at', 'version']);
  expect(tx[3]!.Update!.Key).toEqual({ pk: 'PRODUCT#p-0002', sk: 'STOCK' });
  expect(tenantsSeen.every((t) => t === A)).toBe(true);
});

test('replay with the same body returns the original order without a new transaction', async () => {
  ddb.on(GetCommand, { Key: { pk: `TENANT#${A}`, sk: `IDEMP#${KEY}` } }).resolves({
    Item: { pk: `TENANT#${A}`, sk: `IDEMP#${KEY}`, request_hash: requestHash(request), order_id: ORDER_ID, expires_at: NOW_SEC + 10 },
  });
  ddb.on(GetCommand, { Key: { pk: `TENANT#${A}`, sk: `ORDER#${'1'.repeat(26)}` } }).resolves({ Item: orderRaw });
  const r = await repo.createOrder({ ...input, orderId: `o_${'2'.repeat(26)}` });
  expect(r).toMatchObject({ kind: 'replayed', order: { order_id: ORDER_ID } });
  expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
});

test('same key with a different body → idempotency_mismatch', async () => {
  ddb.on(GetCommand, { Key: { pk: `TENANT#${A}`, sk: `IDEMP#${KEY}` } }).resolves({
    Item: { pk: `TENANT#${A}`, sk: `IDEMP#${KEY}`, request_hash: 'other', order_id: ORDER_ID, expires_at: NOW_SEC + 10 },
  });
  expect(await repo.createOrder(input)).toEqual({ kind: 'idempotency_mismatch' });
});

test('an expired (not yet TTL-deleted) record is ignored', async () => {
  ddb.on(GetCommand, { Key: { pk: `TENANT#${A}`, sk: `IDEMP#${KEY}` } }).resolves({
    Item: { pk: `TENANT#${A}`, sk: `IDEMP#${KEY}`, request_hash: 'other', order_id: ORDER_ID, expires_at: NOW_SEC - 1 },
  });
  ddb.on(TransactWriteCommand).resolves({});
  expect((await repo.createOrder(input)).kind).toBe('created');
});

test('race: a concurrent request with the same key won → replay its order', async () => {
  ddb.on(TransactWriteCommand).rejects(cancel('ConditionalCheckFailed', 'None', 'None', 'None'));
  ddb
    .on(GetCommand, { Key: { pk: `TENANT#${A}`, sk: `IDEMP#${KEY}` } })
    .resolvesOnce({})
    .resolves({ Item: { pk: `TENANT#${A}`, sk: `IDEMP#${KEY}`, request_hash: requestHash(request), order_id: ORDER_ID, expires_at: NOW_SEC + 10 } });
  ddb.on(GetCommand, { Key: { pk: `TENANT#${A}`, sk: `ORDER#${'1'.repeat(26)}` } }).resolves({ Item: orderRaw });
  expect(await repo.createOrder({ ...input, orderId: `o_${'2'.repeat(26)}` })).toMatchObject({ kind: 'replayed' });
});

test('insufficient stock names the short products', async () => {
  ddb.on(TransactWriteCommand).rejects(cancel('None', 'None', 'None', 'ConditionalCheckFailed'));
  expect(await repo.createOrder(input)).toEqual({ kind: 'insufficient_stock', productIds: ['p-0002'] });
});

test('unknown or inactive products are rejected before any write', async () => {
  ddb.on(BatchGetCommand).resolves({ Responses: { tbl: [meta('p-0001'), meta('p-0002', 1, 'inactive')] } });
  expect(await repo.createOrder(input)).toEqual({ kind: 'unknown_products', productIds: ['p-0002'] });
  expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
});

test('TransactionConflict is retried, then gives up as busy', async () => {
  ddb.on(TransactWriteCommand).rejectsOnce(cancel('None', 'None', 'TransactionConflict', 'None')).resolves({});
  expect((await repo.createOrder(input)).kind).toBe('created');
  ddb.reset();
  ddb.on(BatchGetCommand).resolves({ Responses: { tbl: [meta('p-0001'), meta('p-0002')] } });
  ddb.on(GetCommand).resolves({});
  ddb.on(TransactWriteCommand).rejects(cancel('None', 'None', 'TransactionConflict', 'None'));
  expect(await repo.createOrder(input)).toEqual({ kind: 'busy' });
  expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(4);
});

test('throttling → throttled', async () => {
  ddb.on(TransactWriteCommand).rejects(cancel('None', 'ThrottlingError', 'None', 'None'));
  expect(await repo.createOrder(input)).toEqual({ kind: 'throttled' });
});

test('getOrder reads only TENANT#<own>/ORDER#<id>', async () => {
  ddb.on(GetCommand).resolves({ Item: orderRaw });
  expect((await repo.getOrder(A, ORDER_ID))?.order_id).toBe(ORDER_ID);
  expect(ddb.commandCalls(GetCommand)[0]!.args[0].input.Key).toEqual({ pk: `TENANT#${A}`, sk: `ORDER#${'1'.repeat(26)}` });
  // 縱深防禦：項目的 tenant_id 不符 → 當作不存在 / tenant mismatch in the item → treated as absent
  ddb.on(GetCommand).resolves({ Item: { ...orderRaw, tenant_id: `t_${'B'.repeat(26)}` } });
  expect(await repo.getOrder(A, ORDER_ID)).toBeUndefined();
});

test('listOrders queries own partition newest-first; cursor only sets sk', async () => {
  ddb.on(QueryCommand).resolves({ Items: [orderRaw, { pk: 'junk' }], LastEvaluatedKey: { pk: `TENANT#${A}`, sk: orderRaw.sk } });
  const page = await repo.listOrders(A, 20, 'ORDER#0000000000000000000000000Z');
  expect(page.orders).toHaveLength(1);
  expect(page.lastSk).toBe(orderRaw.sk);
  expect(ddb.commandCalls(QueryCommand)[0]!.args[0].input).toMatchObject({
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: { ':pk': `TENANT#${A}`, ':prefix': 'ORDER#' },
    ScanIndexForward: false,
    Limit: 20,
    ExclusiveStartKey: { pk: `TENANT#${A}`, sk: 'ORDER#0000000000000000000000000Z' },
  });
  expect(ddb.commandCalls(ScanCommand)).toHaveLength(0);
});
