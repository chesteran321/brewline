import { DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { BatchGetCommand, DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { createHandler, getHandler, listHandler, setClockForTesting, setShipmentRepoForTesting } from '../src/handlers/shipments';
import { isValidContainerNumber } from '../src/iso6346';
import {
  CreateShipmentRequestSchema,
  DcsaTransportEventSchema,
  EDGE_ATTRIBUTES,
  ShipmentIdSchema,
  ShipmentItem,
  bookingReference,
  equipmentFor,
  shipmentIdFromKey,
  shipmentRequestHash,
  toAdminShipment,
} from '../src/model';
import { ShipmentRepo } from '../src/shipment-repo';

const KEY = 'ship-key-000000000001';
const SID = shipmentIdFromKey(KEY);
const now = new Date('2026-11-21T08:00:00.000Z');
const body = {
  lot_id: 'L-2026-001',
  planned_departure: '2026-11-25T03:00:00Z',
  planned_arrival: '2026-12-12T09:00:00Z',
  carrier_voyage_number: 'D001E',
  vessel_id: 'SIMV-01',
  vessel_name: 'Demo Kestrel',
};
const staff = { actor: 'staff:s', synthetic: false };
const sim = { actor: 'roastery:r', synthetic: true };
const lotItem = { pk: 'LOT#L-2026-001', sk: 'META', entity: 'Lot' };

describe('shipment model', () => {
  test('id, booking reference and container are derived from the key and stable', () => {
    expect(ShipmentIdSchema.safeParse(SID).success).toBe(true);
    expect(shipmentIdFromKey(KEY)).toBe(SID);
    expect(shipmentIdFromKey(`${KEY}x`)).not.toBe(SID);
    expect(bookingReference(SID)).toMatch(/^BLDEMO[0-9A-Z]{10}$/);
    const [c] = equipmentFor(SID);
    expect(c!.equipment_reference).toMatch(/^DMQU\d{7}$/);
    expect(isValidContainerNumber(c!.equipment_reference)).toBe(true);
    expect(equipmentFor(SID)).toEqual(equipmentFor(SID));
  });
  test('request validation (strict, order of dates, voyage ≤ 60 days, plain-text vessel name)', () => {
    expect(CreateShipmentRequestSchema.safeParse(body).success).toBe(true);
    expect(CreateShipmentRequestSchema.safeParse({ ...body, synthetic: true }).success).toBe(false); // 不信任用戶端 / never trust the client
    expect(CreateShipmentRequestSchema.safeParse({ ...body, pol: 'TWKHH' }).success).toBe(false); // POL 由伺服器決定 / server decides
    expect(CreateShipmentRequestSchema.safeParse({ ...body, planned_arrival: body.planned_departure }).success).toBe(false);
    expect(CreateShipmentRequestSchema.safeParse({ ...body, planned_arrival: '2027-03-01T00:00:00Z' }).success).toBe(false);
    expect(CreateShipmentRequestSchema.safeParse({ ...body, vessel_name: '<b>x</b>' }).success).toBe(false);
    expect(CreateShipmentRequestSchema.safeParse({ ...body, planned_departure: '2026-11-25' }).success).toBe(false);
  });
  test('request hash changes with any field', () => {
    const a = CreateShipmentRequestSchema.parse(body);
    expect(shipmentRequestHash(a)).toBe(shipmentRequestHash(CreateShipmentRequestSchema.parse({ ...body })));
    expect(shipmentRequestHash(a)).not.toBe(shipmentRequestHash(CreateShipmentRequestSchema.parse({ ...body, vessel_id: 'SIMV-02' })));
  });
  test('DCSA T&T 2.2.0 transport event subset', () => {
    const ev = {
      eventID: 'e1',
      eventType: 'TRANSPORT',
      eventClassifierCode: 'ACT',
      transportEventTypeCode: 'DEPA',
      eventDateTime: '2026-11-25T03:40:00Z',
      eventCreatedDateTime: '2026-11-25T03:45:00Z',
      documentReferences: [{ documentReferenceType: 'BKG', documentReferenceValue: 'BLDEMO0000000000' }],
      transportCall: { UNLocationCode: 'DJJIB', modeOfTransport: 'VESSEL', facilityTypeCode: 'POTE', carrierVoyageNumber: 'D001E', vessel: { vesselName: 'Demo Kestrel' } },
    };
    expect(DcsaTransportEventSchema.safeParse(ev).success).toBe(true);
    expect(DcsaTransportEventSchema.safeParse({ ...ev, transportEventTypeCode: 'LOAD' }).success).toBe(false); // 設備事件在 P2d / equipment events are P2d
    expect(DcsaTransportEventSchema.safeParse({ ...ev, eventType: 'EQUIPMENT' }).success).toBe(false);
    expect(DcsaTransportEventSchema.safeParse({ ...ev, extra: 1 }).success).toBe(false);
  });
});

describe('ShipmentRepo', () => {
  const ddb = mockClient(DynamoDBDocumentClient);
  const repo = new ShipmentRepo(DynamoDBDocumentClient.from(new DynamoDBClient({})), 'tbl');
  beforeEach(() => ddb.reset());

  test('creates META + lot edge + vessel edge in one transaction; POL/POD come from the seed', async () => {
    ddb.on(GetCommand, { Key: { pk: `SHIP#${SID}`, sk: 'META' } }).resolves({});
    ddb.on(GetCommand, { Key: { pk: 'LOT#L-2026-001', sk: 'META' } }).resolves({ Item: lotItem });
    ddb.on(TransactWriteCommand).resolves({});
    const r = await repo.createShipment(CreateShipmentRequestSchema.parse(body), KEY, sim, now);
    expect(r.kind).toBe('created');
    const items = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    expect(items).toHaveLength(3);
    const meta = items[0]!.Put!.Item as ShipmentItem;
    expect(items[0]!.Put!.ConditionExpression).toBe('attribute_not_exists(pk)');
    expect(meta).toMatchObject({ pol: 'DJJIB', pod: 'TWKEL', route_id: 'DJJIB-TWKEL', status: 'PLANNED', synthetic: true, version: 1 });
    expect(items[1]!.Put!.Item).toMatchObject({ pk: 'LOT#L-2026-001', sk: `SHIP#${body.planned_departure}#${SID}`, entity: 'LotShipment' });
    expect(items[2]!.Put!.Item).toMatchObject({ pk: 'VESSEL#SIMV-01', sk: `VOY#${body.planned_departure}#${SID}`, entity: 'VesselVoyage' });
    // IAM 的 dynamodb:Attributes 只允許這些邊欄位 → 邊的寫入不能多帶欄位 / Edges must stay within the IAM attribute list.
    for (const e of [items[1]!, items[2]!]) expect(Object.keys(e.Put!.Item!).every((k) => (EDGE_ATTRIBUTES as readonly string[]).includes(k))).toBe(true);
  });
  test('real callers create real shipments (no synthetic attribute)', async () => {
    ddb.on(GetCommand, { Key: { pk: `SHIP#${SID}`, sk: 'META' } }).resolves({});
    ddb.on(GetCommand, { Key: { pk: 'LOT#L-2026-001', sk: 'META' } }).resolves({ Item: lotItem });
    ddb.on(TransactWriteCommand).resolves({});
    await repo.createShipment(CreateShipmentRequestSchema.parse(body), KEY, staff, now);
    const items = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    for (const it of items) expect('synthetic' in it.Put!.Item!).toBe(false);
  });
  test('replay 200 / key reuse 422 / unknown lot / no sea route (TW lot)', async () => {
    const stored: ShipmentItem = {
      pk: `SHIP#${SID}`, sk: 'META', entity: 'Shipment', shipment_id: SID, lot_id: 'L-2026-001', route_id: 'DJJIB-TWKEL', pol: 'DJJIB', pod: 'TWKEL',
      carrier_booking_reference: bookingReference(SID), carrier_voyage_number: 'D001E', vessel: { vessel_id: 'SIMV-01', vessel_name: 'Demo Kestrel' },
      equipment: equipmentFor(SID), planned_departure: body.planned_departure, planned_arrival: body.planned_arrival, status: 'PLANNED',
      request_hash: shipmentRequestHash(CreateShipmentRequestSchema.parse(body)), version: 1, created_by: 'x', created_at: 'x', synthetic: true,
    };
    ddb.on(GetCommand, { Key: { pk: `SHIP#${SID}`, sk: 'META' } }).resolves({ Item: stored });
    expect((await repo.createShipment(CreateShipmentRequestSchema.parse(body), KEY, sim, now)).kind).toBe('replayed');
    expect((await repo.createShipment(CreateShipmentRequestSchema.parse({ ...body, vessel_id: 'SIMV-02' }), KEY, sim, now)).kind).toBe('key_conflict');
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);

    ddb.reset();
    ddb.on(GetCommand).resolves({});
    expect((await repo.createShipment(CreateShipmentRequestSchema.parse(body), KEY, sim, now)).kind).toBe('lot_not_found');
    ddb.reset();
    ddb.on(GetCommand, { Key: { pk: 'LOT#L-2026-008', sk: 'META' } }).resolves({ Item: { ...lotItem, pk: 'LOT#L-2026-008' } });
    ddb.on(GetCommand, { Key: { pk: `SHIP#${SID}`, sk: 'META' } }).resolves({});
    expect((await repo.createShipment(CreateShipmentRequestSchema.parse({ ...body, lot_id: 'L-2026-008' }), KEY, sim, now)).kind).toBe('no_sea_route');
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
  test('a concurrent request with the same key → replay; throttling → busy', async () => {
    ddb.on(GetCommand, { Key: { pk: 'LOT#L-2026-001', sk: 'META' } }).resolves({ Item: lotItem });
    ddb.on(GetCommand, { Key: { pk: `SHIP#${SID}`, sk: 'META' } }).resolves({});
    ddb.on(TransactWriteCommand).rejects(
      new TransactionCanceledException({ message: 'x', $metadata: {}, CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }, { Code: 'None' }] }),
    );
    expect((await repo.createShipment(CreateShipmentRequestSchema.parse(body), KEY, sim, now)).kind).toBe('conflict');
    ddb.on(TransactWriteCommand).rejects(
      new TransactionCanceledException({ message: 'x', $metadata: {}, CancellationReasons: [{ Code: 'None' }, { Code: 'TransactionConflict' }, { Code: 'None' }] }),
    );
    expect((await repo.createShipment(CreateShipmentRequestSchema.parse(body), KEY, sim, now)).kind).toBe('busy');
  });
  test('detail groups META, events (sorted) and track; list reads lot edges then META', async () => {
    const meta = {
      pk: `SHIP#${SID}`, sk: 'META', entity: 'Shipment', shipment_id: SID, lot_id: 'L-2026-001', route_id: 'DJJIB-TWKEL', pol: 'DJJIB', pod: 'TWKEL',
      carrier_booking_reference: 'BLDEMO0000000000', carrier_voyage_number: 'D001E', vessel: { vessel_id: 'SIMV-01', vessel_name: 'Demo Kestrel' },
      equipment: equipmentFor(SID), planned_departure: body.planned_departure, planned_arrival: body.planned_arrival, status: 'DEPARTED',
      request_hash: 'h', version: 2, created_by: 'x', created_at: 'x',
    };
    const evt = (t: string, code: string) => ({
      pk: `SHIP#${SID}`, sk: `EVT#${t}#e`, entity: 'TransportEvent',
      event: { eventID: `e-${code}`, eventType: 'TRANSPORT', eventClassifierCode: 'ACT', transportEventTypeCode: code, eventDateTime: t, eventCreatedDateTime: t,
        documentReferences: [{ documentReferenceType: 'BKG', documentReferenceValue: 'B' }],
        transportCall: { UNLocationCode: 'DJJIB', modeOfTransport: 'VESSEL', facilityTypeCode: 'POTE', carrierVoyageNumber: 'D001E', vessel: { vesselName: 'V' } } },
    });
    ddb.on(QueryCommand, { ExpressionAttributeValues: { ':pk': `SHIP#${SID}` } }).resolves({
      Items: [evt('2026-11-26T00:00:00Z', 'ARRI'), meta, evt('2026-11-25T03:40:00Z', 'DEPA'), { pk: `SHIP#${SID}`, sk: 'TRACK', entity: 'Track', points: [[1, 2, 't']] }],
    });
    const d = await repo.getDetail(SID);
    expect(d?.shipment.status).toBe('DEPARTED');
    expect(d?.events.map((e) => e.transportEventTypeCode)).toEqual(['DEPA', 'ARRI']);
    expect(d?.track).toEqual([[1, 2, 't']]);

    ddb.on(QueryCommand, { ExpressionAttributeValues: { ':pk': 'LOT#L-2026-001', ':p': 'SHIP#' } }).resolves({
      Items: [{ pk: 'LOT#L-2026-001', sk: 'SHIP#x', entity: 'LotShipment', shipment_id: SID, planned_departure: body.planned_departure, pol: 'DJJIB', pod: 'TWKEL', status: 'PLANNED' }],
    });
    ddb.on(BatchGetCommand).resolves({ Responses: { tbl: [meta] } });
    const list = await repo.listByLot('L-2026-001', 20);
    expect(list.map((s) => s.shipment_id)).toEqual([SID]);
    expect(ddb.commandCalls(QueryCommand).at(-1)!.args[0].input.ScanIndexForward).toBe(false);
  });
});

describe('shipment handlers', () => {
  const calls: unknown[][] = [];
  let result: unknown = { kind: 'created', shipment: undefined };
  const meta = (synthetic: boolean): ShipmentItem => ({
    pk: `SHIP#${SID}`, sk: 'META', entity: 'Shipment', shipment_id: SID, lot_id: 'L-2026-001', route_id: 'DJJIB-TWKEL', pol: 'DJJIB', pod: 'TWKEL',
    carrier_booking_reference: 'BLDEMO0000000000', carrier_voyage_number: 'D001E', vessel: { vessel_id: 'SIMV-01', vessel_name: 'Demo Kestrel' },
    equipment: equipmentFor(SID), planned_departure: body.planned_departure, planned_arrival: body.planned_arrival, status: 'PLANNED',
    request_hash: 'h', version: 1, created_by: 'x', created_at: 'x', ...(synthetic ? { synthetic: true as const } : {}),
  });
  let stored: ShipmentItem[] = [];
  beforeAll(() => {
    setClockForTesting(() => now);
    setShipmentRepoForTesting({
      createShipment: async (...a: unknown[]) => {
        calls.push(a);
        return result;
      },
      getDetail: async () => (stored[0] ? { shipment: stored[0], events: [], track: [] } : undefined),
      listByLot: async () => stored,
    } as unknown as ShipmentRepo);
  });
  afterAll(() => {
    setShipmentRepoForTesting(undefined);
    setClockForTesting(undefined);
  });
  beforeEach(() => {
    calls.length = 0;
    result = { kind: 'created', shipment: meta(true) };
    stored = [];
  });
  const ev = (o: { scopes?: string[]; body?: unknown; key?: string | null; id?: string; query?: Record<string, string>; synthetic?: boolean } = {}) =>
    ({
      body: JSON.stringify(o.body ?? body),
      headers: o.key === null ? {} : { 'idempotency-key': o.key ?? KEY },
      pathParameters: { id: o.id ?? SID },
      queryStringParameters: o.query,
      requestContext: { authorizer: { jwt: { claims: { sub: 'u1', ...(o.synthetic ? { synthetic: 'true' } : {}) }, scopes: o.scopes ?? ['brewline/roastery'] } } },
    }) as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;

  test('POST: 201; caller is roastery (synthetic) or staff', async () => {
    const r = await createHandler(ev({ synthetic: true }));
    expect(r.statusCode).toBe(201);
    expect(JSON.parse(r.body as string)).toMatchObject({ shipment_id: SID, pol: 'DJJIB', pod: 'TWKEL', synthetic: true });
    expect(calls[0]![2]).toEqual({ actor: 'roastery:u1', synthetic: true });
    await createHandler(ev({ scopes: ['brewline/admin', 'brewline/roastery'] }));
    expect(calls[1]![2]).toEqual({ actor: 'staff:u1', synthetic: false });
  });
  test.each([
    [{ kind: 'key_conflict' }, 422, 'idempotency_key_reused'],
    [{ kind: 'lot_not_found' }, 400, 'lot_not_found'],
    [{ kind: 'no_sea_route' }, 400, 'no_sea_route'],
    [{ kind: 'conflict' }, 409, 'conflict'],
    [{ kind: 'busy' }, 503, 'try_again'],
  ])('POST result %j → %i', async (res, status, code) => {
    result = res;
    const r = await createHandler(ev({ synthetic: true }));
    expect(r.statusCode).toBe(status);
    expect(JSON.parse(r.body as string).error.code).toBe(code);
  });
  test('POST replay: 200 for the same caller kind; a synthetic caller replaying a real shipment gets 422, not the shipment', async () => {
    result = { kind: 'replayed', shipment: meta(true) };
    expect((await createHandler(ev({ synthetic: true }))).statusCode).toBe(200);
    result = { kind: 'replayed', shipment: meta(false) };
    expect((await createHandler(ev({ synthetic: true }))).statusCode).toBe(422);
  });
  test('POST rejections: scope, key, body, synthetic field, departure window, non-SIMV vessel for synthetic callers', async () => {
    expect((await createHandler(ev({ scopes: ['brewline/admin'] }))).statusCode).toBe(403);
    expect((await createHandler(ev({ scopes: ['brewline/orders.write'] }))).statusCode).toBe(403);
    expect((await createHandler(ev({ key: null }))).statusCode).toBe(400);
    expect((await createHandler(ev({ body: { ...body, synthetic: true } }))).statusCode).toBe(400);
    expect((await createHandler(ev({ body: { ...body, planned_departure: '2026-11-19T00:00:00Z', planned_arrival: '2026-11-30T00:00:00Z' } }))).statusCode).toBe(400);
    expect((await createHandler(ev({ body: { ...body, planned_departure: '2027-04-01T00:00:00Z', planned_arrival: '2027-04-20T00:00:00Z' } }))).statusCode).toBe(400);
    const r = await createHandler(ev({ synthetic: true, body: { ...body, vessel_id: 'IMO9999999' } }));
    expect(JSON.parse(r.body as string).error.code).toBe('invalid_vessel');
    expect(calls).toHaveLength(0);
  });
  test('GET by id: 200 with events; synthetic callers get 404 for real shipments; bad id 400', async () => {
    stored = [meta(false)];
    expect((await getHandler(ev({ scopes: ['brewline/admin'] }))).statusCode).toBe(200);
    expect((await getHandler(ev({ synthetic: true }))).statusCode).toBe(404);
    stored = [meta(true)];
    const r = await getHandler(ev({ synthetic: true }));
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body as string)).toMatchObject({ events: [], track: [] });
    expect((await getHandler(ev({ id: 'r_123' }))).statusCode).toBe(400);
    expect((await getHandler(ev({ scopes: ['brewline/catalog.read'] }))).statusCode).toBe(403);
  });
  test('GET list: lot required, limit 1–50, synthetic callers see synthetic only', async () => {
    stored = [meta(false), meta(true)];
    let r = await listHandler(ev({ query: { lot: 'L-2026-001' }, synthetic: true }));
    expect(JSON.parse(r.body as string).items).toHaveLength(1);
    r = await listHandler(ev({ query: { lot: 'L-2026-001' }, scopes: ['brewline/admin'] }));
    expect(JSON.parse(r.body as string).items).toHaveLength(2);
    expect((await listHandler(ev({}))).statusCode).toBe(400);
    expect((await listHandler(ev({ query: { lot: 'L-2026-001', limit: '51' } }))).statusCode).toBe(400);
  });
  test('DTO carries no internal fields', () => {
    const dto = toAdminShipment(meta(true)) as Record<string, unknown>;
    for (const f of ['pk', 'sk', 'entity', 'request_hash', 'version', 'created_by', 'route_id']) expect(f in dto).toBe(false);
  });
});
