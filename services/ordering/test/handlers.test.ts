import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { handler as getStock } from '../src/handlers/get-product-stock';
import { handler as getProduct } from '../src/handlers/get-product';
import { handler as listProducts } from '../src/handlers/list-products';
import type { CatalogRepo } from '../src/lib/catalog-repo';
import type { ProductMetaItem, StockItem } from '../src/lib/model';
import { setCatalogRepoForTesting } from '../src/lib/runtime';

const meta = (id: string): ProductMetaItem => ({
  pk: `PRODUCT#${id}`,
  sk: 'META',
  entity: 'Product',
  status: 'active',
  id,
  name: id,
  name_zh: id,
  origin_country: 'ET',
  region: 'Guji',
  process: 'natural',
  variety: 'Landrace',
  altitude_m: 2000,
  cup_score: 87,
  roast_level: 'light',
  flavor_notes: ['berry'],
  price_per_kg: 1000,
  currency: 'TWD',
  lot_id: 'L-2026-001',
});
const stock = (id: string, kg: number): StockItem => ({
  pk: `PRODUCT#${id}`,
  sk: 'STOCK',
  available_kg: kg,
  reserved_kg: 0,
  low_threshold_kg: 5,
  version: 1,
});

const fakeRepo = {
  listActiveProducts: async () => [meta('p-0002'), meta('p-0001')],
  getStocks: async () => new Map([['p-0001', stock('p-0001', 50)]]),
  getProductWithStock: async (id: string) => (id === 'p-0001' ? { meta: meta(id), stock: stock(id, 3) } : {}),
  getStock: async (id: string) => (id === 'p-0001' ? stock(id, 50) : undefined),
} as unknown as CatalogRepo;

function event(scopes: string[], id?: string): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    pathParameters: id === undefined ? undefined : { id },
    requestContext: { authorizer: { jwt: { claims: { scope: scopes.join(' ') }, scopes } } },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

const parse = (r: { body?: string }) => JSON.parse(r.body ?? '{}');

beforeAll(() => setCatalogRepoForTesting(fakeRepo));
afterAll(() => setCatalogRepoForTesting(undefined));

describe('GET /products', () => {
  test('200, sorted, stock_status only', async () => {
    const r = await listProducts(event(['brewline/catalog.read']));
    expect(r.statusCode).toBe(200);
    const body = parse(r);
    expect(body.items.map((i: { id: string }) => i.id)).toEqual(['p-0001', 'p-0002']);
    expect(body.items[0].stock_status).toBe('in_stock');
    expect(body.items[1].stock_status).toBe('out'); // 沒有 STOCK 項目 / no stock item
    expect(r.headers?.['cache-control']).toBe('no-store');
  });

  // 縱深防禦：就算路由設定被改壞，handler 也拒絕 / Defense in depth.
  test('403 without the catalog scope', async () => {
    expect((await listProducts(event(['aws.cognito.signin.user.admin']))).statusCode).toBe(403);
  });
});

describe('GET /products/{id}', () => {
  test('200 with low stock status', async () => {
    const r = await getProduct(event(['brewline/catalog.read'], 'p-0001'));
    expect(r.statusCode).toBe(200);
    expect(parse(r)).toMatchObject({ id: 'p-0001', stock_status: 'low' });
    expect(parse(r)).not.toHaveProperty('available_kg');
  });
  test('404 for an unknown product', async () => {
    expect((await getProduct(event(['brewline/catalog.read'], 'p-9999'))).statusCode).toBe(404);
  });
  test.each(['../x', 'DROP-TABLE', ''])('400 for invalid id %j', async (id) => {
    expect((await getProduct(event(['brewline/catalog.read'], id))).statusCode).toBe(400);
  });
});

describe('GET /admin/products/{id}/stock', () => {
  test('200 with kilograms for staff', async () => {
    const r = await getStock(event(['brewline/admin', 'brewline/catalog.read'], 'p-0001'));
    expect(r.statusCode).toBe(200);
    expect(parse(r)).toMatchObject({ product_id: 'p-0001', available_kg: 50 });
  });
  test('403 with only the catalog scope (café)', async () => {
    expect((await getStock(event(['brewline/catalog.read'], 'p-0001'))).statusCode).toBe(403);
  });
  test('404 when no stock item exists', async () => {
    expect((await getStock(event(['brewline/admin'], 'p-0002'))).statusCode).toBe(404);
  });
});

describe('errors', () => {
  test('500 with a generic message when the repo throws', async () => {
    setCatalogRepoForTesting({ listActiveProducts: async () => { throw new Error('boom: secret detail'); } } as unknown as CatalogRepo);
    const r = await listProducts(event(['brewline/catalog.read']));
    expect(r.statusCode).toBe(500);
    expect(r.body).not.toContain('secret detail');
    setCatalogRepoForTesting(fakeRepo);
  });
});
