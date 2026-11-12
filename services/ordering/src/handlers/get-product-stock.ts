import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { SCOPES } from '../../../identity/src/scopes';
import { hasScope, json, problem } from '../lib/http';
import { ProductIdSchema, toAdminStock } from '../lib/model';
import { catalogRepo, logger } from '../lib/runtime';

/** GET /admin/products/{id}/stock — 庫存明細（只有 staff；scope brewline/admin）/ Stock detail, staff only. */
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyStructuredResultV2> => {
  if (!hasScope(event, SCOPES.admin)) return problem(403, 'forbidden', 'Missing required scope');
  const id = ProductIdSchema.safeParse(event.pathParameters?.id);
  if (!id.success) return problem(400, 'invalid_product_id', 'Product id must look like p-0001');
  try {
    const stock = await catalogRepo().getStock(id.data);
    if (!stock) return problem(404, 'not_found', 'Stock not found');
    return json(200, toAdminStock(id.data, stock));
  } catch (err) {
    logger.error('get-product-stock failed', err as Error);
    return problem(500, 'internal_error', 'Unexpected error');
  }
};
