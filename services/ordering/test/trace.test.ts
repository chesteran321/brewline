import { ConditionalCheckFailedException, DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { BatchGetCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { loadLots, loadSeed, loadTestLots, seedLots } from '../src/custom-resources/seed-catalog';
import { handler as restockHandler } from '../src/handlers/restock';
import { createHandler, patchHandler, recallHandler } from '../src/handlers/roasts';
import { handler as traceHandler } from '../src/handlers/trace';
import { setTraceRepoForTesting } from '../src/lib/runtime';
import {
  CreateRoastRequestSchema,
  MAX_AVAILABLE_KG,
  QrTokenSchema,
  RecallRequestSchema,
  RoastIdSchema,
  newQrToken,
  roastIdFromKey,
  roastRequestHash,
} from '../src/lib/trace-model';
import { TraceRepo } from '../src/lib/trace-repo';

const T = 't_01AAAAAAAAAAAAAAAAAAAAAAAA';
const OID = `o_${'1'.repeat(26)}`;
const KEY = 'roast-key-0000000001';
const RID = roastIdFromKey(KEY);
const now = new Date('2026-11-18T08:00:00.000Z');

const product = { pk: 'PRODUCT#p-0001', sk: 'META', entity: 'Product', status: 'active', id: 'p-0001', name: 'A', name_zh: 'A',
  origin_country: 'ET', region: 'Yirgacheffe', process: 'washed', variety: 'v', altitude_m: 2000, cup_score: 87.5, roast_level: 'light',
  flavor_notes: ['x'], price_per_kg: 100, currency: 'TWD', lot_id: 'L-2026-001' };
const lot = { pk: 'LOT#L-2026-001', sk: 'META', entity: 'Lot', lot_id: 'L-2026-001', producer_display_name: 'P (fictional)', origin_country: 'ET',
  region: 'Yirgacheffe', altitude_m: 2000, variety: 'v', process: 'washed', cup_score: 87.5, harvest: '2025/26' };
const order = (extra: object = {}, line: object = {}) => ({
  pk: `TENANT#${T}`, sk: `ORDER#${'1'.repeat(26)}`, entity: 'Order', order_id: OID, tenant_id: T, status: 'ROASTING_SCHEDULED',
  payment_status: 'PAID_MOCK', total: 500, currency: 'TWD', created_by: 's', created_at: 'x', idempotency_key: 'k'.repeat(16),
  items: [
    { product_id: 'p-0002', name: 'B', qty_kg: 2, price_per_kg: 100, line_total: 200 },
    { product_id: 'p-0001', name: 'A', qty_kg: 3, price_per_kg: 100, line_total: 300, ...line },
  ],
  ...extra,
});
const req = (o: object = {}) => CreateRoastRequestSchema.parse({
  product_id: 'p-0001', roast_date: '2026-11-18', kg: 5, allocations: [{ tenant_id: T, order_id: OID, kg: 3 }], ...o,
});
const staff = { actor: 'staff:s', synthetic: false };
const sim = { actor: 'roastery:r', synthetic: true };

describe('trace model', () => {
  test('roast id is derived from the key: stable, valid, different per key', () => {
    expect(RoastIdSchema.safeParse(RID).success).toBe(true);
    expect(roastIdFromKey(KEY)).toBe(RID);
    expect(roastIdFromKey(`${KEY}x`)).not.toBe(RID);
  });
  test('QR token: 128 random bits as 22 base64url characters', () => {
    const t = newQrToken();
    expect(QrTokenSchema.safeParse(t).success).toBe(true);
    expect(newQrToken()).not.toBe(t);
    expect(() => newQrToken(Buffer.alloc(8))).toThrow();
  });
  test('request validation: batch ≤ 15 kg, allocations ≤ batch, unique orders, valid date', () => {
    const base = { product_id: 'p-0001', roast_date: '2026-11-18', kg: 5, allocations: [{ tenant_id: T, order_id: OID, kg: 3 }] };
    expect(CreateRoastRequestSchema.safeParse(base).success).toBe(true);
    expect(CreateRoastRequestSchema.safeParse({ ...base, kg: 16 }).success).toBe(false);
    expect(CreateRoastRequestSchema.safeParse({ ...base, allocations: [{ tenant_id: T, order_id: OID, kg: 6 }] }).success).toBe(false);
    expect(CreateRoastRequestSchema.safeParse({ ...base, allocations: [base.allocations[0], base.allocations[0]] }).success).toBe(false);
    expect(CreateRoastRequestSchema.safeParse({ ...base, roast_date: '2026-13-45' }).success).toBe(false);
    expect(CreateRoastRequestSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });
  test('request hash ignores allocation order', () => {
    const T2 = 't_01BBBBBBBBBBBBBBBBBBBBBBBB';
    const a = req({ allocations: [{ tenant_id: T, order_id: OID, kg: 1 }, { tenant_id: T2, order_id: OID, kg: 2 }] });
    const b = req({ allocations: [{ tenant_id: T2, order_id: OID, kg: 2 }, { tenant_id: T, order_id: OID, kg: 1 }] });
    expect(roastRequestHash(a)).toBe(roastRequestHash(b));
    expect(roastRequestHash(a)).not.toBe(roastRequestHash(req()));
  });
  test('recall notice is plain text for the public page', () => {
    expect(RecallRequestSchema.safeParse({ notice: 'Possible foreign matter; do not consume.' }).success).toBe(true);
    expect(RecallRequestSchema.safeParse({ notice: '<script>x</script>' }).success).toBe(false);
    expect(RecallRequestSchema.safeParse({ notice: 'hi' }).success).toBe(false);
  });
});

describe('lot seed', () => {
  test('every product has its lot, with matching origin fields; lots are fictional producers', () => {
    const lots = loadLots(loadSeed());
    expect(lots).toHaveLength(8);
    expect(lots.every((l) => l.producer_display_name.includes('(fictional)'))).toBe(true);
    expect(loadTestLots().map((l) => l.lot_id)).toEqual(['L-9999-001', 'L-9999-002']);
  });
  test('negative: unknown lot, disagreeing origin, duplicate lot', () => {
    const products = loadSeed();
    const lots = loadLots(products);
    expect(() => loadLots(products, lots.slice(1))).toThrow('unknown lot');
    expect(() => loadLots(products, [{ ...lots[0], region: 'Elsewhere' }, ...lots.slice(1)])).toThrow('disagrees');
    expect(() => loadLots(products, [...lots, lots[0]])).toThrow('Duplicate');
  });
});

describe('TraceRepo reads what the seed writes (regression 2026-11-18)', () => {
  const ddb = mockClient(DynamoDBDocumentClient);
  const repo = new TraceRepo(DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-east-2' })), 'tbl');
  beforeEach(() => ddb.reset());

  test('getLot accepts the exact item seedLots() puts (with updated_at)', async () => {
    ddb.on(PutCommand).resolves({});
    await seedLots(DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-east-2' })), 'tbl', loadLots(loadSeed()).slice(0, 1));
    const stored = ddb.commandCalls(PutCommand)[0]!.args[0].input.Item!;
    expect(stored).toHaveProperty('updated_at');
    ddb.on(GetCommand).resolves({ Item: stored });
    expect(await repo.getLot(String(stored.lot_id))).toMatchObject({ lot_id: stored.lot_id });
  });

  test('negative: an item that is not a lot is still rejected', async () => {
    ddb.on(GetCommand).resolves({ Item: { ...lot, entity: 'Product' } });
    expect(await repo.getLot('L-2026-001')).toBeUndefined();
  });
});

describe('TraceRepo.createRoast', () => {
  const ddb = mockClient(DynamoDBDocumentClient);
  const repo = new TraceRepo(DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-east-2' })), 'tbl');
  const get = (items: Record<string, unknown>) =>
    ddb.on(GetCommand).callsFake((i) => ({ Item: items[`${i.Key.pk}|${i.Key.sk}`] }));
  const base = { 'PRODUCT#p-0001|META': product, 'LOT#L-2026-001|META': lot, [`TENANT#${T}|ORDER#${'1'.repeat(26)}`]: order() };
  beforeEach(() => ddb.reset());

  test('one transaction: batch (if absent), lot edge, conditional line allocation, roast→order edge', async () => {
    get(base);
    ddb.on(TransactWriteCommand).resolves({});
    const r = await repo.createRoast(req(), KEY, staff, now);
    expect(r).toMatchObject({ kind: 'created', roast: { roast_id: RID, lot_id: 'L-2026-001', status: 'SCHEDULED', roast_level: 'light', kg: 5 } });
    const tx = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    expect(tx).toHaveLength(4);
    expect(tx[0]!.Put).toMatchObject({ Item: { pk: `ROAST#${RID}`, sk: 'META' }, ConditionExpression: 'attribute_not_exists(pk)' });
    expect(tx[0]!.Put!.Item).not.toHaveProperty('synthetic');
    expect(tx[1]!.Put!.Item).toMatchObject({ pk: 'LOT#L-2026-001', sk: `ROAST#2026-11-18#${RID}` });
    // 品項索引 1（p-0001）、最多已分配 0 kg、不能是模擬訂單 / Line index 1, prior allocation ≤ 0, must not be synthetic.
    expect(tx[2]!.Update!.ConditionExpression).toContain('#it[1].product_id = :p');
    expect(tx[2]!.Update!.ConditionExpression).toContain('attribute_not_exists(#syn)');
    expect(tx[2]!.Update!.ExpressionAttributeValues).toMatchObject({ ':k': 3, ':maxPrev': 0, ':rs': 'ROASTING_SCHEDULED', ':rid': RID });
    expect(tx[3]!.Put!.Item).toMatchObject({ pk: `ROAST#${RID}`, sk: `ORDER#${T}#${OID}`, kg: 3 });
  });

  test('replay: same key and body → replayed; different body → key_conflict; nothing written', async () => {
    const existing = { pk: `ROAST#${RID}`, sk: 'META', entity: 'RoastBatch', roast_id: RID, product_id: 'p-0001', lot_id: 'L-2026-001',
      roast_date: '2026-11-18', roast_level: 'light', kg: 5, status: 'SCHEDULED', request_hash: roastRequestHash(req()), created_by: 'staff:s', created_at: 'x' };
    get({ ...base, [`ROAST#${RID}|META`]: existing });
    expect(await repo.createRoast(req(), KEY, staff, now)).toMatchObject({ kind: 'replayed' });
    expect(await repo.createRoast(req({ kg: 6 }), KEY, staff, now)).toEqual({ kind: 'key_conflict' });
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  test.each([
    ['product missing', { 'PRODUCT#p-0001|META': undefined }, { kind: 'not_found', what: 'product' }],
    ['lot missing', { 'LOT#L-2026-001|META': undefined }, { kind: 'not_found', what: 'lot' }],
    ['order missing', { [`TENANT#${T}|ORDER#${'1'.repeat(26)}`]: undefined }, { kind: 'not_found', what: 'order' }],
    ['order only CONFIRMED', { [`TENANT#${T}|ORDER#${'1'.repeat(26)}`]: order({ status: 'CONFIRMED' }) }, { kind: 'invalid_state', status: 'CONFIRMED' }],
    ['order has no such product', { [`TENANT#${T}|ORDER#${'1'.repeat(26)}`]: order({ items: [order().items[0]] }) }, { kind: 'product_mismatch' }],
    ['line already 1 of 3 kg allocated', { [`TENANT#${T}|ORDER#${'1'.repeat(26)}`]: order({}, { allocated_kg: 1 }) }, { kind: 'over_allocated', remaining_kg: 2 }],
    ['synthetic order into a real batch', { [`TENANT#${T}|ORDER#${'1'.repeat(26)}`]: order({ synthetic: true }) }, { kind: 'synthetic_mismatch' }],
  ])('negative: %s → no write', async (_n, override, expected) => {
    get({ ...base, ...override });
    expect(await repo.createRoast(req(), KEY, staff, now)).toMatchObject(expected);
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  test('synthetic caller: real order refused; synthetic order → synthetic batch with a synthetic condition', async () => {
    get(base);
    expect(await repo.createRoast(req(), KEY, sim, now)).toMatchObject({ kind: 'synthetic_mismatch' });
    get({ ...base, [`TENANT#${T}|ORDER#${'1'.repeat(26)}`]: order({ synthetic: true }) });
    ddb.on(TransactWriteCommand).resolves({});
    expect(await repo.createRoast(req(), KEY, sim, now)).toMatchObject({ kind: 'created', roast: { synthetic: true, created_by: 'roastery:r' } });
    const tx = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    expect(tx[2]!.Update!.ConditionExpression).toContain('#syn = :true');
  });

  test('race: an order changed meanwhile → conflict; throttled → busy', async () => {
    get(base);
    const cancel = (codes: string[]) =>
      new TransactionCanceledException({ message: 'x', $metadata: {}, CancellationReasons: codes.map((Code) => ({ Code })) });
    ddb.on(TransactWriteCommand).rejects(cancel(['None', 'None', 'ConditionalCheckFailed', 'None']));
    expect(await repo.createRoast(req(), KEY, staff, now)).toEqual({ kind: 'conflict' });
    ddb.on(TransactWriteCommand).rejects(cancel(['None', 'None', 'TransactionConflict', 'None']));
    expect(await repo.createRoast(req(), KEY, staff, now)).toEqual({ kind: 'busy' });
  });
});

describe('TraceRepo roast updates and restock', () => {
  const ddb = mockClient(DynamoDBDocumentClient);
  const repo = new TraceRepo(DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-east-2' })), 'tbl');
  const meta = (extra: object = {}) => ({ pk: `ROAST#${RID}`, sk: 'META', entity: 'RoastBatch', roast_id: RID, product_id: 'p-0001',
    lot_id: 'L-2026-001', roast_date: '2026-11-18', roast_level: 'light', kg: 5, status: 'SCHEDULED', request_hash: 'h', created_by: 's', created_at: 'x', ...extra });
  const ccf = () => new ConditionalCheckFailedException({ message: 'x', $metadata: {} });
  beforeEach(() => ddb.reset());

  test('markRoasted: only from SCHEDULED, mints a QR token; synthetic callers need a synthetic batch', async () => {
    ddb.on(UpdateCommand).resolves({ Attributes: meta({ status: 'ROASTED', qr_token: 'A'.repeat(22), roasted_at: 'y' }) });
    expect(await repo.markRoasted(RID, staff, now)).toMatchObject({ kind: 'updated', roast: { status: 'ROASTED' } });
    const input = ddb.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(input.ConditionExpression).toBe('#s = :scheduled');
    expect(QrTokenSchema.safeParse(input.ExpressionAttributeValues![':q']).success).toBe(true);
    await repo.markRoasted(RID, sim, now);
    expect(ddb.commandCalls(UpdateCommand)[1]!.args[0].input.ConditionExpression).toBe('#s = :scheduled AND #syn = :true');
  });

  test('markRoasted negative: twice → invalid_state; missing → not_found; synthetic on real → forbidden', async () => {
    ddb.on(UpdateCommand).rejects(ccf());
    ddb.on(GetCommand).resolves({ Item: meta({ status: 'ROASTED' }) });
    expect(await repo.markRoasted(RID, staff, now)).toEqual({ kind: 'invalid_state', status: 'ROASTED' });
    ddb.on(GetCommand).resolves({ Item: meta() });
    expect(await repo.markRoasted(RID, sim, now)).toEqual({ kind: 'forbidden' });
    ddb.on(GetCommand).resolves({});
    expect(await repo.markRoasted(RID, staff, now)).toEqual({ kind: 'not_found' });
  });

  test('recall: once only', async () => {
    ddb.on(UpdateCommand).resolves({ Attributes: meta({ recall: { at: 'x', notice: 'n', by: 'staff:s' } }) });
    expect(await repo.recall(RID, 'notice text', staff, now)).toMatchObject({ kind: 'updated' });
    ddb.on(UpdateCommand).rejects(ccf());
    ddb.on(GetCommand).resolves({ Item: meta() });
    expect(await repo.recall(RID, 'notice text', staff, now)).toEqual({ kind: 'already_recalled' });
  });

  test('restock: optimistic lock and cap; stale version → version_conflict; cap → over_cap', async () => {
    const stock = (v: number, a = 100) => ({ Item: { pk: 'PRODUCT#p-0001', sk: 'STOCK', available_kg: a, reserved_kg: 0, low_threshold_kg: 10, version: v } });
    ddb.on(UpdateCommand).resolves({});
    ddb.on(GetCommand).resolves(stock(4, 110));
    expect(await repo.restock('p-0001', 10, 3, now)).toMatchObject({ kind: 'updated', stock: { available_kg: 110, version: 4 } });
    expect(ddb.commandCalls(UpdateCommand)[0]!.args[0].input).toMatchObject({
      ConditionExpression: 'attribute_exists(#pk) AND #v = :ev AND #a <= :cap',
      ExpressionAttributeValues: expect.objectContaining({ ':ev': 3, ':k': 10, ':cap': MAX_AVAILABLE_KG - 10 }),
    });
    ddb.on(UpdateCommand).rejects(ccf());
    ddb.on(GetCommand).resolves(stock(5));
    expect(await repo.restock('p-0001', 10, 3, now)).toEqual({ kind: 'version_conflict', current_version: 5 });
    ddb.on(GetCommand).resolves(stock(3, MAX_AVAILABLE_KG));
    expect(await repo.restock('p-0001', 10, 3, now)).toEqual({ kind: 'over_cap', max_available_kg: MAX_AVAILABLE_KG });
  });

  test('roastsOfLot keeps newest-first edge order', async () => {
    const R2 = roastIdFromKey('other-key-000000001');
    ddb.on(QueryCommand).resolves({ Items: [{ roast_id: R2 }, { roast_id: RID }] });
    ddb.on(BatchGetCommand).resolves({ Responses: { tbl: [meta(), meta({ pk: `ROAST#${R2}`, roast_id: R2 })] } });
    expect((await repo.roastsOfLot('L-2026-001')).map((r) => r.roast_id)).toEqual([R2, RID]);
    expect(ddb.commandCalls(QueryCommand)[0]!.args[0].input).toMatchObject({ ScanIndexForward: false, ExpressionAttributeValues: { ':pk': 'LOT#L-2026-001', ':p': 'ROAST#' } });
  });
});

describe('roast, restock and trace handlers', () => {
  const calls: Array<[string, unknown[]]> = [];
  let result: unknown;
  const roast = { roast_id: RID, product_id: 'p-0001', lot_id: 'L-2026-001', roast_date: '2026-11-18', roast_level: 'light', kg: 5,
    status: 'SCHEDULED', request_hash: 'h', created_by: 's', created_at: 'x', pk: `ROAST#${RID}`, sk: 'META', entity: 'RoastBatch' };
  beforeAll(() =>
    setTraceRepoForTesting(
      new Proxy({}, {
        get: (_t, name: string) => async (...args: unknown[]) => {
          calls.push([name, args]);
          if (name === 'getLot') return lot;
          if (name === 'getRoast') return roast;
          if (name === 'roastsOfLot' || name === 'ordersOfRoast') return [];
          return result;
        },
      }) as never,
    ),
  );
  afterAll(() => setTraceRepoForTesting(undefined));
  beforeEach(() => {
    calls.length = 0;
    result = { kind: 'created', roast };
  });
  const ev = (o: { scopes?: string[]; body?: unknown; key?: string; id?: string; query?: Record<string, string>; synthetic?: boolean } = {}) =>
    ({
      body: JSON.stringify(o.body ?? { product_id: 'p-0001', roast_date: '2026-11-18', kg: 5, allocations: [{ tenant_id: T, order_id: OID, kg: 3 }] }),
      headers: o.key === undefined ? { 'idempotency-key': KEY } : o.key ? { 'idempotency-key': o.key } : {},
      pathParameters: { id: o.id ?? RID },
      queryStringParameters: o.query,
      requestContext: { authorizer: { jwt: { claims: { sub: 'u1', ...(o.synthetic ? { synthetic: 'true' } : {}) }, scopes: o.scopes ?? ['brewline/roastery'] } } },
    }) as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;

  test('POST /admin/roasts: 201 created, 200 replayed, 422 key reuse; staff actor when admin scope', async () => {
    expect((await createHandler(ev({ scopes: ['brewline/admin', 'brewline/roastery'] }))).statusCode).toBe(201);
    expect(calls[0]![1][2]).toEqual({ actor: 'staff:u1', synthetic: false });
    result = { kind: 'replayed', roast };
    expect((await createHandler(ev())).statusCode).toBe(200);
    result = { kind: 'key_conflict' };
    expect((await createHandler(ev())).statusCode).toBe(422);
  });
  test.each([
    [{ kind: 'not_found', what: 'order', ref: 'x' }, 404],
    [{ kind: 'not_found', what: 'lot', ref: 'x' }, 409],
    [{ kind: 'invalid_state', ref: 'x', status: 'CONFIRMED' }, 409],
    [{ kind: 'over_allocated', ref: 'x', remaining_kg: 1 }, 409],
    [{ kind: 'synthetic_mismatch', ref: 'x' }, 403],
    [{ kind: 'busy' }, 503],
  ])('POST /admin/roasts result %o → %i', async (res, code) => {
    result = res;
    expect((await createHandler(ev())).statusCode).toBe(code);
  });
  test('POST /admin/roasts negative: no roastery scope 403, no key 400, bad body 400; repo untouched', async () => {
    expect((await createHandler(ev({ scopes: ['brewline/admin'] }))).statusCode).toBe(403);
    expect((await createHandler(ev({ key: '' }))).statusCode).toBe(400);
    expect((await createHandler(ev({ body: { product_id: 'p-0001', roast_date: '2026-11-18', kg: 16, allocations: [] } }))).statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });
  test('PATCH roast → ROASTED; recall is admin-only; synthetic flag is passed through', async () => {
    result = { kind: 'updated', roast: { ...roast, status: 'ROASTED', qr_token: 'A'.repeat(22) } };
    const r = await patchHandler(ev({ body: { status: 'ROASTED' }, synthetic: true }));
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body!)).toMatchObject({ status: 'ROASTED', qr_token: 'A'.repeat(22) });
    expect(calls[0]![1][1]).toEqual({ actor: 'roastery:u1', synthetic: true });
    expect((await patchHandler(ev({ body: { status: 'SCHEDULED' } }))).statusCode).toBe(400);
    expect((await patchHandler(ev({ id: 'r_bad', body: { status: 'ROASTED' } }))).statusCode).toBe(400);
    expect((await recallHandler(ev({ body: { notice: 'Do not consume this batch.' } }))).statusCode).toBe(403);
    expect((await recallHandler(ev({ scopes: ['brewline/admin'], body: { notice: 'Do not consume this batch.' } }))).statusCode).toBe(200);
    result = { kind: 'already_recalled' };
    expect((await recallHandler(ev({ scopes: ['brewline/admin'], body: { notice: 'Do not consume this batch.' } }))).statusCode).toBe(409);
  });
  test('restock: roastery only, bounded body, 409 on stale version', async () => {
    result = { kind: 'updated', stock: { pk: 'PRODUCT#p-0001', sk: 'STOCK', available_kg: 110, reserved_kg: 0, low_threshold_kg: 10, version: 4 } };
    const r = await restockHandler(ev({ id: undefined, body: { kg: 10, expected_version: 3 } }) as never);
    expect(r.statusCode).toBe(400); // 路徑是烘焙批次 ID，不是商品 ID / the path id is a roast id, not a product id
    const okEv = ev({ body: { kg: 10, expected_version: 3 } }) as any;
    okEv.pathParameters = { id: 'p-0001' };
    expect((await restockHandler(okEv)).statusCode).toBe(200);
    result = { kind: 'version_conflict', current_version: 5 };
    expect((await restockHandler(okEv)).statusCode).toBe(409);
    okEv.body = JSON.stringify({ kg: 0, expected_version: 3 });
    expect((await restockHandler(okEv)).statusCode).toBe(400);
    okEv.requestContext.authorizer.jwt.scopes = ['brewline/admin'];
    expect((await restockHandler(okEv)).statusCode).toBe(403);
  });
  test('trace: exactly one query form; synthetic callers do not see real batches', async () => {
    expect((await traceHandler(ev({ query: { lot: 'L-2026-001' } }))).statusCode).toBe(200);
    expect((await traceHandler(ev({ query: { roast: RID } }))).statusCode).toBe(200);
    expect((await traceHandler(ev({ query: { roast: RID }, synthetic: true }))).statusCode).toBe(404);
    expect((await traceHandler(ev({ query: { lot: 'L-2026-001', roast: RID } }))).statusCode).toBe(400);
    expect((await traceHandler(ev({ query: { tenant: T } }))).statusCode).toBe(400);
    expect((await traceHandler(ev({ scopes: ['brewline/orders.read'], query: { lot: 'L-2026-001' } }))).statusCode).toBe(403);
  });
});
