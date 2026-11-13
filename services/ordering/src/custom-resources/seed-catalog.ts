import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { Logger } from '@aws-lambda-powertools/logger';
import type { CloudFormationCustomResourceEvent } from 'aws-lambda';
import rawProducts from '../../seed/products.json';
import { CATALOG_GSI_PK, META_SK, PRODUCT_PK_PREFIX, STOCK_SK, SeedProduct, SeedProductSchema, productPk } from '../lib/model';

/**
 * 商品目錄種子（CloudFormation custom resource，經 CDK Provider framework）。
 * Catalog seed (CloudFormation custom resource via the CDK Provider framework).
 *
 * - META：每次 Create／Update 都覆寫 → 商品目錄是「設定」，以程式碼為準。
 *   META is upserted every time: the catalog is configuration, owned by code.
 * - STOCK：只在不存在時寫入（attribute_not_exists）→ 庫存是「執行期狀態」，部署永遠不會重設 Prod 的庫存。
 *   STOCK is written only if absent: stock is runtime state and a deploy never resets it.
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

export async function seed(client: DynamoDBDocumentClient, tableName: string, products: SeedProduct[]): Promise<SeedResult> {
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
          gsi1pk: CATALOG_GSI_PK,
          gsi1sk: `${PRODUCT_PK_PREFIX}${p.id}`,
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
  const result = await seed(doc, tableName, loadSeed());
  logger.info('Catalog seeded', { ...result, requestType: event.RequestType });
  return {
    PhysicalResourceId: physicalResourceId,
    Data: { Products: String(result.products), StockCreated: String(result.stockCreated), StockKept: String(result.stockKept) },
  };
};
