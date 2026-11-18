import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { SCOPES } from '../../../identity/src/scopes';
import { claim, hasAnyScope, header, isSyntheticCaller, json, jsonBody, problem } from '../lib/http';
import { IdempotencyKeySchema } from '../lib/order-model';
import { logger, traceRepo } from '../lib/runtime';
import { CreateRoastRequestSchema, PatchRoastRequestSchema, RecallRequestSchema, RoastIdSchema, toAdminRoast } from '../lib/trace-model';
import { Caller, RoastUpdateResult } from '../lib/trace-repo';

/**
 * 烘焙批次端點（S2a，ADR-031 D5／D6／D9）。
 *   POST  /admin/roasts                 （roastery）建立批次並分配訂單，Idempotency-Key 必填
 *   PATCH /admin/roasts/{id}            （roastery）{"status":"ROASTED"} → 產生 QR token
 *   POST  /admin/roasts/{id}/recall     （admin）   {"notice":"..."} → 公開頁顯示召回提醒
 * Roast batch endpoints.
 */

function caller(event: APIGatewayProxyEventV2WithJWTAuthorizer): Caller | undefined {
  const sub = claim(event, 'sub');
  if (!sub) return undefined;
  const isStaff = hasAnyScope(event, [SCOPES.admin]);
  return { actor: `${isStaff ? 'staff' : 'roastery'}:${sub}`, synthetic: isSyntheticCaller(event) };
}

const fail = (op: string, err: unknown) => {
  logger.error(`${op} failed`, { error: (err as Error).name, message: (err as Error).message });
  return problem(500, 'internal_error', 'Unexpected error');
};

function roastResult(r: RoastUpdateResult): APIGatewayProxyStructuredResultV2 {
  switch (r.kind) {
    case 'updated':
      return json(200, toAdminRoast(r.roast));
    case 'not_found':
      return problem(404, 'not_found', 'Roast batch not found');
    case 'invalid_state':
      return problem(409, 'invalid_state', `Roast batch is ${r.status}`, { current_status: r.status });
    case 'already_recalled':
      return problem(409, 'already_recalled', 'Roast batch is already recalled');
    case 'forbidden':
      return problem(404, 'not_found', 'Roast batch not found');
  }
}

export const createHandler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyStructuredResultV2> => {
  if (!hasAnyScope(event, [SCOPES.roastery])) return problem(403, 'forbidden', 'Missing required scope');
  const who = caller(event);
  if (!who) return problem(403, 'forbidden', 'Missing subject');
  const key = IdempotencyKeySchema.safeParse(header(event, 'Idempotency-Key'));
  if (!key.success) return problem(400, 'missing_idempotency_key', 'Idempotency-Key header (16-64 URL-safe characters) is required');
  const body = CreateRoastRequestSchema.safeParse(jsonBody(event, 8 * 1024));
  if (!body.success) {
    return problem(400, 'invalid_request', 'Body must be {product_id, roast_date, kg (1-15), allocations:[{tenant_id, order_id, kg}]} with allocations ≤ kg');
  }
  try {
    const r = await traceRepo().createRoast(body.data, key.data, who, new Date());
    logger.info('create roast', { outcome: r.kind, product_id: body.data.product_id, allocations: body.data.allocations.length, actor: who.actor, synthetic: who.synthetic });
    switch (r.kind) {
      case 'created':
        return json(201, toAdminRoast(r.roast));
      case 'replayed':
        return json(200, toAdminRoast(r.roast));
      case 'key_conflict':
        return problem(422, 'idempotency_key_reused', 'This Idempotency-Key was used with a different request');
      case 'not_found':
        return problem(r.what === 'order' ? 404 : 409, `${r.what}_not_found`, `${r.what} not found`, { ref: r.ref });
      case 'invalid_state':
        return problem(409, 'order_not_scheduled', 'Orders are allocated only in ROASTING_SCHEDULED', { ref: r.ref, current_status: r.status });
      case 'product_mismatch':
        return problem(409, 'product_mismatch', 'The order has no line for this product', { ref: r.ref });
      case 'over_allocated':
        return problem(409, 'over_allocated', 'Allocation exceeds the remaining kilograms of the line', { ref: r.ref, remaining_kg: r.remaining_kg });
      case 'synthetic_mismatch':
        return problem(403, 'synthetic_only', 'Synthetic batches take synthetic orders only, and real batches real orders only', { ref: r.ref });
      case 'conflict':
        return problem(409, 'conflict', 'An order changed meanwhile; read it again and retry');
      case 'busy':
        return problem(503, 'try_again', 'The service is busy; retry with the same Idempotency-Key');
    }
  } catch (err) {
    return fail('create roast', err);
  }
};

export const patchHandler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyStructuredResultV2> => {
  if (!hasAnyScope(event, [SCOPES.roastery])) return problem(403, 'forbidden', 'Missing required scope');
  const who = caller(event);
  if (!who) return problem(403, 'forbidden', 'Missing subject');
  const id = RoastIdSchema.safeParse(event.pathParameters?.id);
  if (!id.success) return problem(400, 'invalid_path', 'Roast id must look like r_<26>');
  if (!PatchRoastRequestSchema.safeParse(jsonBody(event, 1024)).success) return problem(400, 'invalid_request', 'Body must be {"status":"ROASTED"}');
  try {
    const r = await traceRepo().markRoasted(id.data, who, new Date());
    logger.info('roast roasted', { roast_id: id.data, outcome: r.kind, actor: who.actor, synthetic: who.synthetic });
    return roastResult(r);
  } catch (err) {
    return fail('patch roast', err);
  }
};

export const recallHandler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyStructuredResultV2> => {
  // 召回影響公開頁與咖啡廳，只有 staff（admin）可以 / Recall affects the public page and cafés: staff only.
  if (!hasAnyScope(event, [SCOPES.admin])) return problem(403, 'forbidden', 'Missing required scope');
  const who = caller(event);
  if (!who) return problem(403, 'forbidden', 'Missing subject');
  const id = RoastIdSchema.safeParse(event.pathParameters?.id);
  if (!id.success) return problem(400, 'invalid_path', 'Roast id must look like r_<26>');
  const body = RecallRequestSchema.safeParse(jsonBody(event, 2048));
  if (!body.success) return problem(400, 'invalid_request', 'Body must be {"notice": "5-200 characters, no < or >"}');
  try {
    const r = await traceRepo().recall(id.data, body.data.notice, who, new Date());
    logger.info('roast recall', { roast_id: id.data, outcome: r.kind, actor: who.actor });
    return roastResult(r);
  } catch (err) {
    return fail('recall roast', err);
  }
};
