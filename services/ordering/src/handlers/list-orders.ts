import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { z } from 'zod';
import { SCOPES } from '../../../identity/src/scopes';
import { claim, hasScope, json, problem } from '../lib/http';
import { TenantIdSchema, decodeCursor, encodeCursor, toPublicOrder } from '../lib/order-model';
import { logger, orderRepo } from '../lib/runtime';

const QuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  next_token: z.string().max(200).optional(),
});

/** GET /orders — 自己租戶的訂單，新的在前，分頁 / Own tenant's orders, newest first, paginated. */
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyStructuredResultV2> => {
  if (!hasScope(event, SCOPES.ordersRead)) return problem(403, 'forbidden', 'Missing required scope');
  const tenant = TenantIdSchema.safeParse(claim(event, 'tenant_id'));
  if (!tenant.success) return problem(403, 'no_tenant', 'The caller does not belong to a tenant');

  const q = QuerySchema.safeParse(event.queryStringParameters ?? {});
  if (!q.success) return problem(400, 'invalid_query', 'limit must be 1-50; only limit and next_token are allowed');
  let afterSk: string | undefined;
  if (q.data.next_token !== undefined) {
    afterSk = decodeCursor(q.data.next_token);
    if (!afterSk) return problem(400, 'invalid_next_token', 'next_token is invalid');
  }
  try {
    const page = await orderRepo().listOrders(tenant.data, q.data.limit, afterSk);
    return json(200, {
      items: page.orders.map(toPublicOrder),
      ...(page.lastSk ? { next_token: encodeCursor(page.lastSk) } : {}),
    });
  } catch (err) {
    const name = (err as Error).name;
    logger.error(name === 'AccessDeniedException' ? 'tenant_access_denied' : 'list-orders failed', {
      tenant_id: tenant.data,
      error: name,
    });
    return problem(500, 'internal_error', 'Unexpected error');
  }
};
