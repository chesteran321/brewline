import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { STOCK_SK, productPk } from './model';
import { canTransition, stockEffect } from './order-lifecycle';
import { OrderItem, OrderItemSchema, OrderStatus, orderSk, tenantPk } from './order-model';

/**
 * staff 的跨租戶訂單操作（A3c，ADR-027）。用函數自己的角色（不扮演租戶角色）：
 * IAM 允許 TENANT#*，但只有 Get／Update，商品只能改庫存欄位，GSI 只能查 STATUS#*。
 * Cross-tenant staff operations using the function's own role (not the tenant role).
 */

export type TransitionResult =
  | { readonly kind: 'updated'; readonly order: OrderItem }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'invalid_transition'; readonly current: OrderStatus }
  /** 讀到之後狀態被別人改了（樂觀鎖）/ Someone changed the status after we read it. */
  | { readonly kind: 'conflict' }
  | { readonly kind: 'busy' };

export interface TransitionInput {
  readonly tenantId: string;
  readonly orderId: string;
  readonly to: OrderStatus;
  /** 'staff:<sub>' 或 'system:timeout' */
  readonly actor: string;
  readonly now: Date;
  /** 只有在目前狀態是這些之一時才轉換（逾時取消用：只取消仍是 CREATED 的）/ Guard for automated callers. */
  readonly onlyFrom?: readonly OrderStatus[];
}

export interface AdminPage {
  readonly orders: OrderItem[];
  readonly last?: Record<string, unknown>;
}

const THROTTLE_CODES = new Set(['ThrottlingError', 'ProvisionedThroughputExceeded', 'RequestLimitExceeded', 'TransactionConflict']);

export class AdminOrderRepo {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly tableName: string,
    private readonly gsi1Name: string,
  ) {}

  async get(tenantId: string, orderId: string, consistent = false): Promise<OrderItem | undefined> {
    const out = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: { pk: tenantPk(tenantId), sk: orderSk(orderId) }, ConsistentRead: consistent }),
    );
    const parsed = OrderItemSchema.safeParse(out.Item);
    return parsed.success && parsed.data.tenant_id === tenantId ? parsed.data : undefined;
  }

  /** GSI1 `STATUS#<status>`，新的在前（跨租戶）/ All tenants, newest first. */
  async listByStatus(status: OrderStatus, limit: number, startKey?: Record<string, unknown>): Promise<AdminPage> {
    const out = await this.doc.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: this.gsi1Name,
        KeyConditionExpression: 'gsi1pk = :s',
        ExpressionAttributeValues: { ':s': `STATUS#${status}` },
        ScanIndexForward: false,
        Limit: limit,
        ExclusiveStartKey: startKey,
      }),
    );
    const orders: OrderItem[] = [];
    for (const raw of out.Items ?? []) {
      const parsed = OrderItemSchema.safeParse(raw);
      if (parsed.success) orders.push(parsed.data);
    }
    return { orders, last: out.LastEvaluatedKey };
  }

  /**
   * 一個交易：訂單狀態（條件：狀態仍是讀到的那個）＋ 每個商品的庫存調整。
   * One transaction: the order status (conditioned on the status we read) plus per-line stock changes.
   */
  async transition(input: TransitionInput): Promise<TransitionResult> {
    const order = await this.get(input.tenantId, input.orderId, true);
    if (!order) return { kind: 'not_found' };
    if (input.onlyFrom && !input.onlyFrom.includes(order.status)) return { kind: 'invalid_transition', current: order.status };
    if (!canTransition(order.status, input.to)) return { kind: 'invalid_transition', current: order.status };

    const at = input.now.toISOString();
    const effect = stockEffect(input.to);
    const stockUpdates =
      effect === 'none'
        ? []
        : order.items.map((l) => ({
            Update: {
              TableName: this.tableName,
              Key: { pk: productPk(l.product_id), sk: STOCK_SK },
              UpdateExpression:
                effect === 'consume'
                  ? 'SET #r = #r - :q, #v = #v + :one, #u = :ts'
                  : 'SET #r = #r - :q, #a = #a + :q, #v = #v + :one, #u = :ts',
              // 預留量不可變成負數（帳目一致）/ Reserved stock never goes negative.
              ConditionExpression: 'attribute_exists(#pk) AND #r >= :q',
              ExpressionAttributeNames: {
                '#r': 'reserved_kg',
                '#v': 'version',
                '#u': 'updated_at',
                '#pk': 'pk',
                ...(effect === 'release' ? { '#a': 'available_kg' } : {}),
              },
              ExpressionAttributeValues: { ':q': l.qty_kg, ':one': 1, ':ts': at },
            },
          }));

    try {
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.tableName,
                Key: { pk: order.pk, sk: order.sk },
                UpdateExpression:
                  'SET #s = :to, gsi1pk = :g, gsi1sk = :gs, updated_at = :at, status_history = list_append(if_not_exists(status_history, :empty), :h)',
                ConditionExpression: '#s = :from',
                ExpressionAttributeNames: { '#s': 'status' },
                ExpressionAttributeValues: {
                  ':to': input.to,
                  ':from': order.status,
                  ':g': `STATUS#${input.to}`,
                  ':gs': `${at}#${order.order_id}`,
                  ':at': at,
                  ':empty': [],
                  ':h': [{ from: order.status, to: input.to, at, by: input.actor }],
                },
              },
            },
            ...stockUpdates,
          ],
        }),
      );
    } catch (err) {
      if (!(err instanceof TransactionCanceledException)) {
        if (['ThrottlingException', 'ProvisionedThroughputExceededException'].includes((err as Error).name)) return { kind: 'busy' };
        throw err;
      }
      const codes = (err.CancellationReasons ?? []).map((r) => r.Code ?? 'None');
      if (codes[0] === 'ConditionalCheckFailed') return { kind: 'conflict' };
      if (codes.some((c) => THROTTLE_CODES.has(c))) return { kind: 'busy' };
      // 預留量不足以扣除 → 帳目不一致，交給呼叫端記錄為錯誤 / Books out of balance.
      throw new Error(`Stock adjustment failed: ${codes.join(',')}`);
    }

    return {
      kind: 'updated',
      order: {
        ...order,
        status: input.to,
        updated_at: at,
        status_history: [...(order.status_history ?? []), { from: order.status, to: input.to, at, by: input.actor }],
      },
    };
  }
}
