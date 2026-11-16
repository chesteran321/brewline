import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { SCOPES } from '../../../identity/src/scopes';
import { claim, hasScope, json, jsonBody, problem } from '../lib/http';
import { MAX_BODY_BYTES, MAX_LINES, MAX_QTY_KG, MIN_QTY_KG, TenantIdSchema } from '../lib/order-model';
import {
  CreateReplenishmentSchema,
  MAX_REPLENISHMENTS_PER_TENANT,
  ReplenishmentIdSchema,
  newReplenishmentItem,
  toPublicReplenishment,
} from '../lib/replenishment-model';
import { logger, orderRepo, replenishmentRepo, replenishmentScheduler } from '../lib/runtime';
import { ulid } from '../lib/ulid';

/**
 * 定期補貨 API（A4e，ADR-029 D6，F1 A：沿用 orders.read／orders.write）。
 * Replenishment API (reuses the orders scopes).
 *
 * POST   /replenishments        201｜400 輸入／商品｜403｜409 已達 5 筆
 * GET    /replenishments        200（有效的訂閱）
 * DELETE /replenishments/{id}   204（冪等：不存在也回 204）
 *
 * F2 A：DynamoDB 是正本，API 同步建立排程；建立排程失敗 → 把 DynamoDB 那筆軟刪除（補償），回 500。
 * DynamoDB is the source of truth; the schedule is created synchronously, and a failure is compensated.
 */

type Event = APIGatewayProxyEventV2WithJWTAuthorizer;
type Result = APIGatewayProxyStructuredResultV2;

function caller(event: Event, scope: string): { tenantId: string; sub: string } | Result {
  if (!hasScope(event, scope)) return problem(403, 'forbidden', 'Missing required scope');
  const tenant = TenantIdSchema.safeParse(claim(event, 'tenant_id'));
  const sub = claim(event, 'sub');
  if (!tenant.success || !sub) return problem(403, 'no_tenant', 'The caller does not belong to a tenant');
  return { tenantId: tenant.data, sub };
}
const isResult = (v: unknown): v is Result => typeof v === 'object' && v !== null && 'statusCode' in v;

export const createHandler = async (event: Event): Promise<Result> => {
  const c = caller(event, SCOPES.ordersWrite);
  if (isResult(c)) return c;
  const req = CreateReplenishmentSchema.safeParse(jsonBody(event, MAX_BODY_BYTES));
  if (!req.success) {
    return problem(400, 'invalid_request', 'Request body is invalid', {
      issues: req.error.issues.slice(0, 10).map((i) => ({ path: i.path.join('.'), message: i.message })),
      limits: { max_lines: MAX_LINES, min_qty_kg: MIN_QTY_KG, max_qty_kg: MAX_QTY_KG, day_of_month: '1-28' },
    });
  }
  const log = { tenant_id: c.tenantId, frequency: req.data.frequency };
  const repo = replenishmentRepo();
  try {
    const unknown = await orderRepo().unknownProducts(c.tenantId, req.data.items.map((i) => i.product_id));
    if (unknown.length > 0) return problem(400, 'unknown_products', 'Some products do not exist or are not available', { product_ids: unknown });
    // 上限檢查（兩個請求同時建立可能多 1 筆；作品集規模可接受，ADR-029 D6）
    // Limit check; two simultaneous creates could exceed it by one (accepted at portfolio scale).
    const active = await repo.listActive(c.tenantId);
    if (active.length >= MAX_REPLENISHMENTS_PER_TENANT) {
      return problem(409, 'limit_reached', `At most ${MAX_REPLENISHMENTS_PER_TENANT} replenishments per tenant`);
    }
    const now = new Date();
    const item = newReplenishmentItem(c.tenantId, `r_${ulid()}`, req.data, c.sub, now);
    await repo.put(item);
    try {
      await replenishmentScheduler().create(item);
    } catch (err) {
      // 補償：排程沒建成 → 這筆補貨作廢 / Compensate: no schedule → the subscription is void.
      await repo.markDeleted(item, new Date()).catch((e: Error) => logger.error('compensation failed', { ...log, error: e.name }));
      logger.error('create schedule failed', { ...log, replenishment_id: item.replenishment_id, error: (err as Error).name });
      return problem(500, 'internal_error', 'Unexpected error');
    }
    logger.info('replenishment created', { ...log, replenishment_id: item.replenishment_id });
    return json(201, toPublicReplenishment(item));
  } catch (err) {
    logger.error('create-replenishment failed', { ...log, error: (err as Error).name });
    return problem(500, 'internal_error', 'Unexpected error');
  }
};

export const listHandler = async (event: Event): Promise<Result> => {
  const c = caller(event, SCOPES.ordersRead);
  if (isResult(c)) return c;
  try {
    const items = await replenishmentRepo().listActive(c.tenantId);
    return json(200, { items: items.map(toPublicReplenishment), limit: MAX_REPLENISHMENTS_PER_TENANT });
  } catch (err) {
    logger.error('list-replenishments failed', { tenant_id: c.tenantId, error: (err as Error).name });
    return problem(500, 'internal_error', 'Unexpected error');
  }
};

export const deleteHandler = async (event: Event): Promise<Result> => {
  const c = caller(event, SCOPES.ordersWrite);
  if (isResult(c)) return c;
  const id = ReplenishmentIdSchema.safeParse(event.pathParameters?.id);
  if (!id.success) return problem(400, 'invalid_replenishment_id', 'Replenishment id must look like r_<26 characters>');
  try {
    // 只讀得到自己租戶的（租戶憑證）→ 別人的 ID 一律當作不存在 / Other tenants' ids simply do not exist here.
    const item = await replenishmentRepo().get(c.tenantId, id.data);
    if (item && item.status === 'active') {
      // 先作廢再刪排程：就算刪排程失敗，補貨函數看到 deleted 也不會下單
      // Void first, then delete the schedule: even if that fails, the function sees "deleted" and does nothing.
      await replenishmentRepo().markDeleted(item, new Date());
      await replenishmentScheduler().delete(item);
      logger.info('replenishment deleted', { tenant_id: c.tenantId, replenishment_id: id.data });
    }
    return { statusCode: 204, headers: { 'cache-control': 'no-store' } };
  } catch (err) {
    logger.error('delete-replenishment failed', { tenant_id: c.tenantId, error: (err as Error).name });
    return problem(500, 'internal_error', 'Unexpected error');
  }
};
