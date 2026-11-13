import { loadSeed } from '../src/custom-resources/seed-catalog';
import { ProductIdSchema, ProductMetaItem, StockItem, stockStatus, toAdminStock, toPublicProduct } from '../src/lib/model';
import { TENANT_ID_PATTERN } from '../../identity/src/scopes';

const stock = (available: number, threshold = 10): StockItem => ({
  pk: 'PRODUCT#p-0001',
  sk: 'STOCK',
  available_kg: available,
  reserved_kg: 3,
  low_threshold_kg: threshold,
  version: 2,
});

const meta: ProductMetaItem = {
  pk: 'PRODUCT#p-0001',
  sk: 'META',
  entity: 'Product',
  status: 'active',
  id: 'p-0001',
  name: 'Test',
  name_zh: '測試',
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
};

describe('stockStatus', () => {
  test.each([
    [undefined, 'out'],
    [stock(0), 'out'],
    [stock(10), 'low'],
    [stock(11), 'in_stock'],
  ] as const)('%j → %s', (s, want) => expect(stockStatus(s)).toBe(want));
});

describe('toPublicProduct (SEC-022 allow-list)', () => {
  test('never exposes keys, kilograms or version', () => {
    const dto = toPublicProduct({ ...meta, gsi1pk: 'CATALOG', secret: 'x' } as unknown as ProductMetaItem, stock(50));
    for (const f of ['pk', 'sk', 'gsi1pk', 'entity', 'status', 'available_kg', 'reserved_kg', 'version', 'secret']) {
      expect(dto).not.toHaveProperty(f);
    }
    expect(dto.stock_status).toBe('in_stock');
  });
});

describe('toAdminStock', () => {
  test('includes kilograms for staff', () => {
    expect(toAdminStock('p-0001', stock(50))).toEqual({
      product_id: 'p-0001',
      available_kg: 50,
      reserved_kg: 3,
      low_threshold_kg: 10,
      version: 2,
      stock_status: 'in_stock',
    });
  });
});

describe('ProductIdSchema', () => {
  test.each(['p-0001', 'p-9999'])('accepts %s', (v) => expect(ProductIdSchema.safeParse(v).success).toBe(true));
  test.each(['P-0001', 'p-1', 'p-00001', '../x', 'DROP-TABLE', '', 'p-0001 '])('rejects %j', (v) =>
    expect(ProductIdSchema.safeParse(v).success).toBe(false),
  );
});

describe('seed/products.json', () => {
  test('is valid and has unique ids', () => {
    const products = loadSeed();
    expect(products.length).toBeGreaterThanOrEqual(8);
    expect(products.find((p) => p.id === 'p-0001')).toBeDefined(); // smoke test uses p-0001
  });

  test('rejects duplicate ids', () => {
    const [first] = loadSeed();
    expect(() => loadSeed([first, first])).toThrow('Duplicate product id');
  });

  test('rejects unknown fields (strict) and bad values', () => {
    const [first] = loadSeed();
    expect(() => loadSeed([{ ...first, supplier_email: 'x@example.com' }])).toThrow();
    expect(() => loadSeed([{ ...first, initial_stock_kg: 1.5 }])).toThrow();
    expect(() => loadSeed([{ ...first, currency: 'USD' }])).toThrow();
  });
});

describe('smoke test tenant id', () => {
  test('matches the production tenant format', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(require.resolve('../src/custom-resources/smoke-test.ts'), 'utf8'),
    );
    const m = /const TENANT_ID = '([^']+)'/.exec(src);
    expect(m && TENANT_ID_PATTERN.test(m[1]!)).toBe(true);
  });
});
