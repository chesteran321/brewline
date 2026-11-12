import { BatchGetCommand, DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  CATALOG_GSI_PK,
  META_SK,
  ProductMetaItem,
  ProductMetaItemSchema,
  STOCK_SK,
  StockItem,
  StockItemSchema,
  productPk,
} from './model';

/** BatchGetItem 一次最多 100 個 key / BatchGetItem accepts at most 100 keys. */
const BATCH_SIZE = 100;
const MAX_BATCH_RETRIES = 3;

/**
 * 商品目錄的讀取。每個方法只用到 Lambda 角色允許的動作與 key（IAM 以 LeadingKeys 限制 PRODUCT# / CATALOG）。
 * Catalog reads. Each method uses only actions and keys the function's role allows.
 */
export class CatalogRepo {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly tableName: string,
    private readonly gsi1Name: string,
  ) {}

  /** GSI1：gsi1pk = CATALOG（只有上架商品）/ Active products via GSI1. */
  async listActiveProducts(): Promise<ProductMetaItem[]> {
    const items: ProductMetaItem[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const out = await this.doc.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: this.gsi1Name,
          KeyConditionExpression: 'gsi1pk = :pk',
          ExpressionAttributeValues: { ':pk': CATALOG_GSI_PK },
          ExclusiveStartKey: startKey,
        }),
      );
      for (const raw of out.Items ?? []) {
        const parsed = ProductMetaItemSchema.safeParse(raw);
        if (parsed.success && parsed.data.status === 'active') items.push(parsed.data);
      }
      startKey = out.LastEvaluatedKey;
    } while (startKey);
    return items;
  }

  /** 批次讀 STOCK；處理 UnprocessedKeys / Batch-read stock items, retrying unprocessed keys. */
  async getStocks(ids: readonly string[]): Promise<Map<string, StockItem>> {
    const result = new Map<string, StockItem>();
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      let keys: Array<Record<string, unknown>> = ids.slice(i, i + BATCH_SIZE).map((id) => ({ pk: productPk(id), sk: STOCK_SK }));
      for (let attempt = 0; keys.length > 0 && attempt <= MAX_BATCH_RETRIES; attempt++) {
        const out = await this.doc.send(new BatchGetCommand({ RequestItems: { [this.tableName]: { Keys: keys } } }));
        for (const raw of out.Responses?.[this.tableName] ?? []) {
          const parsed = StockItemSchema.safeParse(raw);
          if (parsed.success) result.set(parsed.data.pk.slice('PRODUCT#'.length), parsed.data);
        }
        keys = (out.UnprocessedKeys?.[this.tableName]?.Keys ?? []) as Array<Record<string, unknown>>;
      }
      if (keys.length > 0) throw new Error(`BatchGetItem left ${keys.length} unprocessed keys`);
    }
    return result;
  }

  /** 一次 Query 取回 META＋STOCK / META and STOCK in one Query. */
  async getProductWithStock(id: string): Promise<{ meta?: ProductMetaItem; stock?: StockItem }> {
    const out = await this.doc.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': productPk(id) },
      }),
    );
    let meta: ProductMetaItem | undefined;
    let stock: StockItem | undefined;
    for (const raw of out.Items ?? []) {
      if (raw.sk === META_SK) {
        const parsed = ProductMetaItemSchema.safeParse(raw);
        if (parsed.success && parsed.data.status === 'active') meta = parsed.data;
      } else if (raw.sk === STOCK_SK) {
        const parsed = StockItemSchema.safeParse(raw);
        if (parsed.success) stock = parsed.data;
      }
    }
    return { meta, stock };
  }

  /** 強一致讀取庫存（內部人員）/ Strongly consistent stock read for staff. */
  async getStock(id: string): Promise<StockItem | undefined> {
    const out = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: { pk: productPk(id), sk: STOCK_SK }, ConsistentRead: true }),
    );
    const parsed = StockItemSchema.safeParse(out.Item);
    return parsed.success ? parsed.data : undefined;
  }
}
