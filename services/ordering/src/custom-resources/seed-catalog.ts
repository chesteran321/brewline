import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { Logger } from '@aws-lambda-powertools/logger';
import type { CloudFormationCustomResourceEvent } from 'aws-lambda';
import rawProducts from '../../seed/products.json';
import rawLots from '../../seed/lots.json';
import rawTestLots from '../../seed/test-lots.json';
import rawTestProducts from '../../seed/test-products.json';
import { CATALOG_GSI_PK, META_SK, PRODUCT_PK_PREFIX, STOCK_SK, SeedProduct, SeedProductSchema, productPk } from '../lib/model';
import { SeedLot, SeedLotSchema, lotPk } from '../lib/trace-model';

/**
 * 商品目錄種子（CloudFormation custom resource，經 CDK Provider framework）。
 * Catalog seed (CloudFormation custom resource via the CDK Provider framework).
 *
 * - META：每次 Create／Update 都覆寫 → 商品目錄是「設定」，以程式碼為準。
 *   META is upserted every time: the catalog is configuration, owned by code.
 * - STOCK：只在不存在時寫入（attribute_not_exists）→ 庫存是「執行期狀態」，部署永遠不會重設 Prod 的庫存。
 *   STOCK is written only if absent: stock is runtime state and a deploy never resets it.
 * - 測試商品（seed/test-products.json，只在 Dev，`IncludeTestProducts=true`）：**不寫 gsi1pk** → 不在目錄
 *   （稀疏索引），但可以用 ID 讀取與下單；給 smoke test 與併發測試用（ADR-025）。
 *   Test products (Dev only) get no gsi1pk, so they stay out of the catalog (sparse index) yet can be ordered by id.
 * - 生豆批次（S2a，seed/lots.json）：LOT#<id>/META 每次覆寫；每個商品的 lot_id 必須有對應批次，產地欄位必須一致。
 *   Green lots (LOT#<id>/META) are upserted every time; every product's lot_id must exist with matching origin fields.
 * - Delete：什麼都不做（資料表本身由 data stack 管理）/ Delete is a no-op.
 */

const logger = new Logger({ serviceName: 'ordering-seed-catalog' });
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export interface SeedResult {
  readonly products: number;
  readonly stockCreated: number;
  readonly stockKept: number;
}

/** 驗證種子檔：格式、ID 不重複 / Validate the seed file: schema and unique IDs. */
export function loadSeed(raw: unknown = rawProducts): SeedProduct[] {
  const products = SeedProductSchema.array().min(1).parse(raw);
  const ids = new Set(products.map((p) => p.id));
  if (ids.size !== products.length) throw new Error('Duplicate product id in seed/products.json');
  return products;
}

/** 測試商品：ID 必須是 p-9xxx，避免與正式商品混淆 / Test products must use p-9xxx ids. */
export function loadTestSeed(raw: unknown = rawTestProducts): SeedProduct[] {
  const products = loadSeed(raw);
  const bad = products.filter((p) => !/^p-9\d{3}$/.test(p.id));
  if (bad.length > 0) throw new Error(`Test product ids must be p-9xxx: ${bad.map((p) => p.id).join(',')}`);
  return products;
}

/** 產地欄位必須與商品一致，避免目錄與溯源頁說法不同 / Origin fields must match the product. */
const SHARED_FIELDS = ['origin_country', 'region', 'altitude_m', 'variety', 'process', 'cup_score'] as const;

export function loadLots(products: SeedProduct[], raw: unknown = rawLots): SeedLot[] {
  const lots = SeedLotSchema.array().min(1).parse(raw);
  const byId = new Map(lots.map((l) => [l.lot_id, l]));
  if (byId.size !== lots.length) throw new Error('Duplicate lot id in the lot seed');
  for (const p of products) {
    const lot = byId.get(p.lot_id);
    if (!lot) throw new Error(`Product ${p.id} references unknown lot ${p.lot_id}`);
    const diff = SHARED_FIELDS.filter((f) => lot[f] !== p[f]);
    if (diff.length > 0) throw new Error(`Lot ${lot.lot_id} disagrees with product ${p.id} on ${diff.join(',')}`);
  }
  return lots;
}

export function loadTestLots(products: SeedProduct[] = loadTestSeed(), raw: unknown = rawTestLots): SeedLot[] {
  const lots = loadLots(products, raw);
  const bad = lots.filter((l) => !l.lot_id.startsWith('L-9999-'));
  if (bad.length > 0) throw new Error(`Test lot ids must be L-9999-xxx: ${bad.map((l) => l.lot_id).join(',')}`);
  return lots;
}

export async function seedLots(client: DynamoDBDocumentClient, tableName: string, lots: SeedLot[]): Promise<number> {
  const now = new Date().toISOString();
  for (const l of lots) {
    await client.send(new PutCommand({ TableName: tableName, Item: { pk: lotPk(l.lot_id), sk: META_SK, entity: 'Lot', ...l, updated_at: now } }));
  }
  return lots.length;
}

export async function seed(
  client: DynamoDBDocumentClient,
  tableName: string,
  products: SeedProduct[],
  opts: { inCatalog: boolean } = { inCatalog: true },
): Promise<SeedResult> {
  let stockCreated = 0;
  let stockKept = 0;
  const now = new Date().toISOString();
  for (const p of products) {
    const { initial_stock_kg, low_threshold_kg, ...meta } = p;
    await client.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          pk: productPk(p.id),
          sk: META_SK,
          ...(opts.inCatalog ? { gsi1pk: CATALOG_GSI_PK, gsi1sk: `${PRODUCT_PK_PREFIX}${p.id}` } : {}),
          entity: 'Product',
          status: 'active',
          ...meta,
          updated_at: now,
        },
      }),
    );
    try {
      await client.send(
        new PutCommand({
          TableName: tableName,
          Item: {
            pk: productPk(p.id),
            sk: STOCK_SK,
            entity: 'Stock',
            available_kg: initial_stock_kg,
            reserved_kg: 0,
            low_threshold_kg,
            version: 1,
            updated_at: now,
          },
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
      stockCreated++;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        stockKept++;
      } else {
        throw err;
      }
    }
  }
  return { products: products.length, stockCreated, stockKept };
}

export const handler = async (event: CloudFormationCustomResourceEvent) => {
  const physicalResourceId = 'brewline-catalog-seed';
  if (event.RequestType === 'Delete') {
    logger.info('Delete: no-op, data stays in the table');
    return { PhysicalResourceId: physicalResourceId };
  }
  const tableName = String(event.ResourceProperties.TableName ?? '');
  if (!tableName) throw new Error('TableName property is required');
  const products = loadSeed();
  const result = await seed(doc, tableName, products);
  let lots = await seedLots(doc, tableName, loadLots(products));
  let testProducts = 0;
  if (String(event.ResourceProperties.IncludeTestProducts) === 'true') {
    const tests = loadTestSeed();
    testProducts = (await seed(doc, tableName, tests, { inCatalog: false })).products;
    lots += await seedLots(doc, tableName, loadTestLots(tests));
  }
  logger.info('Catalog seeded', { ...result, lots, testProducts, requestType: event.RequestType });
  return {
    PhysicalResourceId: physicalResourceId,
    Data: {
      Products: String(result.products),
      StockCreated: String(result.stockCreated),
      StockKept: String(result.stockKept),
      TestProducts: String(testProducts),
      Lots: String(lots),
    },
  };
};
