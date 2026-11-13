import { createHash } from 'node:crypto';
import { z } from 'zod';
import { TENANT_ID_PATTERN } from '../../../identity/src/scopes';
import { ProductIdSchema } from './model';

/**
 * 訂單資料模型（docs/03 §6、ADR-025）。
 * Order data model.
 *
 *   TENANT#<t> / ORDER#<ULID>   訂單 / order          gsi1pk=STATUS#<status>, gsi1sk=<created_at>#<order_id>
 *   TENANT#<t> / IDEMP#<key>    冪等記錄 / idempotency record（expires_at = 24h，TTL）
 *
 * 兩者都在租戶自己的分割區 → 租戶憑證（ADR-024）只能讀寫自己的。
 * Both live in the tenant's own partition, so tenant-scoped credentials reach only their own.
 */

/**
 * 輸入上限（A2 決策 D6 修訂：25 個商品、每個 1–500 kg）。
 * - 交易最多 100 個項目；每個商品 1 個庫存 Update ＋ 訂單 ＋ 冪等 → 25 個商品 = 27 個項目。
 * - 單一請求的寫入量有上限（交易 = 2 倍 WRU）；下限 1 防止負數「增加」庫存。
 * Input limits: bound the transaction size and per-request write cost; qty ≥ 1 blocks negative quantities.
 */
export const MAX_LINES = 25;
export const MIN_QTY_KG = 1;
export const MAX_QTY_KG = 500;
/** 冪等記錄保留 24 小時 / Idempotency records live 24 hours. */
export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
export const MAX_BODY_BYTES = 16 * 1024;

export const TENANT_PK_PREFIX = 'TENANT#';
export const ORDER_SK_PREFIX = 'ORDER#';
export const IDEMP_SK_PREFIX = 'IDEMP#';

export const TenantIdSchema = z.string().regex(TENANT_ID_PATTERN);
export const OrderIdSchema = z.string().regex(/^o_[0-9A-HJKMNP-TV-Z]{26}$/);
/** Idempotency-Key：16–64 個 URL 安全字元（例如 UUID）/ 16–64 URL-safe characters (e.g. a UUID). */
export const IdempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);

export const tenantPk = (tenantId: string) => `${TENANT_PK_PREFIX}${tenantId}`;
/** order_id = o_<ULID>；sk = ORDER#<ULID> */
export const orderSk = (orderId: string) => `${ORDER_SK_PREFIX}${orderId.slice(2)}`;
export const orderIdFromSk = (sk: string) => `o_${sk.slice(ORDER_SK_PREFIX.length)}`;
export const idempSk = (key: string) => `${IDEMP_SK_PREFIX}${key}`;

export const OrderLineInputSchema = z.strictObject({
  product_id: ProductIdSchema,
  qty_kg: z.number().int().min(MIN_QTY_KG).max(MAX_QTY_KG),
});

export const CreateOrderRequestSchema = z
  .strictObject({
    items: z.array(OrderLineInputSchema).min(1).max(MAX_LINES),
  })
  .refine((r) => new Set(r.items.map((i) => i.product_id)).size === r.items.length, {
    message: 'Each product may appear only once',
    path: ['items'],
  });
export type CreateOrderRequest = z.infer<typeof CreateOrderRequestSchema>;

/**
 * 請求的指紋：商品排序後再雜湊 → 同一張訂單換個順序仍視為同一個請求。
 * Request fingerprint; items are sorted first so reordering lines is still "the same request".
 */
export function requestHash(req: CreateOrderRequest): string {
  const canonical = [...req.items]
    .sort((a, b) => a.product_id.localeCompare(b.product_id))
    .map((i) => [i.product_id, i.qty_kg]);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** 訂單狀態（ORD-F-005，A3c）/ Order lifecycle states. */
export const ORDER_STATUSES = ['CREATED', 'CONFIRMED', 'ROASTING_SCHEDULED', 'ROASTED', 'SHIPPED', 'COMPLETED', 'CANCELLED'] as const;
export const OrderStatusSchema = z.enum(ORDER_STATUSES);
export type OrderStatus = z.infer<typeof OrderStatusSchema>;

export const StatusChangeSchema = z.object({
  from: OrderStatusSchema,
  to: OrderStatusSchema,
  at: z.string(),
  /** 'staff:<sub>' 或 'system:<原因>'；不放進公開 DTO / Never exposed in the public DTO. */
  by: z.string(),
});
export const PaymentStatusSchema = z.enum(['PAID_MOCK']);

export const OrderLineSchema = z.object({
  product_id: ProductIdSchema,
  name: z.string(),
  qty_kg: z.number().int(),
  price_per_kg: z.number().int(),
  line_total: z.number().int(),
});
export type OrderLine = z.infer<typeof OrderLineSchema>;

export const OrderItemSchema = z.object({
  pk: z.string().startsWith(TENANT_PK_PREFIX),
  sk: z.string().startsWith(ORDER_SK_PREFIX),
  entity: z.literal('Order'),
  order_id: OrderIdSchema,
  tenant_id: TenantIdSchema,
  status: OrderStatusSchema,
  payment_status: PaymentStatusSchema,
  items: z.array(OrderLineSchema).min(1),
  total: z.number().int(),
  currency: z.string(),
  created_by: z.string(),
  created_at: z.string(),
  idempotency_key: z.string(),
  updated_at: z.string().optional(),
  status_history: z.array(StatusChangeSchema).optional(),
});
export type OrderItem = z.infer<typeof OrderItemSchema>;

export const IdempotencyItemSchema = z.object({
  pk: z.string().startsWith(TENANT_PK_PREFIX),
  sk: z.string().startsWith(IDEMP_SK_PREFIX),
  request_hash: z.string(),
  order_id: OrderIdSchema,
  expires_at: z.number().int(),
});
export type IdempotencyItem = z.infer<typeof IdempotencyItemSchema>;

/**
 * 公開訂單 DTO：欄位白名單（SEC-022），不含 pk／sk／gsi／建立者 sub。
 * Public order DTO from an explicit allow-list.
 */
export function toPublicOrder(o: OrderItem) {
  return {
    order_id: o.order_id,
    status: o.status,
    payment_status: o.payment_status,
    items: o.items.map((l) => ({
      product_id: l.product_id,
      name: l.name,
      qty_kg: l.qty_kg,
      price_per_kg: l.price_per_kg,
      line_total: l.line_total,
    })),
    total: o.total,
    currency: o.currency,
    created_at: o.created_at,
    updated_at: o.updated_at ?? o.created_at,
    // 給咖啡廳看狀態何時改變，但不透露是哪位 staff / When it changed, not which staff member.
    status_history: (o.status_history ?? []).map((h) => ({ from: h.from, to: h.to, at: h.at })),
  };
}
export type PublicOrder = ReturnType<typeof toPublicOrder>;

/** 列表分頁游標：只帶 sk；pk 一律由已驗證的 tenant_id 組出 / Cursor carries only sk; pk always comes from the verified tenant. */
export function encodeCursor(sk: string): string {
  return Buffer.from(JSON.stringify({ sk }), 'utf8').toString('base64url');
}

export function decodeCursor(token: string): string | undefined {
  try {
    const parsed = z
      .strictObject({ sk: z.string().regex(/^ORDER#[0-9A-HJKMNP-TV-Z]{26}$/) })
      .safeParse(JSON.parse(Buffer.from(token, 'base64url').toString('utf8')));
    return parsed.success ? parsed.data.sk : undefined;
  } catch {
    return undefined;
  }
}

/** staff 用 DTO：多了 tenant_id 與變更者 / Staff DTO adds the tenant and who changed what. */
export function toAdminOrder(o: OrderItem) {
  return {
    ...toPublicOrder(o),
    tenant_id: o.tenant_id,
    status_history: (o.status_history ?? []).map((h) => ({ from: h.from, to: h.to, at: h.at, by: h.by })),
  };
}

/** staff 列表游標：GSI1 的 LastEvaluatedKey，狀態必須與查詢相同 / GSI1 cursor bound to the queried status. */
export function encodeAdminCursor(key: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

export function decodeAdminCursor(token: string, status: OrderStatus): Record<string, string> | undefined {
  try {
    const parsed = z
      .strictObject({
        pk: z.string().regex(/^TENANT#t_[0-9A-HJKMNP-TV-Z]{26}$/),
        sk: z.string().regex(/^ORDER#[0-9A-HJKMNP-TV-Z]{26}$/),
        gsi1pk: z.literal(`STATUS#${status}`),
        gsi1sk: z.string().max(100),
      })
      .safeParse(JSON.parse(Buffer.from(token, 'base64url').toString('utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
