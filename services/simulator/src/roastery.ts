import { createHash } from 'node:crypto';
import seedProducts from '../../ordering/seed/products.json';

/**
 * 模擬烘焙廠（S2d，ADR-031 D8）。以 `simulator-roastery` 帳號經由**公開 API** 推進模擬訂單（ADR-011），
 * 跟模擬咖啡廳在同一個排程函數裡跑（同一個開關、同一個 `run-errors` 告警，方案 A）。
 * Simulated roastery: advances synthetic orders through the public API as the `simulator-roastery` account,
 * inside the same scheduled function as the cafés (same switch, same `run-errors` alarm).
 *
 * | 台北時段 | 步驟 |
 * |---|---|
 * | 每小時 | confirm：CREATED → CONFIRMED（90%，依訂單 ID 雜湊決定；其餘交給逾時工作流取消）|
 * | 16 時 | schedule：CONFIRMED → ROASTING_SCHEDULED，依商品裝箱成烘焙批次（明天烘焙）；restock：低庫存補回初始量 |
 * | 09 時 | roast：已分配的批次 → ROASTED（產生 QR、公開頁上線），全數分配的訂單 → ROASTED |
 * | 14 時 | ship：ROASTED → SHIPPED |
 * | 10 時 | complete：出貨滿 2 天 → COMPLETED |
 *
 * 每一步都是「讀目前狀態 → 只處理還沒做的」，所以同一小時重跑是安全的（批次的 Idempotency-Key 由內容決定）。
 * Every step reads current state and only does what is left, so re-running an hour is safe.
 */

export const ROASTERY_STEPS = ['confirm', 'schedule', 'restock', 'roast', 'ship', 'complete'] as const;
export type RoasteryStep = (typeof ROASTERY_STEPS)[number];

/** 每小時都先確認；特定時段再做其他步驟 / Confirm every hour; other steps at fixed hours. */
const STEPS_AT_HOUR: Readonly<Record<number, readonly RoasteryStep[]>> = {
  9: ['roast'],
  10: ['complete'],
  14: ['ship'],
  16: ['schedule', 'restock'],
};
export function stepsForHour(hour: number): RoasteryStep[] {
  return ['confirm', ...(STEPS_AT_HOUR[hour] ?? [])];
}

export const CONFIRM_RATE = 0.9;
export const COMPLETE_AFTER_DAYS = 2;
/** 烘焙機一批的上限與一批最多幾張訂單（與 services/ordering 的 MAX_BATCH_KG／MAX_ALLOCATIONS 相同）。 */
export const MAX_BATCH_KG = 15;
export const MAX_ALLOCATIONS = 15;
export const MAX_RESTOCK_KG = 500;
/** admin 路由沒有 POST /orders 的路由限流；stage 限流 Dev 10／Prod 50 rps → 每 300 ms 一個請求 / ~3 rps. */
export const ROASTERY_PACE_MS = 300;
/** 每個步驟最多讀幾頁（50 筆／頁）/ Page cap per listing. */
export const MAX_PAGES = 20;

const INITIAL_STOCK: ReadonlyMap<string, number> = new Map(
  (seedProducts as { id: string; initial_stock_kg: number }[]).map((p) => [p.id, p.initial_stock_kg]),
);
export const RESTOCK_PRODUCT_IDS: readonly string[] = [...INITIAL_STOCK.keys()];

/** 確認與否由訂單 ID 決定（同一張訂單每一輪結果相同）/ Deterministic per order id. */
export function shouldConfirm(orderId: string, rate = CONFIRM_RATE): boolean {
  const n = createHash('sha256').update(`confirm|${orderId}`).digest().readUInt32BE(0);
  return n / 0x1_0000_0000 < rate;
}

export interface AdminOrderView {
  readonly order_id: string;
  readonly tenant_id: string;
  readonly status: string;
  readonly synthetic: boolean;
  readonly status_history: readonly { readonly to: string; readonly at: string }[];
  readonly allocations: readonly { readonly product_id: string; readonly qty_kg: number; readonly allocated_kg: number; readonly roast_ids: readonly string[] }[];
}

export interface PlannedBatch {
  readonly product_id: string;
  readonly kg: number;
  readonly allocations: readonly { readonly tenant_id: string; readonly order_id: string; readonly kg: number }[];
}

/**
 * 依商品把尚未分配的公斤數裝箱：每批 ≤ 15 kg、≤ 15 張訂單、同一張訂單在一批裡只出現一次；
 * 一行超過剩餘空間時拆到下一批。順序固定（商品、訂單 ID），所以同樣的輸入得到同樣的批次。
 * Packs unallocated kilograms per product: ≤ 15 kg and ≤ 15 orders per batch, an order at most once per batch;
 * a line that does not fit is split into the next batch. Deterministic order (product, order id).
 */
export function planBatches(orders: readonly AdminOrderView[]): PlannedBatch[] {
  const byProduct = new Map<string, { tenant_id: string; order_id: string; kg: number }[]>();
  for (const o of [...orders].sort((a, b) => a.order_id.localeCompare(b.order_id))) {
    for (const l of o.allocations) {
      const remaining = l.qty_kg - l.allocated_kg;
      if (remaining <= 0) continue;
      const list = byProduct.get(l.product_id) ?? [];
      list.push({ tenant_id: o.tenant_id, order_id: o.order_id, kg: remaining });
      byProduct.set(l.product_id, list);
    }
  }
  const batches: PlannedBatch[] = [];
  for (const productId of [...byProduct.keys()].sort()) {
    let current: { tenant_id: string; order_id: string; kg: number }[] = [];
    let used = 0;
    const flush = () => {
      if (current.length > 0) batches.push({ product_id: productId, kg: used, allocations: current });
      current = [];
      used = 0;
    };
    for (const line of byProduct.get(productId)!) {
      let left = line.kg;
      while (left > 0) {
        if (used >= MAX_BATCH_KG || current.length >= MAX_ALLOCATIONS) flush();
        const take = Math.min(left, MAX_BATCH_KG - used);
        current.push({ tenant_id: line.tenant_id, order_id: line.order_id, kg: take });
        used += take;
        left -= take;
        if (left > 0) flush(); // 拆行：同一張訂單不能在同一批出現兩次 / split lines go to the next batch
      }
    }
    flush();
  }
  return batches;
}

/** 批次的 Idempotency-Key＝內容雜湊：重跑得到同一個 key（200），內容不同就是新批次 / Content-derived key. */
export function batchKey(roastDate: string, b: PlannedBatch): string {
  const allocs = b.allocations.map((a) => `${a.tenant_id}#${a.order_id}#${a.kg}`).join(',');
  return `simroast-${createHash('sha256').update(`${roastDate}|${b.product_id}|${b.kg}|${allocs}`).digest('hex').slice(0, 40)}`;
}

/** YYYY-MM-DD 加減天數 / Shift an ISO date by days. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const taipeiDate = (iso: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

/** 最後一次變成 SHIPPED 的台北日期距今 ≥ 2 天 / Shipped at least two Taipei calendar days ago. */
export function dueForCompletion(o: AdminOrderView, today: string, days = COMPLETE_AFTER_DAYS): boolean {
  const shipped = [...o.status_history].reverse().find((h) => h.to === 'SHIPPED');
  if (!shipped) return false;
  return addDays(taipeiDate(shipped.at), days) <= today;
}

export interface StockView {
  readonly product_id: string;
  readonly available_kg: number;
  readonly low_threshold_kg: number;
  readonly version: number;
}

/** 低於門檻（與目錄的 low／out 相同）才補回初始量；0 = 不補 / Restock to the initial level when low or out. */
export function restockKg(s: StockView): number {
  const initial = INITIAL_STOCK.get(s.product_id);
  if (initial === undefined || s.available_kg > s.low_threshold_kg) return 0;
  return Math.max(0, Math.min(MAX_RESTOCK_KG, initial - s.available_kg));
}

// ---------------------------------------------------------------------------------------------------------------
// 執行 / Execution
// ---------------------------------------------------------------------------------------------------------------

export interface ApiResponse {
  readonly status: number;
  readonly body: Record<string, unknown> | undefined;
}
export type RoasteryApi = (path: string, init?: { method?: string; key?: string; body?: unknown }) => Promise<ApiResponse>;

export interface StepSummary {
  readonly step: RoasteryStep;
  readonly counts: Record<string, number>;
  readonly violations: readonly string[];
}

const errorCode = (r: ApiResponse) => String((r.body?.error as { code?: unknown } | undefined)?.code ?? '');

export class Roastery {
  private requests = 0;

  constructor(
    private readonly api: RoasteryApi,
    private readonly sleep: (ms: number) => Promise<void>,
    private readonly today: string,
  ) {}

  get requestCount(): number {
    return this.requests;
  }

  private async send(path: string, init?: { method?: string; key?: string; body?: unknown }): Promise<ApiResponse> {
    if (this.requests > 0) await this.sleep(ROASTERY_PACE_MS);
    this.requests++;
    let r = await this.api(path, init);
    if (r.status === 503) {
      // 交易衝突／節流：同樣的請求重試一次 / Conflict or throttle: retry once.
      await this.sleep(ROASTERY_PACE_MS);
      this.requests++;
      r = await this.api(path, init);
    }
    return r;
  }

  /** 列出某狀態的模擬訂單（API 對模擬呼叫者只回模擬訂單）/ Synthetic orders in a status. */
  async list(status: string, violations: string[]): Promise<AdminOrderView[]> {
    const out: AdminOrderView[] = [];
    let next: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const qs = new URLSearchParams({ status, limit: '50', ...(next ? { next_token: next } : {}) });
      const r = await this.send(`/admin/orders?${qs.toString()}`);
      if (r.status !== 200) {
        violations.push(`list ${status} → ${r.status}`);
        return out;
      }
      const items = Array.isArray(r.body?.items) ? (r.body.items as AdminOrderView[]) : [];
      out.push(...items.filter((o) => o.synthetic === true));
      next = typeof r.body?.next_token === 'string' ? r.body.next_token : undefined;
      if (!next) return out;
    }
    violations.push(`list ${status}: more than ${MAX_PAGES} pages`);
    return out;
  }

  private async transition(o: AdminOrderView, to: string): Promise<ApiResponse> {
    return this.send(`/admin/tenants/${o.tenant_id}/orders/${o.order_id}`, { method: 'PATCH', body: { status: to } });
  }

  /** 改狀態：200 成功；409 invalid_transition 表示已經被別人（或上一輪）推進 → 略過 / 409 = already moved. */
  private async advance(orders: readonly AdminOrderView[], to: string, counts: Record<string, number>, violations: string[]): Promise<void> {
    for (const o of orders) {
      const r = await this.transition(o, to);
      if (r.status === 200) counts.advanced = (counts.advanced ?? 0) + 1;
      else if (r.status === 409 && errorCode(r) === 'invalid_transition') counts.already = (counts.already ?? 0) + 1;
      else violations.push(`${o.order_id} → ${to}: ${r.status} ${errorCode(r)}`);
    }
  }

  async run(step: RoasteryStep): Promise<StepSummary> {
    const counts: Record<string, number> = {};
    const violations: string[] = [];
    switch (step) {
      case 'confirm': {
        const created = await this.list('CREATED', violations);
        const pick = created.filter((o) => shouldConfirm(o.order_id));
        counts.seen = created.length;
        counts.left_for_timeout = created.length - pick.length;
        await this.advance(pick, 'CONFIRMED', counts, violations);
        break;
      }
      case 'schedule': {
        const confirmed = await this.list('CONFIRMED', violations);
        await this.advance(confirmed, 'ROASTING_SCHEDULED', counts, violations);
        // 重新讀取：包含上一輪沒分配完的訂單 / Re-read, including orders a previous run left partly allocated.
        const scheduled = await this.list('ROASTING_SCHEDULED', violations);
        const roastDate = addDays(this.today, 1);
        const batches = planBatches(scheduled);
        counts.batches_planned = batches.length;
        for (const b of batches) {
          const r = await this.send('/admin/roasts', { method: 'POST', key: batchKey(roastDate, b), body: { product_id: b.product_id, roast_date: roastDate, kg: b.kg, allocations: b.allocations } });
          if (r.status === 201) counts.batches_created = (counts.batches_created ?? 0) + 1;
          else if (r.status === 200) counts.batches_replayed = (counts.batches_replayed ?? 0) + 1;
          else violations.push(`roast ${b.product_id} ${b.kg} kg → ${r.status} ${errorCode(r)}`);
        }
        break;
      }
      case 'restock': {
        for (const productId of RESTOCK_PRODUCT_IDS) {
          let r = await this.send(`/admin/products/${productId}/stock`);
          if (r.status !== 200) {
            violations.push(`stock ${productId} → ${r.status}`);
            continue;
          }
          let kg = restockKg(r.body as unknown as StockView);
          if (kg === 0) continue;
          let put = await this.send(`/admin/products/${productId}/restock`, { method: 'POST', body: { kg, expected_version: (r.body as unknown as StockView).version } });
          if (put.status === 409 && errorCode(put) === 'version_conflict') {
            // 有訂單同時扣庫存：重讀一次再補 / An order changed it meanwhile: read again once.
            r = await this.send(`/admin/products/${productId}/stock`);
            kg = r.status === 200 ? restockKg(r.body as unknown as StockView) : 0;
            if (kg === 0) continue;
            put = await this.send(`/admin/products/${productId}/restock`, { method: 'POST', body: { kg, expected_version: (r.body as unknown as StockView).version } });
          }
          if (put.status === 200) {
            counts.restocked = (counts.restocked ?? 0) + 1;
            counts.restocked_kg = (counts.restocked_kg ?? 0) + kg;
          } else violations.push(`restock ${productId} ${kg} kg → ${put.status} ${errorCode(put)}`);
        }
        break;
      }
      case 'roast': {
        const scheduled = await this.list('ROASTING_SCHEDULED', violations);
        const roastIds = [...new Set(scheduled.flatMap((o) => o.allocations.flatMap((l) => l.roast_ids)))].sort();
        for (const id of roastIds) {
          const r = await this.send(`/admin/roasts/${id}`, { method: 'PATCH', body: { status: 'ROASTED' } });
          if (r.status === 200) counts.batches_roasted = (counts.batches_roasted ?? 0) + 1;
          else if (r.status === 409 && errorCode(r) === 'invalid_state') counts.batches_already = (counts.batches_already ?? 0) + 1;
          else violations.push(`roast batch → ${r.status} ${errorCode(r)}`);
        }
        const ready = scheduled.filter((o) => o.allocations.every((l) => l.allocated_kg >= l.qty_kg));
        // 沒分配完的留給下一次 16 時排烘補上 / Partly allocated orders wait for the next schedule run.
        counts.not_fully_allocated = scheduled.length - ready.length;
        await this.advance(ready, 'ROASTED', counts, violations);
        break;
      }
      case 'ship': {
        await this.advance(await this.list('ROASTED', violations), 'SHIPPED', counts, violations);
        break;
      }
      case 'complete': {
        const shipped = await this.list('SHIPPED', violations);
        const due = shipped.filter((o) => dueForCompletion(o, this.today));
        counts.not_due = shipped.length - due.length;
        await this.advance(due, 'COMPLETED', counts, violations);
        break;
      }
    }
    return { step, counts, violations };
  }
}
