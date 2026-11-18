import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { META_SK, ProductMetaItem, ProductMetaItemSchema, STOCK_SK, StockItem, StockItemSchema, productPk } from './model';
import { OrderItem, OrderItemSchema, orderSk, tenantPk } from './order-model';
import {
  CreateRoastRequest,
  LotItem,
  LotItemSchema,
  MAX_AVAILABLE_KG,
  ORDER_EDGE_PREFIX,
  ROAST_EDGE_PREFIX,
  RoastItem,
  RoastItemSchema,
  RoastOrderEdge,
  RoastOrderEdgeSchema,
  lotPk,
  lotRoastEdgeSk,
  newQrToken,
  roastIdFromKey,
  roastOrderEdgeSk,
  roastPk,
  roastRequestHash,
} from './trace-model';

/**
 * 烘焙批次、補貨與追溯（S2a，ADR-031）。用函數自己的角色（跨租戶、不扮演租戶角色），IAM 依前綴限制：
 * 訂單只能更新品項分配（dynamodb:Attributes），商品只能改庫存欄位。
 * Roast batches, restock and trace using the function's own role (cross-tenant, never the tenant role).
 */

const THROTTLE_CODES = new Set(['ThrottlingError', 'ProvisionedThroughputExceeded', 'RequestLimitExceeded', 'TransactionConflict']);
const THROTTLE_ERRORS = new Set(['ThrottlingException', 'ProvisionedThroughputExceededException']);

export type CreateRoastResult =
  | { readonly kind: 'created' | 'replayed'; readonly roast: RoastItem }
  /** 同一個 Idempotency-Key 但內容不同 / Same key, different request. */
  | { readonly kind: 'key_conflict' }
  | { readonly kind: 'not_found'; readonly what: 'product' | 'lot' | 'order'; readonly ref: string }
  /** 訂單不在 ROASTING_SCHEDULED（只有排定烘焙後才能分配）/ Orders are allocated only once roasting is scheduled. */
  | { readonly kind: 'invalid_state'; readonly ref: string; readonly status: string }
  | { readonly kind: 'product_mismatch'; readonly ref: string }
  | { readonly kind: 'over_allocated'; readonly ref: string; readonly remaining_kg: number }
  /** 模擬批次只能分配模擬訂單，反之亦然 / Synthetic batches take synthetic orders only, and vice versa. */
  | { readonly kind: 'synthetic_mismatch'; readonly ref: string }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'busy' };

export type RoastUpdateResult =
  | { readonly kind: 'updated'; readonly roast: RoastItem }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'invalid_state'; readonly status: string }
  | { readonly kind: 'already_recalled' }
  | { readonly kind: 'forbidden' };

export type RestockResult =
  | { readonly kind: 'updated'; readonly stock: StockItem }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'version_conflict'; readonly current_version: number }
  | { readonly kind: 'over_cap'; readonly max_available_kg: number };

export interface Caller {
  /** 'staff:<sub>' 或 'roastery:<sub>' / Who acts. */
  readonly actor: string;
  /** 呼叫者的 token 帶 synthetic → 只能碰模擬資料 / A synthetic caller touches synthetic data only. */
  readonly synthetic: boolean;
}

export interface OrderLineTrace {
  readonly product_id: string;
  readonly qty_kg: number;
  readonly allocated_kg: number;
  readonly roasts: RoastItem[];
}

export class TraceRepo {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  private async get(pk: string, sk: string, consistent = false): Promise<Record<string, unknown> | undefined> {
    const out = await this.doc.send(new GetCommand({ TableName: this.tableName, Key: { pk, sk }, ConsistentRead: consistent }));
    return out.Item;
  }

  async getProduct(productId: string): Promise<ProductMetaItem | undefined> {
    const p = ProductMetaItemSchema.safeParse(await this.get(productPk(productId), META_SK));
    return p.success ? p.data : undefined;
  }

  async getLot(lotId: string): Promise<LotItem | undefined> {
    const p = LotItemSchema.safeParse(await this.get(lotPk(lotId), META_SK));
    return p.success ? p.data : undefined;
  }

  async getRoast(roastId: string, consistent = false): Promise<RoastItem | undefined> {
    const p = RoastItemSchema.safeParse(await this.get(roastPk(roastId), META_SK, consistent));
    return p.success && p.data.roast_id === roastId ? p.data : undefined;
  }

  async getOrder(tenantId: string, orderId: string): Promise<OrderItem | undefined> {
    const p = OrderItemSchema.safeParse(await this.get(tenantPk(tenantId), orderSk(orderId), true));
    return p.success && p.data.tenant_id === tenantId ? p.data : undefined;
  }

  /** 最多 100 個；缺的就不回傳 / Up to 100 roasts; missing ones are skipped. */
  async getRoasts(roastIds: readonly string[]): Promise<RoastItem[]> {
    const ids = [...new Set(roastIds)].slice(0, 100);
    if (ids.length === 0) return [];
    const found: RoastItem[] = [];
    let keys: Record<string, unknown>[] | undefined = ids.map((id) => ({ pk: roastPk(id), sk: META_SK }));
    for (let attempt = 0; keys && keys.length > 0 && attempt < 3; attempt++) {
      const out = await this.doc.send(new BatchGetCommand({ RequestItems: { [this.tableName]: { Keys: keys } } }));
      for (const raw of out.Responses?.[this.tableName] ?? []) {
        const p = RoastItemSchema.safeParse(raw);
        if (p.success) found.push(p.data);
      }
      keys = out.UnprocessedKeys?.[this.tableName]?.Keys as Record<string, unknown>[] | undefined;
    }
    return found;
  }

  /**
   * 建立烘焙批次並分配給訂單：一個交易＝批次＋批次→訂單的邊＋生豆→批次的邊＋每張訂單的品項分配（條件寫入）。
   * Create a roast batch and allocate it: one transaction with the batch, the edges and conditional order-line updates.
   */
  async createRoast(req: CreateRoastRequest, idempotencyKey: string, caller: Caller, now: Date): Promise<CreateRoastResult> {
    const roastId = roastIdFromKey(idempotencyKey);
    const hash = roastRequestHash(req);
    const replay = async (): Promise<CreateRoastResult | undefined> => {
      const existing = await this.getRoast(roastId, true);
      if (!existing) return undefined;
      return existing.request_hash === hash ? { kind: 'replayed', roast: existing } : { kind: 'key_conflict' };
    };
    const prior = await replay();
    if (prior) return prior;

    const product = await this.getProduct(req.product_id);
    if (!product) return { kind: 'not_found', what: 'product', ref: req.product_id };
    const lot = await this.getLot(product.lot_id);
    if (!lot) return { kind: 'not_found', what: 'lot', ref: product.lot_id };

    const updates: Array<{ order: OrderItem; index: number; kg: number; prev: number }> = [];
    for (const a of req.allocations) {
      const ref = `${a.tenant_id}/${a.order_id}`;
      const order = await this.getOrder(a.tenant_id, a.order_id);
      if (!order) return { kind: 'not_found', what: 'order', ref };
      if ((order.synthetic === true) !== caller.synthetic) return { kind: 'synthetic_mismatch', ref };
      if (order.status !== 'ROASTING_SCHEDULED') return { kind: 'invalid_state', ref, status: order.status };
      const index = order.items.findIndex((l) => l.product_id === req.product_id);
      if (index < 0) return { kind: 'product_mismatch', ref };
      const line = order.items[index]!;
      const prev = line.allocated_kg ?? 0;
      if (prev + a.kg > line.qty_kg) return { kind: 'over_allocated', ref, remaining_kg: line.qty_kg - prev };
      updates.push({ order, index, kg: a.kg, prev: line.qty_kg - a.kg });
    }

    const at = now.toISOString();
    const roast: RoastItem = {
      pk: roastPk(roastId),
      sk: 'META',
      entity: 'RoastBatch',
      roast_id: roastId,
      product_id: req.product_id,
      lot_id: lot.lot_id,
      roast_date: req.roast_date,
      roast_level: product.roast_level,
      kg: req.kg,
      status: 'SCHEDULED',
      request_hash: hash,
      created_by: caller.actor,
      created_at: at,
      ...(caller.synthetic ? { synthetic: true as const } : {}),
    };

    try {
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            { Put: { TableName: this.tableName, Item: roast, ConditionExpression: 'attribute_not_exists(pk)' } },
            {
              Put: {
                TableName: this.tableName,
                Item: { pk: lotPk(lot.lot_id), sk: lotRoastEdgeSk(req.roast_date, roastId), entity: 'LotRoast', roast_id: roastId, roast_date: req.roast_date },
              },
            },
            ...updates.flatMap(({ order, index, kg, prev }) => {
              const line = `#it[${index}]`;
              return [
                {
                  Update: {
                    TableName: this.tableName,
                    Key: { pk: order.pk, sk: order.sk },
                    UpdateExpression: `SET ${line}.allocated_kg = if_not_exists(${line}.allocated_kg, :zero) + :k, ${line}.roast_ids = list_append(if_not_exists(${line}.roast_ids, :empty), :rids), #u = :at`,
                    // 品項未變、狀態未變、不超量、同一批次不重複分配 / Same line, same status, no over-allocation, no double allocation.
                    ConditionExpression:
                      `#s = :rs AND ${line}.product_id = :p AND (attribute_not_exists(${line}.allocated_kg) OR ${line}.allocated_kg <= :maxPrev) ` +
                      `AND NOT contains(${line}.roast_ids, :rid) AND ${caller.synthetic ? '#syn = :true' : 'attribute_not_exists(#syn)'}`,
                    ExpressionAttributeNames: { '#it': 'items', '#s': 'status', '#u': 'updated_at', '#syn': 'synthetic' },
                    ExpressionAttributeValues: {
                      ':zero': 0,
                      ':k': kg,
                      ':empty': [],
                      ':rids': [roastId],
                      ':rid': roastId,
                      ':at': at,
                      ':rs': 'ROASTING_SCHEDULED',
                      ':p': req.product_id,
                      ':maxPrev': prev,
                      ...(caller.synthetic ? { ':true': true } : {}),
                    },
                  },
                },
                {
                  Put: {
                    TableName: this.tableName,
                    Item: {
                      pk: roastPk(roastId),
                      sk: roastOrderEdgeSk(order.tenant_id, order.order_id),
                      entity: 'RoastAllocation',
                      tenant_id: order.tenant_id,
                      order_id: order.order_id,
                      product_id: req.product_id,
                      kg,
                    } satisfies RoastOrderEdge,
                  },
                },
              ];
            }),
          ],
        }),
      );
    } catch (err) {
      if (!(err instanceof TransactionCanceledException)) {
        if (THROTTLE_ERRORS.has((err as Error).name)) return { kind: 'busy' };
        throw err;
      }
      const codes = (err.CancellationReasons ?? []).map((r) => r.Code ?? 'None');
      // 同一個 key 的另一個請求先寫入了 → 當作重送 / A concurrent request with the same key won the race.
      if (codes[0] === 'ConditionalCheckFailed') return (await replay()) ?? { kind: 'conflict' };
      if (codes.some((c) => THROTTLE_CODES.has(c))) return { kind: 'busy' };
      return { kind: 'conflict' };
    }
    return { kind: 'created', roast };
  }

  /** SCHEDULED → ROASTED，同時產生 QR token / Mark roasted and mint the QR token. */
  async markRoasted(roastId: string, caller: Caller, now: Date, random?: Buffer): Promise<RoastUpdateResult> {
    const at = now.toISOString();
    try {
      const out = await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: roastPk(roastId), sk: META_SK },
          UpdateExpression: 'SET #s = :roasted, qr_token = :q, roasted_at = :at, updated_at = :at',
          ConditionExpression: `#s = :scheduled${caller.synthetic ? ' AND #syn = :true' : ''}`,
          ExpressionAttributeNames: { '#s': 'status', ...(caller.synthetic ? { '#syn': 'synthetic' } : {}) },
          ExpressionAttributeValues: {
            ':roasted': 'ROASTED',
            ':scheduled': 'SCHEDULED',
            ':q': newQrToken(random),
            ':at': at,
            ...(caller.synthetic ? { ':true': true } : {}),
          },
          ReturnValues: 'ALL_NEW',
        }),
      );
      return { kind: 'updated', roast: RoastItemSchema.parse(out.Attributes) };
    } catch (err) {
      if ((err as Error).name !== 'ConditionalCheckFailedException') throw err;
      const current = await this.getRoast(roastId, true);
      if (!current) return { kind: 'not_found' };
      if (caller.synthetic && current.synthetic !== true) return { kind: 'forbidden' };
      return { kind: 'invalid_state', status: current.status };
    }
  }

  /** 召回（只有 staff／admin）：公開頁會顯示提醒 / Recall (admin only); the public page shows the notice. */
  async recall(roastId: string, notice: string, caller: Caller, now: Date): Promise<RoastUpdateResult> {
    const at = now.toISOString();
    try {
      const out = await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: roastPk(roastId), sk: META_SK },
          UpdateExpression: 'SET recall = :r, updated_at = :at',
          ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(recall)',
          ExpressionAttributeValues: { ':r': { at, notice, by: caller.actor }, ':at': at },
          ReturnValues: 'ALL_NEW',
        }),
      );
      return { kind: 'updated', roast: RoastItemSchema.parse(out.Attributes) };
    } catch (err) {
      if ((err as Error).name !== 'ConditionalCheckFailedException') throw err;
      return (await this.getRoast(roastId, true)) ? { kind: 'already_recalled' } : { kind: 'not_found' };
    }
  }

  /**
   * 補貨：available_kg 增加，樂觀鎖（version）防止重送造成重複補貨。
   * Restock with an optimistic lock on version, so a retried request never adds twice.
   */
  async restock(productId: string, kg: number, expectedVersion: number, now: Date): Promise<RestockResult> {
    const key = { pk: productPk(productId), sk: STOCK_SK };
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: key,
          UpdateExpression: 'SET #a = #a + :k, #v = #v + :one, #u = :at',
          ConditionExpression: 'attribute_exists(#pk) AND #v = :ev AND #a <= :cap',
          ExpressionAttributeNames: { '#a': 'available_kg', '#v': 'version', '#u': 'updated_at', '#pk': 'pk' },
          ExpressionAttributeValues: { ':k': kg, ':one': 1, ':at': now.toISOString(), ':ev': expectedVersion, ':cap': MAX_AVAILABLE_KG - kg },
        }),
      );
    } catch (err) {
      if ((err as Error).name !== 'ConditionalCheckFailedException') throw err;
      const current = StockItemSchema.safeParse(await this.get(key.pk, key.sk, true));
      if (!current.success) return { kind: 'not_found' };
      if (current.data.version !== expectedVersion) return { kind: 'version_conflict', current_version: current.data.version };
      return { kind: 'over_cap', max_available_kg: MAX_AVAILABLE_KG };
    }
    return { kind: 'updated', stock: StockItemSchema.parse(await this.get(key.pk, key.sk, true)) };
  }

  /** 生豆批次 → 烘焙批次（新的在前，最多 100）/ Lot → roast batches, newest first. */
  async roastsOfLot(lotId: string): Promise<RoastItem[]> {
    const out = await this.doc.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :p)',
        ExpressionAttributeValues: { ':pk': lotPk(lotId), ':p': ROAST_EDGE_PREFIX },
        ScanIndexForward: false,
        Limit: 100,
      }),
    );
    const ids = (out.Items ?? []).map((i) => i.roast_id).filter((v): v is string => typeof v === 'string');
    const roasts = await this.getRoasts(ids);
    const order = new Map(ids.map((id, i) => [id, i]));
    return roasts.sort((a, b) => (order.get(a.roast_id) ?? 0) - (order.get(b.roast_id) ?? 0));
  }

  /** 烘焙批次 → 訂單（最多 100）/ Roast batch → orders. */
  async ordersOfRoast(roastId: string): Promise<RoastOrderEdge[]> {
    const out = await this.doc.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :p)',
        ExpressionAttributeValues: { ':pk': roastPk(roastId), ':p': ORDER_EDGE_PREFIX },
        Limit: 100,
      }),
    );
    return (out.Items ?? []).map((i) => RoastOrderEdgeSchema.safeParse(i)).flatMap((p) => (p.success ? [p.data] : []));
  }

  /** 訂單 → 每個品項的烘焙批次 / Order → roast batches per line. */
  async linesOfOrder(order: OrderItem): Promise<OrderLineTrace[]> {
    const roasts = await this.getRoasts(order.items.flatMap((l) => l.roast_ids ?? []));
    const byId = new Map(roasts.map((r) => [r.roast_id, r]));
    return order.items.map((l) => ({
      product_id: l.product_id,
      qty_kg: l.qty_kg,
      allocated_kg: l.allocated_kg ?? 0,
      roasts: (l.roast_ids ?? []).map((id) => byId.get(id)).filter((r): r is RoastItem => r !== undefined),
    }));
  }
}
