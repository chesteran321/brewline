import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { ProductIdSchema } from './model';
import { OrderIdSchema, TenantIdSchema } from './order-model';

/**
 * 溯源資料模型（docs/04 §6，S2，ADR-031 D5）。單表、鄰接清單，不需要新的 GSI。
 * Traceability data model: single table, adjacency list, no new GSI.
 *
 *   LOT#<lot_id>    / META                                  生豆批次（種子，每次部署覆寫）/ green lot (seeded)
 *   LOT#<lot_id>    / ROAST#<roast_date>#<roast_id>         邊：批次 → 烘焙（依日期排序）/ edge lot → roast
 *   ROAST#<roast_id>/ META                                  烘焙批次 / roast batch
 *   ROAST#<roast_id>/ ORDER#<tenant_id>#<order_id>          邊：烘焙 → 訂單（公斤數）/ edge roast → order
 *   TENANT#<t>      / ORDER#<ULID>                           訂單的每個品項帶 allocated_kg、roast_ids / order lines
 *
 * 租戶角色的 LeadingKeys 只到 TENANT#<自己>（ADR-024）→ 讀不到 ROAST# 的邊，訂單與租戶不會從溯源資料外洩。
 * The tenant role reaches only TENANT#<own>, so roast→order edges never leak orders or tenants.
 */

export const LOT_PK_PREFIX = 'LOT#';
export const ROAST_PK_PREFIX = 'ROAST#';
export const ROAST_EDGE_PREFIX = 'ROAST#';
export const ORDER_EDGE_PREFIX = 'ORDER#';

/** 烘焙機一批的上限（docs/07 §2）/ Roaster capacity per batch. */
export const MAX_BATCH_KG = 15;
/** 一個烘焙批次最多分配給幾張訂單（交易 ≤ 100 個項目）/ Orders per batch (transaction ≤ 100 items). */
export const MAX_ALLOCATIONS = 15;
/** 補貨單次上限與庫存上限 / Restock bounds. */
export const MAX_RESTOCK_KG = 500;
export const MAX_AVAILABLE_KG = 2000;

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const LotIdSchema = z.string().regex(/^L-\d{4}-\d{3}$/);
export const RoastIdSchema = z.string().regex(/^r_[0-9A-HJKMNP-TV-Z]{26}$/);
/** 128-bit 亂數，base64url 22 字元（TRC-F-001）/ 128 random bits as 22 base64url characters. */
export const QrTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
export const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)), 'invalid date');

export const lotPk = (lotId: string) => `${LOT_PK_PREFIX}${lotId}`;
export const roastPk = (roastId: string) => `${ROAST_PK_PREFIX}${roastId}`;
export const lotRoastEdgeSk = (roastDate: string, roastId: string) => `${ROAST_EDGE_PREFIX}${roastDate}#${roastId}`;
export const roastOrderEdgeSk = (tenantId: string, orderId: string) => `${ORDER_EDGE_PREFIX}${tenantId}#${orderId}`;

/**
 * 烘焙批次 ID 由 Idempotency-Key 決定（同一個 key 永遠得到同一個 ID）→ 用 attribute_not_exists 就能防重複建立，
 * 不需要另外的冪等記錄。
 * The roast id is derived from the Idempotency-Key, so a retry hits attribute_not_exists instead of creating a twin.
 */
export function roastIdFromKey(key: string): string {
  const digest = createHash('sha256').update(`roast|${key}`).digest();
  let bits = 0n;
  for (const b of digest.subarray(0, 17)) bits = (bits << 8n) | BigInt(b); // 136 bits ≥ 26 × 5
  let out = '';
  for (let i = 0; i < 26; i++) {
    out = CROCKFORD[Number(bits & 31n)] + out;
    bits >>= 5n;
  }
  return `r_${out}`;
}

export function newQrToken(random: Buffer = randomBytes(16)): string {
  if (random.length !== 16) throw new Error('QR token needs 16 random bytes');
  return random.toString('base64url');
}

const ProcessSchema = z.enum(['washed', 'natural', 'honey', 'anaerobic', 'wet-hulled']);

/** 種子檔中的一個生豆批次（seed/lots.json）/ One green lot in the seed file. */
export const SeedLotSchema = z.strictObject({
  lot_id: LotIdSchema,
  // 一律虛構（SIM-N-004）/ Always fictional.
  producer_display_name: z.string().min(1).max(80),
  origin_country: z.string().regex(/^[A-Z]{2}$/),
  region: z.string().min(1).max(60),
  altitude_m: z.number().int().min(0).max(3000),
  variety: z.string().min(1).max(60),
  process: ProcessSchema,
  cup_score: z.number().min(80).max(100),
  harvest: z.string().regex(/^\d{4}\/\d{2}$/),
});
export type SeedLot = z.infer<typeof SeedLotSchema>;

export const LotItemSchema = SeedLotSchema.extend({
  pk: z.string().startsWith(LOT_PK_PREFIX),
  sk: z.literal('META'),
  entity: z.literal('Lot'),
});
export type LotItem = z.infer<typeof LotItemSchema>;

export const RoastStatusSchema = z.enum(['SCHEDULED', 'ROASTED']);
export type RoastStatus = z.infer<typeof RoastStatusSchema>;

export const RecallSchema = z.object({
  at: z.string(),
  /** 公開頁顯示的提醒（不含個資）/ Notice shown on the public page (no personal data). */
  notice: z.string(),
  by: z.string(),
});

export const RoastItemSchema = z.object({
  pk: z.string().startsWith(ROAST_PK_PREFIX),
  sk: z.literal('META'),
  entity: z.literal('RoastBatch'),
  roast_id: RoastIdSchema,
  product_id: ProductIdSchema,
  lot_id: LotIdSchema,
  roast_date: IsoDateSchema,
  roast_level: z.string(),
  kg: z.number().int().min(1).max(MAX_BATCH_KG),
  status: RoastStatusSchema,
  request_hash: z.string(),
  created_by: z.string(),
  created_at: z.string(),
  updated_at: z.string().optional(),
  roasted_at: z.string().optional(),
  qr_token: QrTokenSchema.optional(),
  recall: RecallSchema.optional(),
  synthetic: z.literal(true).optional(),
});
export type RoastItem = z.infer<typeof RoastItemSchema>;

export const RoastOrderEdgeSchema = z.object({
  pk: z.string().startsWith(ROAST_PK_PREFIX),
  sk: z.string().startsWith(ORDER_EDGE_PREFIX),
  entity: z.literal('RoastAllocation'),
  tenant_id: TenantIdSchema,
  order_id: OrderIdSchema,
  product_id: ProductIdSchema,
  kg: z.number().int().min(1),
});
export type RoastOrderEdge = z.infer<typeof RoastOrderEdgeSchema>;

export const AllocationSchema = z.strictObject({
  tenant_id: TenantIdSchema,
  order_id: OrderIdSchema,
  kg: z.number().int().min(1).max(MAX_BATCH_KG),
});

/** POST /admin/roasts 的 body / Request body. */
export const CreateRoastRequestSchema = z
  .strictObject({
    product_id: ProductIdSchema,
    roast_date: IsoDateSchema,
    kg: z.number().int().min(1).max(MAX_BATCH_KG),
    allocations: z.array(AllocationSchema).min(1).max(MAX_ALLOCATIONS),
  })
  .refine((r) => new Set(r.allocations.map((a) => `${a.tenant_id}#${a.order_id}`)).size === r.allocations.length, {
    message: 'Each order may appear only once',
    path: ['allocations'],
  })
  .refine((r) => r.allocations.reduce((s, a) => s + a.kg, 0) <= r.kg, {
    message: 'Allocated kilograms exceed the batch size',
    path: ['allocations'],
  });
export type CreateRoastRequest = z.infer<typeof CreateRoastRequestSchema>;

/** 請求指紋（分配排序後雜湊）/ Request fingerprint with allocations sorted. */
export function roastRequestHash(r: CreateRoastRequest): string {
  const allocs = [...r.allocations].map((a) => [a.tenant_id, a.order_id, a.kg]).sort((a, b) => String(a).localeCompare(String(b)));
  return createHash('sha256').update(JSON.stringify([r.product_id, r.roast_date, r.kg, allocs])).digest('hex');
}

export const PatchRoastRequestSchema = z.strictObject({ status: z.literal('ROASTED') });
export const RecallRequestSchema = z.strictObject({
  // 會出現在公開頁，所以長度有限、只允許一般文字 / Shown publicly: bounded, plain text.
  notice: z.string().trim().min(5).max(200).regex(/^[^<>]*$/, 'no angle brackets'),
});
export const RestockRequestSchema = z.strictObject({
  kg: z.number().int().min(1).max(MAX_RESTOCK_KG),
  /** 樂觀鎖：GET /admin/products/{id}/stock 讀到的版本 / Optimistic lock from the stock read. */
  expected_version: z.number().int().min(1),
});

/** staff／烘焙廠看的烘焙批次 DTO / Roast batch DTO for staff and the roastery. */
export function toAdminRoast(r: RoastItem) {
  return {
    roast_id: r.roast_id,
    product_id: r.product_id,
    lot_id: r.lot_id,
    roast_date: r.roast_date,
    roast_level: r.roast_level,
    kg: r.kg,
    status: r.status,
    created_at: r.created_at,
    roasted_at: r.roasted_at,
    qr_token: r.qr_token,
    recall: r.recall ? { at: r.recall.at, notice: r.recall.notice } : undefined,
    synthetic: r.synthetic === true,
  };
}

export function toAdminLot(l: LotItem) {
  return {
    lot_id: l.lot_id,
    producer_display_name: l.producer_display_name,
    origin_country: l.origin_country,
    region: l.region,
    altitude_m: l.altitude_m,
    variety: l.variety,
    process: l.process,
    cup_score: l.cup_score,
    harvest: l.harvest,
  };
}
