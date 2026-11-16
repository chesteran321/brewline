import { z } from 'zod';
import { MAX_LINES, OrderLineInputSchema, tenantPk } from './order-model';
import { ULID_PATTERN } from './ulid';

/**
 * 定期補貨（A4e，ADR-029 D6）。每租戶最多 5 筆；`TENANT#<t>` / `REPL#<ULID>` 是正本，
 * EventBridge Scheduler 排程 `brewline-<env>-replenish/<tenant_id>-<replenishment_id>` 負責觸發。
 * Recurring replenishment. DynamoDB is the source of truth; one Scheduler schedule per subscription fires it.
 *
 * 時間一律台北 09:00（`Asia/Taipei`，無日光節約）/ Always 09:00 Asia/Taipei (no DST).
 */

export const MAX_REPLENISHMENTS_PER_TENANT = 5;
export const REPL_SK_PREFIX = 'REPL#';
export const REPL_ENTITY = 'Replenishment';
/** 軟刪除後保留 30 天（TTL）；租戶角色沒有 DeleteItem / Soft delete kept 30 days; the tenant role cannot delete. */
export const DELETED_TTL_SECONDS = 30 * 24 * 60 * 60;
export const SCHEDULE_TIMEZONE = 'Asia/Taipei';
export const RUN_HOUR = 9;
/** 台北與 UTC 的時差（小時）/ Taipei offset from UTC. */
const TAIPEI_OFFSET_HOURS = 8;

export const ReplenishmentIdSchema = z.string().regex(/^r_[0-9A-HJKMNP-TV-Z]{26}$/);
export const DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;

// 品項規則與 POST /orders 完全相同（≤ 25 行、每行 1–500 kg、商品不重複）/ Same line rules as POST /orders.
const Lines = z.array(OrderLineInputSchema).min(1).max(MAX_LINES);

export const CreateReplenishmentSchema = z
  .discriminatedUnion('frequency', [
    z.strictObject({ frequency: z.literal('weekly'), day_of_week: z.enum(DAYS), items: Lines }),
    z.strictObject({ frequency: z.literal('biweekly'), day_of_week: z.enum(DAYS), items: Lines }),
    // 只允許 1–28 日：每個月都有（F4）/ 1–28 only, so every month has the day.
    z.strictObject({ frequency: z.literal('monthly'), day_of_month: z.number().int().min(1).max(28), items: Lines }),
  ])
  .refine((r) => new Set(r.items.map((i) => i.product_id)).size === r.items.length, {
    message: 'Each product may appear only once',
    path: ['items'],
  });
export type CreateReplenishment = z.infer<typeof CreateReplenishmentSchema>;

export const ReplenishmentItemSchema = z.object({
  pk: z.string(),
  sk: z.string(),
  entity: z.literal(REPL_ENTITY),
  replenishment_id: ReplenishmentIdSchema,
  tenant_id: z.string(),
  status: z.enum(['active', 'deleted']),
  frequency: z.enum(['weekly', 'biweekly', 'monthly']),
  day_of_week: z.enum(DAYS).optional(),
  day_of_month: z.number().int().optional(),
  items: z.array(z.object({ product_id: z.string(), qty_kg: z.number() })),
  /** 雙週的起算日（台北日期 YYYY-MM-DD）/ Biweekly anchor date (Taipei). */
  anchor_date: z.string(),
  schedule_name: z.string(),
  created_at: z.string(),
  created_by: z.string(),
  deleted_at: z.string().optional(),
  expires_at: z.number().optional(),
});
export type ReplenishmentItem = z.infer<typeof ReplenishmentItemSchema>;

export const replSk = (id: string) => `${REPL_SK_PREFIX}${id.slice(2)}`;
export const replIdFromSk = (sk: string) => `r_${sk.slice(REPL_SK_PREFIX.length)}`;

/** 排程名稱：≤ 64 字元，前綴是租戶 → 一眼看出屬於誰 / ≤ 64 chars, tenant-prefixed. */
export const scheduleName = (tenantId: string, replenishmentId: string) => `${tenantId}-${replenishmentId}`;

/**
 * Scheduler 的 cron（台北時區）。雙週也用每週觸發，由函數判斷單雙週（F3）。
 * Scheduler cron in Asia/Taipei. Biweekly fires weekly; the function skips odd weeks.
 */
export function scheduleExpression(r: Pick<ReplenishmentItem, 'frequency' | 'day_of_week' | 'day_of_month'>): string {
  if (r.frequency === 'monthly') return `cron(0 ${RUN_HOUR} ${r.day_of_month} * ? *)`;
  return `cron(0 ${RUN_HOUR} ? * ${r.day_of_week} *)`;
}

/** UTC 時間 → 台北日期 YYYY-MM-DD / UTC instant → Taipei calendar date. */
export function taipeiDate(at: Date): string {
  return new Date(at.getTime() + TAIPEI_OFFSET_HOURS * 3600_000).toISOString().slice(0, 10);
}

/** 該日期所在週的星期一（ISO 週）/ Monday of the ISO week containing the date. */
function mondayOf(date: string): number {
  const d = new Date(`${date}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // 0 = Monday
  return d.getTime() - dow * 86_400_000;
}

/**
 * 雙週：從起算日那一週算起，第 0、2、4… 週執行。
 * Biweekly runs on weeks 0, 2, 4… counted from the anchor's week.
 */
export function isRunWeek(r: Pick<ReplenishmentItem, 'frequency' | 'anchor_date'>, scheduledAt: Date): boolean {
  if (r.frequency !== 'biweekly') return true;
  const weeks = Math.round((mondayOf(taipeiDate(scheduledAt)) - mondayOf(r.anchor_date)) / (7 * 86_400_000));
  return weeks >= 0 && weeks % 2 === 0;
}

/**
 * 冪等鍵 = 補貨 ID ＋ 排定時間（台北日期）：Scheduler 重送同一次觸發 → 同一張訂單（ADR-029 D6）。
 * Idempotency key = replenishment id + scheduled Taipei date: retries of one firing map to one order.
 */
export function replenishIdempotencyKey(replenishmentId: string, scheduledAt: Date): string {
  return `rp-${replenishmentId.slice(2)}-${taipeiDate(scheduledAt).replaceAll('-', '')}`;
}

export interface PublicReplenishment {
  readonly replenishment_id: string;
  readonly frequency: ReplenishmentItem['frequency'];
  readonly day_of_week?: string;
  readonly day_of_month?: number;
  readonly items: ReplenishmentItem['items'];
  readonly run_at: string;
  readonly created_at: string;
}

export function toPublicReplenishment(r: ReplenishmentItem): PublicReplenishment {
  return {
    replenishment_id: r.replenishment_id,
    frequency: r.frequency,
    ...(r.day_of_week ? { day_of_week: r.day_of_week } : {}),
    ...(r.day_of_month ? { day_of_month: r.day_of_month } : {}),
    items: r.items,
    run_at: `${String(RUN_HOUR).padStart(2, '0')}:00 ${SCHEDULE_TIMEZONE}`,
    created_at: r.created_at,
  };
}

export function newReplenishmentItem(
  tenantId: string,
  id: string,
  req: CreateReplenishment,
  createdBy: string,
  now: Date,
): ReplenishmentItem {
  if (!ULID_PATTERN.test(id.slice(2))) throw new Error('bad replenishment id');
  return {
    pk: tenantPk(tenantId),
    sk: replSk(id),
    entity: REPL_ENTITY,
    replenishment_id: id,
    tenant_id: tenantId,
    status: 'active',
    frequency: req.frequency,
    ...('day_of_week' in req ? { day_of_week: req.day_of_week } : {}),
    ...('day_of_month' in req ? { day_of_month: req.day_of_month } : {}),
    items: req.items,
    anchor_date: taipeiDate(now),
    schedule_name: scheduleName(tenantId, id),
    created_at: now.toISOString(),
    created_by: createdBy,
  };
}
