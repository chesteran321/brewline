import { Logger } from '@aws-lambda-powertools/logger';
import { Tracer } from '@aws-lambda-powertools/tracer';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { SCOPES } from '../../../identity/src/scopes';
import { claim, hasAnyScope, header, isSyntheticCaller, json, jsonBody, problem } from '../../../ordering/src/lib/http';
import { IdempotencyKeySchema } from '../../../ordering/src/lib/order-model';
import {
  CreateShipmentRequestSchema,
  LotIdSchema,
  MAX_BOOKING_AHEAD_DAYS,
  SIM_VESSEL_ID,
  ShipmentIdSchema,
  ShipmentItem,
  toAdminShipment,
} from '../model';
import { Caller, ShipmentRepo } from '../shipment-repo';

/**
 * 訂艙端點（P2b-1，ADR-032 補充 E3）。
 *   POST /admin/shipments           （roastery）建立貨運，Idempotency-Key 必填；POL／POD 由伺服器依批次決定
 *   GET  /admin/shipments?lot=<id>  （admin 或 roastery）該批次的貨運
 *   GET  /admin/shipments/{id}      （admin 或 roastery）貨運＋DCSA 運輸事件＋航跡
 * 帶 synthetic 的呼叫者（模擬烘焙廠）只能建立、看到模擬貨運（S2a 的保護方式）。
 * Booking endpoints. Synthetic callers (the simulated roastery) only create and see synthetic shipments.
 *
 * 日誌只記 ID 與結果，不記訂艙號、貨櫃號（E10）/ Logs carry ids and outcomes, never booking or container numbers.
 */

export const logger = new Logger();
const tracer = new Tracer();
let repo: ShipmentRepo | undefined;

function shipments(): ShipmentRepo {
  if (repo) return repo;
  const table = process.env.TABLE_NAME;
  if (!table) throw new Error('Missing environment variable TABLE_NAME');
  repo = new ShipmentRepo(
    DynamoDBDocumentClient.from(tracer.captureAWSv3Client(new DynamoDBClient({})), { marshallOptions: { removeUndefinedValues: true } }),
    table,
  );
  return repo;
}

/** 測試用 / For tests. */
export function setShipmentRepoForTesting(r: ShipmentRepo | undefined): void {
  repo = r;
}

let clock = () => new Date();
export function setClockForTesting(now: (() => Date) | undefined): void {
  clock = now ?? (() => new Date());
}

const DAY_MS = 86_400_000;
const staffOrRoastery = [SCOPES.admin, SCOPES.roastery];

function caller(event: APIGatewayProxyEventV2WithJWTAuthorizer): Caller | undefined {
  const sub = claim(event, 'sub');
  if (!sub) return undefined;
  return { actor: `${hasAnyScope(event, [SCOPES.admin]) ? 'staff' : 'roastery'}:${sub}`, synthetic: isSyntheticCaller(event) };
}

/** 模擬呼叫者看不到真實貨運（回 404，不透露存在）/ Synthetic callers never see real shipments (404). */
const visible = (s: ShipmentItem, who: Caller) => !who.synthetic || s.synthetic === true;

const fail = (op: string, err: unknown) => {
  logger.error(`${op} failed`, { error: (err as Error).name, message: (err as Error).message });
  return problem(500, 'internal_error', 'Unexpected error');
};

export const createHandler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyStructuredResultV2> => {
  if (!hasAnyScope(event, [SCOPES.roastery])) return problem(403, 'forbidden', 'Missing required scope');
  const who = caller(event);
  if (!who) return problem(403, 'forbidden', 'Missing subject');
  const key = IdempotencyKeySchema.safeParse(header(event, 'Idempotency-Key'));
  if (!key.success) return problem(400, 'missing_idempotency_key', 'Idempotency-Key header (16-64 URL-safe characters) is required');
  const body = CreateShipmentRequestSchema.safeParse(jsonBody(event, 4 * 1024));
  if (!body.success) {
    return problem(400, 'invalid_request', 'Body must be {lot_id, planned_departure, planned_arrival, carrier_voyage_number, vessel_id, vessel_name}');
  }
  const now = clock();
  const dep = Date.parse(body.data.planned_departure);
  if (dep < now.getTime() - DAY_MS || dep > now.getTime() + MAX_BOOKING_AHEAD_DAYS * DAY_MS) {
    return problem(400, 'invalid_departure', `planned_departure must be between yesterday and ${MAX_BOOKING_AHEAD_DAYS} days ahead`);
  }
  // 模擬貨運一律用虛構船 SIMV-nn（E10）/ Synthetic shipments always use fictional SIMV-nn vessels.
  if (who.synthetic && !SIM_VESSEL_ID.test(body.data.vessel_id)) {
    return problem(400, 'invalid_vessel', 'Synthetic shipments must use a SIMV-nn vessel id');
  }
  try {
    const r = await shipments().createShipment(body.data, key.data, who, now);
    logger.info('create shipment', { outcome: r.kind, lot_id: body.data.lot_id, actor: who.actor, synthetic: who.synthetic });
    switch (r.kind) {
      case 'created':
        return json(201, toAdminShipment(r.shipment));
      case 'replayed':
        return visible(r.shipment, who) ? json(200, toAdminShipment(r.shipment)) : problem(422, 'idempotency_key_reused', 'This Idempotency-Key was used with a different request');
      case 'key_conflict':
        return problem(422, 'idempotency_key_reused', 'This Idempotency-Key was used with a different request');
      case 'lot_not_found':
        return problem(400, 'lot_not_found', 'Unknown lot');
      case 'no_sea_route':
        return problem(400, 'no_sea_route', 'This lot has no sea leg (domestic lot)');
      case 'conflict':
        return problem(409, 'conflict', 'The shipment changed meanwhile; retry with the same Idempotency-Key');
      case 'busy':
        return problem(503, 'try_again', 'The service is busy; retry with the same Idempotency-Key');
    }
  } catch (err) {
    return fail('create shipment', err);
  }
};

export const getHandler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyStructuredResultV2> => {
  if (!hasAnyScope(event, staffOrRoastery)) return problem(403, 'forbidden', 'Missing required scope');
  const who = caller(event);
  if (!who) return problem(403, 'forbidden', 'Missing subject');
  const id = ShipmentIdSchema.safeParse(event.pathParameters?.id);
  if (!id.success) return problem(400, 'invalid_path', 'Shipment id must look like sh_<26>');
  try {
    const d = await shipments().getDetail(id.data);
    if (!d || !visible(d.shipment, who)) return problem(404, 'not_found', 'Shipment not found');
    return json(200, { ...toAdminShipment(d.shipment), events: d.events, track: d.track });
  } catch (err) {
    return fail('get shipment', err);
  }
};

export const listHandler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyStructuredResultV2> => {
  if (!hasAnyScope(event, staffOrRoastery)) return problem(403, 'forbidden', 'Missing required scope');
  const who = caller(event);
  if (!who) return problem(403, 'forbidden', 'Missing subject');
  const lot = LotIdSchema.safeParse(event.queryStringParameters?.lot);
  if (!lot.success) return problem(400, 'invalid_query', 'Query parameter lot=L-YYYY-NNN is required');
  const rawLimit = event.queryStringParameters?.limit;
  const limit = rawLimit === undefined ? 20 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) return problem(400, 'invalid_query', 'limit must be 1-50');
  try {
    const items = (await shipments().listByLot(lot.data, limit)).filter((s) => visible(s, who));
    return json(200, { items: items.map(toAdminShipment) });
  } catch (err) {
    return fail('list shipments', err);
  }
};
