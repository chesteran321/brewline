import { z } from 'zod';

/**
 * 商品目錄的資料模型（docs/03 §6、ADR-018 修訂）。
 * Catalog data model.
 *
 *   PRODUCT#<id> / META   商品資料（每次部署由種子覆寫）gsi1pk=CATALOG, gsi1sk=PRODUCT#<id>
 *   PRODUCT#<id> / STOCK  庫存（執行期狀態，種子只寫入一次）
 */

export const PRODUCT_PK_PREFIX = 'PRODUCT#';
export const CATALOG_GSI_PK = 'CATALOG';
export const META_SK = 'META';
export const STOCK_SK = 'STOCK';

/** 商品 ID：p-0001 格式。路徑參數一律先驗證（SEC-030）/ Validate path params first. */
export const ProductIdSchema = z.string().regex(/^p-\d{4}$/);

export const productPk = (id: string) => `${PRODUCT_PK_PREFIX}${id}`;

const ProcessSchema = z.enum(['washed', 'natural', 'honey', 'anaerobic', 'wet-hulled']);
const RoastSchema = z.enum(['light', 'medium-light', 'medium', 'medium-dark', 'dark']);

/** 種子檔中的一筆商品 / One product in seed/products.json. */
export const SeedProductSchema = z.strictObject({
  id: ProductIdSchema,
  name: z.string().min(1).max(80),
  name_zh: z.string().min(1).max(40),
  origin_country: z.string().regex(/^[A-Z]{2}$/),
  region: z.string().min(1).max(60),
  process: ProcessSchema,
  variety: z.string().min(1).max(60),
  altitude_m: z.number().int().min(0).max(3000),
  cup_score: z.number().min(80).max(100),
  roast_level: RoastSchema,
  flavor_notes: z.array(z.string().min(1).max(30)).min(1).max(5),
  price_per_kg: z.number().int().positive(),
  currency: z.literal('TWD'),
  lot_id: z.string().regex(/^L-\d{4}-\d{3}$/),
  // 庫存以整數公斤計（最小訂購 1 kg）/ Stock in whole kilograms (minimum order 1 kg).
  initial_stock_kg: z.number().int().min(0),
  low_threshold_kg: z.number().int().min(0),
});
export type SeedProduct = z.infer<typeof SeedProductSchema>;

/** DynamoDB 中的 META 項目（讀取時驗證，避免把奇怪的資料回給客戶）/ META item, validated on read. */
export const ProductMetaItemSchema = z.object({
  pk: z.string().startsWith(PRODUCT_PK_PREFIX),
  sk: z.literal(META_SK),
  entity: z.literal('Product'),
  status: z.enum(['active', 'inactive']),
  id: ProductIdSchema,
  name: z.string(),
  name_zh: z.string(),
  origin_country: z.string(),
  region: z.string(),
  process: ProcessSchema,
  variety: z.string(),
  altitude_m: z.number(),
  cup_score: z.number(),
  roast_level: RoastSchema,
  flavor_notes: z.array(z.string()),
  price_per_kg: z.number(),
  currency: z.string(),
  lot_id: z.string(),
});
export type ProductMetaItem = z.infer<typeof ProductMetaItemSchema>;

export const StockItemSchema = z.object({
  pk: z.string().startsWith(PRODUCT_PK_PREFIX),
  sk: z.literal(STOCK_SK),
  available_kg: z.number().int().min(0),
  reserved_kg: z.number().int().min(0),
  low_threshold_kg: z.number().int().min(0),
  version: z.number().int().min(1),
});
export type StockItem = z.infer<typeof StockItemSchema>;

export type StockStatus = 'in_stock' | 'low' | 'out';

/** 給咖啡廳看的庫存狀態，不揭露實際公斤數 / Status for cafés; never the actual kilograms. */
export function stockStatus(stock: StockItem | undefined): StockStatus {
  if (!stock || stock.available_kg <= 0) return 'out';
  return stock.available_kg <= stock.low_threshold_kg ? 'low' : 'in_stock';
}

/**
 * 公開商品 DTO：欄位白名單（SEC-022）。新增欄位必須在這裡明確加入，內部欄位（pk、gsi1pk、公斤數、版本）永遠不會外洩。
 * Public product DTO built from an explicit allow-list; internal fields can never leak.
 */
export function toPublicProduct(meta: ProductMetaItem, stock: StockItem | undefined) {
  return {
    id: meta.id,
    name: meta.name,
    name_zh: meta.name_zh,
    origin_country: meta.origin_country,
    region: meta.region,
    process: meta.process,
    variety: meta.variety,
    altitude_m: meta.altitude_m,
    cup_score: meta.cup_score,
    roast_level: meta.roast_level,
    flavor_notes: meta.flavor_notes,
    price_per_kg: meta.price_per_kg,
    currency: meta.currency,
    lot_id: meta.lot_id,
    stock_status: stockStatus(stock),
  };
}
export type PublicProduct = ReturnType<typeof toPublicProduct>;

/** 內部人員看的庫存明細 / Stock detail for staff. */
export function toAdminStock(id: string, stock: StockItem) {
  return {
    product_id: id,
    available_kg: stock.available_kg,
    reserved_kg: stock.reserved_kg,
    low_threshold_kg: stock.low_threshold_kg,
    version: stock.version,
    stock_status: stockStatus(stock),
  };
}
