import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { SCOPES } from '../../../identity/src/scopes';
import { claim, hasAnyScope, isSyntheticCaller, json, jsonBody, problem } from '../lib/http';
import { ProductIdSchema, toAdminStock } from '../lib/model';
import { logger, traceRepo } from '../lib/runtime';
import { RestockRequestSchema } from '../lib/trace-model';

/**
 * POST /admin/products/{id}/restock — 補貨（roastery，S2a，ADR-031 D7）。
 * {"kg": 1-500, "expected_version": <GET /admin/products/{id}/stock 的 version>}；版本不符 → 409（重送不會重複補貨）。
 * Restock with an optimistic lock: a stale or replayed request gets 409 instead of adding twice.
 */
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyStructuredResultV2> => {
  if (!hasAnyScope(event, [SCOPES.roastery])) return problem(403, 'forbidden', 'Missing required scope');
  const id = ProductIdSchema.safeParse(event.pathParameters?.id);
  if (!id.success) return problem(400, 'invalid_product_id', 'Product id must look like p-0001');
  const body = RestockRequestSchema.safeParse(jsonBody(event, 1024));
  if (!body.success) return problem(400, 'invalid_request', 'Body must be {"kg": 1-500, "expected_version": <int>}');
  try {
    const r = await traceRepo().restock(id.data, body.data.kg, body.data.expected_version, new Date());
    logger.info('restock', { product_id: id.data, kg: body.data.kg, outcome: r.kind, sub: claim(event, 'sub'), synthetic: isSyntheticCaller(event) });
    switch (r.kind) {
      case 'updated':
        return json(200, toAdminStock(id.data, r.stock));
      case 'not_found':
        return problem(404, 'not_found', 'Stock not found');
      case 'version_conflict':
        return problem(409, 'version_conflict', 'Stock changed meanwhile; read it again', { current_version: r.current_version });
      case 'over_cap':
        return problem(409, 'over_cap', 'Restock would exceed the maximum available stock', { max_available_kg: r.max_available_kg });
    }
  } catch (err) {
    logger.error('restock failed', { error: (err as Error).name, message: (err as Error).message });
    return problem(500, 'internal_error', 'Unexpected error');
  }
};
