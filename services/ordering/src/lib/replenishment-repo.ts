import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { tenantPk } from './order-model';
import {
  DELETED_TTL_SECONDS,
  REPL_SK_PREFIX,
  ReplenishmentItem,
  ReplenishmentItemSchema,
  replSk,
} from './replenishment-model';

/**
 * 定期補貨的讀寫（A4e）。全部用租戶範圍憑證（ADR-024）：只碰得到 TENANT#<自己>。
 * 租戶角色**沒有** DeleteItem → 刪除是「軟刪除」（status = deleted ＋ TTL 30 天）。
 * Replenishment reads/writes with tenant-scoped credentials. The tenant role has no DeleteItem, so deletion is a soft
 * delete (status = deleted + 30-day TTL).
 */
export class ReplenishmentRepo {
  constructor(
    private readonly docFor: (tenantId: string) => DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  /** 有效的補貨（最多 5 筆，一次 Query 就夠）/ Active subscriptions (≤ 5, one query). */
  async listActive(tenantId: string): Promise<ReplenishmentItem[]> {
    const items: ReplenishmentItem[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const out = await this.docFor(tenantId).send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'pk = :pk AND begins_with(sk, :p)',
          ExpressionAttributeValues: { ':pk': tenantPk(tenantId), ':p': REPL_SK_PREFIX },
          ConsistentRead: true,
          ExclusiveStartKey: startKey,
        }),
      );
      for (const raw of out.Items ?? []) {
        const r = ReplenishmentItemSchema.safeParse(raw);
        if (r.success && r.data.status === 'active') items.push(r.data);
      }
      startKey = out.LastEvaluatedKey;
    } while (startKey);
    return items.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async get(tenantId: string, id: string): Promise<ReplenishmentItem | undefined> {
    const out = await this.docFor(tenantId).send(
      new GetCommand({ TableName: this.tableName, Key: { pk: tenantPk(tenantId), sk: replSk(id) }, ConsistentRead: true }),
    );
    return out.Item ? ReplenishmentItemSchema.parse(out.Item) : undefined;
  }

  async put(item: ReplenishmentItem): Promise<void> {
    await this.docFor(item.tenant_id).send(
      new PutCommand({ TableName: this.tableName, Item: item, ConditionExpression: 'attribute_not_exists(pk)' }),
    );
  }

  /** 軟刪除（冪等）/ Soft delete (idempotent). */
  async markDeleted(item: ReplenishmentItem, now: Date): Promise<void> {
    await this.docFor(item.tenant_id).send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          ...item,
          status: 'deleted',
          deleted_at: now.toISOString(),
          expires_at: Math.floor(now.getTime() / 1000) + DELETED_TTL_SECONDS,
        },
      }),
    );
  }
}
