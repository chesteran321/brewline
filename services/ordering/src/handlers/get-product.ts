import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { SCOPES } from '../../../identity/src/scopes';
import { hasScope, json, problem } from '../lib/http';
import { ProductIdSchema, toPublicProduct } from '../lib/model';
import { catalogRepo, logger } from '../lib/runtime';

/** GET /products/{id} — 商品明細（cafe、staff）/ Product detail. */
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyStructuredResultV2> => {
  if (!hasScope(event, SCOPES.catalogRead)) return problem(403, 'forbidden', 'Missing required scope');
  const id = ProductIdSchema.safeParse(event.pathParameters?.id);
  if (!id.success) return problem(400, 'invalid_product_id', 'Product id must look like p-0001');
  try {
    const { meta, stock } = await catalogRepo().getProductWithStock(id.data);
    if (!meta) return problem(404, 'not_found', 'Product not found');
    return json(200, toPublicProduct(meta, stock));
  } catch (err) {
    logger.error('get-product failed', err as Error);
    return problem(500, 'internal_error', 'Unexpected error');
  }
};
