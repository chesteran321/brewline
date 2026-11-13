import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { SCOPES } from '../../../identity/src/scopes';
import { claim, hasScope, json, problem } from '../lib/http';
import { OrderIdSchema, TenantIdSchema, toPublicOrder } from '../lib/order-model';
import { logger, orderRepo } from '../lib/runtime';

/**
 * GET /orders/{id} — 自己租戶的訂單明細。別的租戶的訂單 → 404（不透露是否存在）。
 * Own tenant's order. Another tenant's order → 404 (existence is not revealed).
 */
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyStructuredResultV2> => {
  if (!hasScope(event, SCOPES.ordersRead)) return problem(403, 'forbidden', 'Missing required scope');
  const tenant = TenantIdSchema.safeParse(claim(event, 'tenant_id'));
  if (!tenant.success) return problem(403, 'no_tenant', 'The caller does not belong to a tenant');
  const id = OrderIdSchema.safeParse(event.pathParameters?.id);
  if (!id.success) return problem(400, 'invalid_order_id', 'Order id must look like o_<26 characters>');
  try {
    const order = await orderRepo().getOrder(tenant.data, id.data);
    if (!order) return problem(404, 'not_found', 'Order not found');
    return json(200, toPublicOrder(order));
  } catch (err) {
    const name = (err as Error).name;
    logger.error(name === 'AccessDeniedException' ? 'tenant_access_denied' : 'get-order failed', {
      tenant_id: tenant.data,
      error: name,
    });
    return problem(500, 'internal_error', 'Unexpected error');
  }
};
