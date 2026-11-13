import { DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { getHandler, listHandler, patchHandler } from '../src/handlers/admin-orders';
import { AdminOrderRepo } from '../src/lib/admin-order-repo';
import { TRANSITIONS, canTransition, stockEffect } from '../src/lib/order-lifecycle';
import { ORDER_STATUSES, decodeAdminCursor, encodeAdminCursor, toPublicOrder } from '../src/lib/order-model';
import { setAdminOrderRepoForTesting } from '../src/lib/runtime';

const T = 't_01AAAAAAAAAAAAAAAAAAAAAAAA';
const OID = `o_${'1'.repeat(26)}`;
const order = (status: string, extra: object = {}) => ({
  pk: `TENANT#${T}`, sk: `ORDER#${'1'.repeat(26)}`, entity: 'Order', order_id: OID, tenant_id: T, status,
  payment_status: 'PAID_MOCK', total: 500, currency: 'TWD', created_by: 'sub-cafe', created_at: '2026-11-13T00:00:00.000Z',
  idempotency_key: 'k'.repeat(16),
  items: [
    { product_id: 'p-0001', name: 'A', qty_kg: 3, price_per_kg: 100, line_total: 300 },
    { product_id: 'p-0002', name: 'B', qty_kg: 2, price_per_kg: 100, line_total: 200 },
  ],
  ...extra,
});

describe('state machine', () => {
  test('happy path is a chain; terminal states have no exits', () => {
    const chain = ['CREATED', 'CONFIRMED', 'ROASTING_SCHEDULED', 'ROASTED', 'SHIPPED', 'COMPLETED'] as const;
    for (let i = 0; i < chain.length - 1; i++) expect(canTransition(chain[i]!, chain[i + 1]!)).toBe(true);
    expect(TRANSITIONS.COMPLETED).toEqual([]);
    expect(TRANSITIONS.CANCELLED).toEqual([]);
  });
  test('cancel only before roasting is scheduled', () => {
    expect(canTransition('CREATED', 'CANCELLED')).toBe(true);
    expect(canTransition('CONFIRMED', 'CANCELLED')).toBe(true);
    for (const s of ['ROASTING_SCHEDULED', 'ROASTED', 'SHIPPED', 'COMPLETED', 'CANCELLED'] as const) expect(canTransition(s, 'CANCELLED')).toBe(false);
  });
  test('no skipping, no going back, no self transitions', () => {
    expect(canTransition('CREATED', 'SHIPPED')).toBe(false);
    expect(canTransition('SHIPPED', 'CREATED')).toBe(false);
    for (const s of ORDER_STATUSES) expect(canTransition(s, s)).toBe(false);
  });
  test('stock effects', () => {
    expect(stockEffect('SHIPPED')).toBe('consume');
    expect(stockEffect('CANCELLED')).toBe('release');
    expect(stockEffect('CONFIRMED')).toBe('none');
  });
});

describe('AdminOrderRepo.transition', () => {
  const ddb = mockClient(DynamoDBDocumentClient);
  const repo = new AdminOrderRepo(DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-east-2' })), 'tbl', 'gsi1');
  const now = new Date('2026-11-13T05:00:00.000Z');
  beforeEach(() => ddb.reset());

  test('CREATED → CONFIRMED: only the order changes, status history + GSI1 move, conditioned on the old status', async () => {
    ddb.on(GetCommand).resolves({ Item: order('CREATED') });
    ddb.on(TransactWriteCommand).resolves({});
    const r = await repo.transition({ tenantId: T, orderId: OID, to: 'CONFIRMED', actor: 'staff:s1', now });
    expect(r).toMatchObject({ kind: 'updated', order: { status: 'CONFIRMED', status_history: [{ from: 'CREATED', to: 'CONFIRMED', by: 'staff:s1' }] } });
    const tx = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    expect(tx).toHaveLength(1);
    expect(tx[0]!.Update).toMatchObject({
      ConditionExpression: '#s = :from',
      ExpressionAttributeValues: expect.objectContaining({ ':from': 'CREATED', ':to': 'CONFIRMED', ':g': 'STATUS#CONFIRMED' }),
    });
    expect(ddb.commandCalls(GetCommand)[0]!.args[0].input.ConsistentRead).toBe(true);
  });

  test('→ CANCELLED releases every line: reserved -= q, available += q, reserved must cover q', async () => {
    ddb.on(GetCommand).resolves({ Item: order('CONFIRMED') });
    ddb.on(TransactWriteCommand).resolves({});
    await repo.transition({ tenantId: T, orderId: OID, to: 'CANCELLED', actor: 'system:timeout', now });
    const tx = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    expect(tx).toHaveLength(3);
    expect(tx[1]!.Update).toMatchObject({
      Key: { pk: 'PRODUCT#p-0001', sk: 'STOCK' },
      UpdateExpression: 'SET #r = #r - :q, #a = #a + :q, #v = #v + :one, #u = :ts',
      ConditionExpression: 'attribute_exists(#pk) AND #r >= :q',
      ExpressionAttributeValues: expect.objectContaining({ ':q': 3 }),
    });
    // 只動庫存欄位（IAM dynamodb:Attributes）/ Stock attributes only.
    expect(Object.values(tx[1]!.Update!.ExpressionAttributeNames!).sort()).toEqual(['available_kg', 'pk', 'reserved_kg', 'updated_at', 'version']);
  });

  test('→ SHIPPED consumes the reservation (available unchanged)', async () => {
    ddb.on(GetCommand).resolves({ Item: order('ROASTED') });
    ddb.on(TransactWriteCommand).resolves({});
    await repo.transition({ tenantId: T, orderId: OID, to: 'SHIPPED', actor: 'staff:s1', now });
    const upd = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems![2]!.Update!;
    expect(upd.UpdateExpression).toBe('SET #r = #r - :q, #v = #v + :one, #u = :ts');
    expect(upd.ExpressionAttributeNames).not.toHaveProperty('#a');
  });

  // 反向 / Negative
  test('invalid transitions never write', async () => {
    ddb.on(GetCommand).resolves({ Item: order('SHIPPED') });
    expect(await repo.transition({ tenantId: T, orderId: OID, to: 'CANCELLED', actor: 'staff:s1', now })).toEqual({ kind: 'invalid_transition', current: 'SHIPPED' });
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
  test('onlyFrom guard (timeout must not cancel a confirmed order)', async () => {
    ddb.on(GetCommand).resolves({ Item: order('CONFIRMED') });
    expect(await repo.transition({ tenantId: T, orderId: OID, to: 'CANCELLED', actor: 'system:timeout', now, onlyFrom: ['CREATED'] })).toEqual({
      kind: 'invalid_transition',
      current: 'CONFIRMED',
    });
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
  test('missing order → not_found; status changed meanwhile → conflict; reserved too low → throws', async () => {
    ddb.on(GetCommand).resolves({});
    expect(await repo.transition({ tenantId: T, orderId: OID, to: 'CONFIRMED', actor: 'x', now })).toEqual({ kind: 'not_found' });
    ddb.on(GetCommand).resolves({ Item: order('CREATED') });
    const cancel = (...c: string[]) => new TransactionCanceledException({ message: 'x', $metadata: {}, CancellationReasons: c.map((Code) => ({ Code })) });
    ddb.on(TransactWriteCommand).rejects(cancel('ConditionalCheckFailed'));
    expect(await repo.transition({ tenantId: T, orderId: OID, to: 'CONFIRMED', actor: 'x', now })).toEqual({ kind: 'conflict' });
    ddb.on(TransactWriteCommand).rejects(cancel('None', 'ConditionalCheckFailed', 'None'));
    await expect(repo.transition({ tenantId: T, orderId: OID, to: 'CANCELLED', actor: 'x', now })).rejects.toThrow('Stock adjustment failed');
  });
  test('listByStatus queries GSI1 STATUS#<status>, newest first', async () => {
    ddb.on(QueryCommand).resolves({ Items: [order('CREATED'), { junk: 1 }] });
    expect((await repo.listByStatus('CREATED', 10)).orders).toHaveLength(1);
    expect(ddb.commandCalls(QueryCommand)[0]!.args[0].input).toMatchObject({
      IndexName: 'gsi1', ExpressionAttributeValues: { ':s': 'STATUS#CREATED' }, ScanIndexForward: false, Limit: 10,
    });
  });
});

describe('DTOs and cursor', () => {
  test('public DTO shows when the status changed but not who changed it', () => {
    const dto = toPublicOrder(order('CONFIRMED', { status_history: [{ from: 'CREATED', to: 'CONFIRMED', at: 'x', by: 'staff:secret-sub' }] }) as never);
    expect(dto.status_history).toEqual([{ from: 'CREATED', to: 'CONFIRMED', at: 'x' }]);
    expect(JSON.stringify(dto)).not.toContain('secret-sub');
  });
  test('admin cursor is bound to the queried status', () => {
    const key = { pk: `TENANT#${T}`, sk: `ORDER#${'1'.repeat(26)}`, gsi1pk: 'STATUS#CREATED', gsi1sk: '2026#o' };
    const tok = encodeAdminCursor(key);
    expect(decodeAdminCursor(tok, 'CREATED')).toEqual(key);
    expect(decodeAdminCursor(tok, 'SHIPPED')).toBeUndefined();
    expect(decodeAdminCursor('garbage', 'CREATED')).toBeUndefined();
  });
});

describe('admin handlers', () => {
  const calls: unknown[] = [];
  let result: unknown = { kind: 'updated', order: order('CONFIRMED') };
  beforeAll(() =>
    setAdminOrderRepoForTesting({
      transition: async (i: unknown) => (calls.push(i), result),
      get: async (t: string) => (t === T ? order('CREATED') : undefined),
      listByStatus: async () => ({ orders: [order('CREATED')], last: undefined }),
    } as never),
  );
  afterAll(() => setAdminOrderRepoForTesting(undefined));
  beforeEach(() => {
    calls.length = 0;
    result = { kind: 'updated', order: order('CONFIRMED') };
  });
  const ev = (o: { scopes?: string[]; body?: unknown; tenantId?: string; orderId?: string; query?: Record<string, string> } = {}) =>
    ({
      body: o.body === undefined ? JSON.stringify({ status: 'CONFIRMED' }) : JSON.stringify(o.body),
      pathParameters: { tenantId: o.tenantId ?? T, orderId: o.orderId ?? OID },
      queryStringParameters: o.query,
      requestContext: { authorizer: { jwt: { claims: { sub: 'staff-sub', scope: (o.scopes ?? ['brewline/admin']).join(' ') }, scopes: o.scopes ?? ['brewline/admin'] } } },
    }) as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;

  test('PATCH 200 records the staff actor; admin DTO includes tenant_id', async () => {
    const r = await patchHandler(ev());
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body!)).toMatchObject({ tenant_id: T, status: 'CONFIRMED' });
    expect(calls[0]).toMatchObject({ tenantId: T, orderId: OID, to: 'CONFIRMED', actor: 'staff:staff-sub' });
  });
  test.each([
    [{ kind: 'not_found' }, 404],
    [{ kind: 'invalid_transition', current: 'SHIPPED' }, 409],
    [{ kind: 'conflict' }, 409],
    [{ kind: 'busy' }, 503],
  ])('PATCH result %o → %i', async (res, code) => {
    result = res;
    expect((await patchHandler(ev())).statusCode).toBe(code);
  });
  test('invalid_transition tells which statuses are allowed', async () => {
    result = { kind: 'invalid_transition', current: 'CREATED' };
    expect(JSON.parse((await patchHandler(ev())).body!).error).toMatchObject({ current_status: 'CREATED', allowed: ['CONFIRMED', 'CANCELLED'] });
  });
  test('negative: no admin scope 403; bad ids or body 400; repo untouched', async () => {
    expect((await patchHandler(ev({ scopes: ['brewline/orders.write'] }))).statusCode).toBe(403);
    expect((await patchHandler(ev({ tenantId: 't_1' }))).statusCode).toBe(400);
    expect((await patchHandler(ev({ orderId: 'o_bad' }))).statusCode).toBe(400);
    expect((await patchHandler(ev({ body: { status: 'LOST' } }))).statusCode).toBe(400);
    expect((await patchHandler(ev({ body: { status: 'CONFIRMED', tenant_id: 'x' } }))).statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });
  test('GET one / list', async () => {
    expect((await getHandler(ev())).statusCode).toBe(200);
    expect((await getHandler(ev({ tenantId: 't_01BBBBBBBBBBBBBBBBBBBBBBBB' }))).statusCode).toBe(404);
    const l = await listHandler(ev({ query: { status: 'CREATED' } }));
    expect(JSON.parse(l.body!).items[0]).toMatchObject({ tenant_id: T });
    expect((await listHandler(ev({ query: { status: 'LOST' } }))).statusCode).toBe(400);
    expect((await listHandler(ev({ query: { next_token: 'garbage' } }))).statusCode).toBe(400);
    expect((await listHandler(ev({ scopes: ['brewline/orders.read'] }))).statusCode).toBe(403);
  });
});
