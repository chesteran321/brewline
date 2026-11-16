import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { z } from 'zod';
import { EVENT_SOURCE } from '../events/order-events';
import { TenantIdSchema } from '../lib/order-model';
import { OrderRepo } from '../lib/order-repo';
import {
  ReplenishmentIdSchema,
  isRunWeek,
  replenishIdempotencyKey,
  taipeiDate,
} from '../lib/replenishment-model';
import { ReplenishmentRepo } from '../lib/replenishment-repo';
import { logger, orderRepo, replenishmentRepo, tracer } from '../lib/runtime';
import { ulid } from '../lib/ulid';

/**
 * 定期補貨的執行（A4e，ADR-029 D6）：Scheduler 觸發 → 讀補貨設定 → 用**和 POST /orders 同一套**下單程式建立訂單。
 * Replenishment run: Scheduler fires → read the subscription → place the order with the same code as POST /orders.
 *
 * - 函數角色 `brewline-<env>-orders-replenish` 扮演租戶角色：只碰得到該租戶的資料。
 * - 冪等鍵 = 補貨 ID ＋ 觸發日期 → Scheduler 重送同一次觸發只會有一張訂單。
 * - 庫存不足或商品下架：發布 `ReplenishmentFailed`（通知函數寄信），**不重試**。
 * - 已刪除的訂閱、雙週的休息週：什麼都不做。
 */

export const ReplenishInputSchema = z.object({
  tenant_id: TenantIdSchema,
  replenishment_id: ReplenishmentIdSchema,
  scheduled_time: z.iso.datetime(),
});
export type ReplenishInput = z.infer<typeof ReplenishInputSchema>;

export class RetryableError extends Error {
  override readonly name = 'RetryableError';
}

export type ReplenishOutcome =
  | 'ordered'
  | 'replayed'
  | 'skipped_inactive'
  | 'skipped_off_week'
  | 'failed_stock'
  | 'failed_products'
  | 'idempotency_mismatch';

export interface ReplenishDeps {
  readonly repo: Pick<ReplenishmentRepo, 'get'>;
  readonly orders: Pick<OrderRepo, 'createOrder'>;
  readonly publish: (detailType: 'ReplenishmentFailed', detail: Record<string, unknown>) => Promise<void>;
  readonly now?: () => Date;
}

export async function runReplenishment(raw: unknown, d: ReplenishDeps): Promise<{ outcome: ReplenishOutcome; order_id?: string }> {
  const input = ReplenishInputSchema.parse(raw); // 格式錯誤 → 拋出，進 DLQ / Malformed input → error → DLQ.
  const now = d.now ?? (() => new Date());
  const scheduledAt = new Date(input.scheduled_time);
  const log = { tenant_id: input.tenant_id, replenishment_id: input.replenishment_id, scheduled_date: taipeiDate(scheduledAt) };

  const sub = await d.repo.get(input.tenant_id, input.replenishment_id);
  if (!sub || sub.status !== 'active') {
    logger.info('replenishment inactive, skipped', log);
    return { outcome: 'skipped_inactive' };
  }
  if (!isRunWeek(sub, scheduledAt)) {
    logger.info('biweekly off week, skipped', log);
    return { outcome: 'skipped_off_week' };
  }

  const r = await d.orders.createOrder({
    tenantId: input.tenant_id,
    createdBy: 'system:replenish',
    idempotencyKey: replenishIdempotencyKey(input.replenishment_id, scheduledAt),
    request: { items: sub.items },
    orderId: `o_${ulid()}`,
    now: now(),
  });
  logger.info('replenishment run', { ...log, outcome: r.kind, ...('order' in r ? { order_id: r.order.order_id } : {}) });

  switch (r.kind) {
    case 'created':
      return { outcome: 'ordered', order_id: r.order.order_id };
    case 'replayed':
      return { outcome: 'replayed', order_id: r.order.order_id };
    case 'insufficient_stock':
    case 'unknown_products': {
      // event_id 固定 → 重送時通知函數會去重 / Stable event_id so the notifier dedupes retries.
      await d.publish('ReplenishmentFailed', {
        event_id: `rf-${input.replenishment_id}-${log.scheduled_date}`,
        occurred_at: now().toISOString(),
        tenant_id: input.tenant_id,
        replenishment_id: input.replenishment_id,
        scheduled_date: log.scheduled_date,
        reason: r.kind,
        product_ids: r.productIds,
      });
      return { outcome: r.kind === 'insufficient_stock' ? 'failed_stock' : 'failed_products' };
    }
    case 'idempotency_mismatch':
      // 同一天的鍵卻是不同內容：不應發生（品項不可修改）→ 記錄、不重試 / Should not happen; log, no retry.
      logger.error('replenishment idempotency mismatch', log);
      return { outcome: 'idempotency_mismatch' };
    case 'throttled':
    case 'busy':
      // 交給 Lambda 非同步重試（Scheduler → Lambda 是非同步呼叫）/ Let async retries handle it.
      throw new RetryableError(r.kind);
  }
}

let deps: ReplenishDeps | undefined;

export const handler = async (event: unknown) => {
  if (!deps) {
    const busName = process.env.BUS_NAME;
    if (!busName) throw new Error('Missing environment variable BUS_NAME');
    const events = tracer.captureAWSv3Client(new EventBridgeClient({}));
    deps = {
      repo: replenishmentRepo(),
      orders: orderRepo(),
      publish: async (detailType, detail) => {
        const out = await events.send(
          new PutEventsCommand({
            Entries: [{ EventBusName: busName, Source: EVENT_SOURCE, DetailType: detailType, Detail: JSON.stringify(detail) }],
          }),
        );
        if (out.FailedEntryCount) throw new Error(`PutEvents failed: ${out.Entries?.[0]?.ErrorCode}`);
      },
    };
  }
  return runReplenishment(event, deps);
};
