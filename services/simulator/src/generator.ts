import { createHash } from 'node:crypto';
import { SimulatorConfig } from './config';

/**
 * 訂單產生器（ADR-030 D4／D8，SIM-F-003／008／009）。純函數：同樣的（種子、日期、小時、商品清單）永遠得到同樣的計畫，
 * 所以排程重複觸發或手動重跑同一小時只會「重播」（冪等鍵相同），不會多下單。
 * Pure order planner: the same (seed, date, hour, product list) always yields the same plan, so a re-run of an hour
 * replays the same Idempotency-Keys instead of creating new orders.
 *
 * 每日筆數＝範圍中點 × 季節 × 星期 × 雜訊（±25%），夾在設定的最小／最大值之間；再依每小時權重分配到 08–19 時。
 * Daily count = midpoint × season × weekday × noise (±25%), clamped to the configured range, then spread over 08–19.
 */

/** 季節（1–12 月）：天氣轉涼時熱飲需求較高；2 月農曆年較低 / Cooler months sell more; Lunar New Year dips. */
export const SEASON = [1.1, 0.95, 1.0, 1.0, 0.95, 0.9, 0.9, 0.9, 0.95, 1.05, 1.1, 1.15] as const;
/** 星期（週日＝0）：咖啡廳多在週初補貨 / Cafés restock early in the week. */
export const WEEKDAY = [0.3, 1.4, 1.2, 1.0, 1.0, 1.1, 0.5] as const;
/** 台北 08–19 時的權重 / Hour weights for 08:00–19:00 Taipei. */
export const HOURS = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19] as const;
export const HOUR_WEIGHTS = [0.6, 1.4, 1.6, 1.3, 0.7, 0.6, 1.0, 1.1, 0.9, 0.5, 0.2, 0.1] as const;

/** 由多個部分決定的亂數產生器（mulberry32）/ Deterministic PRNG seeded from the given parts. */
export function rng(...parts: (string | number)[]): () => number {
  let a = createHash('sha256').update(parts.join('|')).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const intIn = (r: () => number, min: number, max: number) => min + Math.floor(r() * (max - min + 1));
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(date: string): { year: number; month: number; dow: number } {
  if (!DATE.test(date)) throw new Error(`date must be YYYY-MM-DD, got ${date}`);
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date) throw new Error(`invalid date ${date}`);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, dow: d.getUTCDay() };
}

/** 當天的訂單總數 / Orders for the day. */
export function dailyCount(cfg: SimulatorConfig, date: string): number {
  const { month, dow } = parseDate(date);
  const { min, max } = cfg.ordersPerDay;
  const noise = 0.75 + rng(cfg.seed, date, 'daily')() * 0.5;
  const n = Math.round(((min + max) / 2) * SEASON[month - 1]! * WEEKDAY[dow]! * noise);
  return Math.min(max, Math.max(min, n));
}

/** 每小時筆數（索引對應 HOURS），總和＝dailyCount / Orders per hour; sums to dailyCount. */
export function hourlyCounts(cfg: SimulatorConfig, date: string): number[] {
  const total = HOUR_WEIGHTS.reduce((a, b) => a + b, 0);
  const counts = HOURS.map(() => 0);
  const n = dailyCount(cfg, date);
  for (let i = 0; i < n; i++) {
    let x = rng(cfg.seed, date, 'hour', i)() * total;
    let h = 0;
    while (x >= HOUR_WEIGHTS[h]! && h < HOURS.length - 1) x -= HOUR_WEIGHTS[h++]!;
    counts[h]!++;
  }
  return counts;
}

/**
 * 啟用中的模擬咖啡廳數：一開始 `initialActive`，之後每個月由種子決定多 1 或 2 家（SIM-F-001 的「每月新增 1–2 家」）。
 * Active cafés: `initialActive`, then 1–2 more per month after `activationStartMonth`, capped at the pool size.
 */
export function activeTenants(cfg: SimulatorConfig, date: string): number {
  const { year, month } = parseDate(date);
  const [sy, sm] = cfg.activationStartMonth.split('-').map(Number) as [number, number];
  const months = (year - sy) * 12 + (month - sm);
  let n = cfg.initialActive;
  for (let m = 1; m <= months; m++) n += intIn(rng(cfg.seed, 'activate', m), 1, 2);
  return Math.min(cfg.poolSize, n);
}

export interface PlannedLine {
  readonly product_id: string;
  readonly qty_kg: number;
}

export interface PlannedOrder {
  readonly date: string;
  readonly hour: number;
  readonly seq: number;
  /** sim-NNN 的 NNN（1 起算）/ 1-based account index. */
  readonly tenantIndex: number;
  readonly idempotencyKey: string;
  readonly items: readonly PlannedLine[];
  /** 送出後再用同一個 key 重送一次（SIM-F-008）/ Resend with the same key once (fault injection). */
  readonly duplicate: boolean;
}

/** `sim-` ＋ 32 個十六進位字元（符合 16–64 個 URL 安全字元）/ Matches the API's Idempotency-Key rule. */
export function idempotencyKey(seed: string, date: string, hour: number, seq: number): string {
  return `sim-${createHash('sha256').update(`${seed}|${date}|${hour}|${seq}`).digest('hex').slice(0, 32)}`;
}

/**
 * 一個小時的計畫。商品從**完整目錄**挑選（不看當下庫存），執行時再拿掉缺貨的商品 → 冪等鍵與挑選結果不受庫存影響。
 * Products are picked from the full catalog (not current stock) and filtered at run time, so keys and picks are
 * independent of stock levels.
 */
export function planHour(cfg: SimulatorConfig, date: string, hour: number, productIds: readonly string[]): PlannedOrder[] {
  const idx = HOURS.indexOf(hour as (typeof HOURS)[number]);
  if (idx < 0) return [];
  const catalog = [...productIds].sort();
  if (catalog.length === 0) throw new Error('empty catalog');
  const tenants = activeTenants(cfg, date);
  const n = hourlyCounts(cfg, date)[idx]!;
  const out: PlannedOrder[] = [];
  for (let seq = 0; seq < n; seq++) {
    const r = rng(cfg.seed, date, hour, seq, 'order');
    const tenantIndex = intIn(r, 1, tenants);
    const lines = Math.min(intIn(r, cfg.linesPerOrder.min, cfg.linesPerOrder.max), catalog.length);
    const pool = [...catalog];
    const items: PlannedLine[] = [];
    for (let l = 0; l < lines; l++) {
      const [product] = pool.splice(Math.floor(r() * pool.length), 1);
      items.push({ product_id: product!, qty_kg: intIn(r, cfg.kgPerLine.min, cfg.kgPerLine.max) });
    }
    out.push({
      date,
      hour,
      seq,
      tenantIndex,
      idempotencyKey: idempotencyKey(cfg.seed, date, hour, seq),
      items: items.sort((a, b) => a.product_id.localeCompare(b.product_id)),
      duplicate: r() < cfg.duplicateOrderRate,
    });
  }
  return out;
}

export function planDay(cfg: SimulatorConfig, date: string, productIds: readonly string[]): PlannedOrder[] {
  return HOURS.flatMap((h) => planHour(cfg, date, h, productIds));
}

/** 計畫的雜湊（SIM-F-009 驗收：同一種子重跑兩次結果相同）/ Plan hash for the reproducibility check. */
export function planHash(plan: readonly PlannedOrder[]): string {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}

/** 台北的日期與小時 / Date and hour in Asia/Taipei. */
export function taipeiNow(now: Date = new Date()): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}
