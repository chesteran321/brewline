import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { z } from 'zod';
import { SCOPES } from '../../../identity/src/scopes';
import { claim, hasScope, json, jsonBody, problem } from '../lib/http';
import { TRANSITIONS } from '../lib/order-lifecycle';
import {
  OrderIdSchema,
  OrderStatusSchema,
  TenantIdSchema,
  decodeAdminCursor,
  encodeAdminCursor,
  toAdminOrder,
} from '../lib/order-model';
import { adminOrderRepo, logger } from '../lib/runtime';

/**
 * staff 訂單端點（scope brewline/admin，ORD-F-009，A3c，ADR-027）。
 *   GET   /admin/orders?status=CREATED                    → 各租戶該狀態的訂單（GSI1）
 *   GET   /admin/tenants/{tenantId}/orders/{orderId}      → 明細（含 status_history 與 tenant_id）
 *   PATCH /admin/tenants/{tenantId}/orders/{orderId}      → { "status": "<下一個狀態>" }
 * Staff order endpoints (scope brewline/admin).
 */

const ListQuery = z.strictObject({
  status: OrderStatusSchema.default('CREATED'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  next_token: z.string().max(400).optional(),
});
const PatchBody = z.strictObject({ status: OrderStatusSchema });

function pathIds(event: APIGatewayProxyEventV2WithJWTAuthorizer) {
  const tenant = TenantIdSchema.safeParse(event.pathParameters?.tenantId);
  const order = OrderIdSchema.safeParse(event.pathParameters?.orderId);
  return tenant.success && order.success ? { tenantId: tenant.data, orderId: order.data } : undefined;
}

const fail = (op: string, err: unknown) => {
  logger.error(`${op} failed`, { error: (err as Error).name, message: (err as Error).message });
  return problem(500, 'internal_error', 'Unexpected error');
};

export const listHandler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyStructuredResultV2> => {
  if (!hasScope(event, SCOPES.admin)) return problem(403, 'forbidden', 'Missing required scope');
  const q = ListQuery.safeParse(event.queryStringParameters ?? {});
  if (!q.success) return problem(400, 'invalid_query', 'status must be a known status; limit 1-50; only status, limit, next_token');
  let start: Record<string, string> | undefined;
  if (q.data.next_token !== undefined) {
    start = decodeAdminCursor(q.data.next_token, q.data.status);
    if (!start) return problem(400, 'invalid_next_token', 'next_token is invalid for this status');
  }
  try {
    const page = await adminOrderRepo().listByStatus(q.data.status, q.data.limit, start);
    return json(200, {
      items: page.orders.map(toAdminOrder),
      ...(page.last ? { next_token: encodeAdminCursor(page.last) } : {}),
    });
  } catch (err) {
    return fail('admin list-orders', err);
  }
};

export const getHandler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyStructuredResultV2> => {
  if (!hasScope(event, SCOPES.admin)) return problem(403, 'forbidden', 'Missing required scope');
  const ids = pathIds(event);
  if (!ids) return problem(400, 'invalid_path', 'tenantId must be t_<26>, orderId must be o_<26>');
  try {
    const order = await adminOrderRepo().get(ids.tenantId, ids.orderId);
    return order ? json(200, toAdminOrder(order)) : problem(404, 'not_found', 'Order not found');
  } catch (err) {
    return fail('admin get-order', err);
  }
};

export const patchHandler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyStructuredResultV2> => {
  if (!hasScope(event, SCOPES.admin)) return problem(403, 'forbidden', 'Missing required scope');
  const sub = claim(event, 'sub');
  if (!sub) return problem(403, 'forbidden', 'Missing subject');
  const ids = pathIds(event);
  if (!ids) return problem(400, 'invalid_path', 'tenantId must be t_<26>, orderId must be o_<26>');
  const body = PatchBody.safeParse(jsonBody(event, 1024));
  if (!body.success) return problem(400, 'invalid_request', 'Body must be {"status": "<order status>"}');

  try {
    const r = await adminOrderRepo().transition({ ...ids, to: body.data.status, actor: `staff:${sub}`, now: new Date() });
    // 稽核：誰在何時把哪張訂單改成什麼（A2 決策 D4 的應用層證據）/ Audit log line.
    logger.info('admin transition', { ...ids, to: body.data.status, outcome: r.kind, staff_sub: sub });
    switch (r.kind) {
      case 'updated':
        return json(200, toAdminOrder(r.order));
      case 'not_found':
        return problem(404, 'not_found', 'Order not found');
      case 'invalid_transition':
        return problem(409, 'invalid_transition', `Cannot change ${r.current} to ${body.data.status}`, {
          current_status: r.current,
          allowed: TRANSITIONS[r.current],
        });
      case 'conflict':
        return problem(409, 'conflict', 'The order changed meanwhile; read it again and retry');
      case 'busy':
        return problem(503, 'try_again', 'The service is busy; retry');
    }
  } catch (err) {
    return fail('admin patch-order', err);
  }
};
