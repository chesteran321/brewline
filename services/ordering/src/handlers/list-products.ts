import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { SCOPES } from '../../../identity/src/scopes';
import { hasScope, json, problem } from '../lib/http';
import { toPublicProduct } from '../lib/model';
import { catalogRepo, logger } from '../lib/runtime';

/** GET /products — 商品列表（cafe、staff；scope brewline/catalog.read）/ List active products. */
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyStructuredResultV2> => {
  if (!hasScope(event, SCOPES.catalogRead)) return problem(403, 'forbidden', 'Missing required scope');
  try {
    const repo = catalogRepo();
    const metas = await repo.listActiveProducts();
    const stocks = await repo.getStocks(metas.map((m) => m.id));
    const items = metas.map((m) => toPublicProduct(m, stocks.get(m.id))).sort((a, b) => a.id.localeCompare(b.id));
    return json(200, { items, count: items.length });
  } catch (err) {
    logger.error('list-products failed', err as Error);
    return problem(500, 'internal_error', 'Unexpected error');
  }
};
