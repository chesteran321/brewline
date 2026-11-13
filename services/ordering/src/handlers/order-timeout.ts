import { z } from 'zod';
import { OrderIdSchema, TenantIdSchema } from '../lib/order-model';
import { adminOrderRepo, logger } from '../lib/runtime';

/**
 * Step Functions 的工作：逾時仍未確認的訂單 → 取消並釋放庫存（A3d，ADR-028；緩解 RSK-016）。
 * Step Functions task: cancel an order that is still CREATED after the timeout and release its stock.
 *
 * 冪等：只在狀態仍是 CREATED 時取消（條件寫入）。同一筆訂單被觸發兩次也只會取消一次；
 * 已確認、已取消或已刪除（smoke test 清理）的訂單一律視為「不用處理」。
 * Idempotent: cancels only while still CREATED (conditional write); duplicates are harmless.
 */

const Input = z.object({ tenant_id: TenantIdSchema, order_id: OrderIdSchema });

export class RetryableError extends Error {
  override readonly name = 'RetryableError';
}

export type TimeoutOutcome = 'cancelled' | 'already_moved' | 'not_found';

export const handler = async (event: unknown): Promise<{ outcome: TimeoutOutcome; status?: string }> => {
  const input = Input.parse(event); // 格式錯誤 → 失敗（不重試）/ Malformed input fails without retry.
  const r = await adminOrderRepo().transition({
    tenantId: input.tenant_id,
    orderId: input.order_id,
    to: 'CANCELLED',
    actor: 'system:timeout',
    now: new Date(),
    onlyFrom: ['CREATED'],
  });
  logger.info('order timeout', { ...input, outcome: r.kind, ...('current' in r ? { current: r.current } : {}) });
  switch (r.kind) {
    case 'updated':
      return { outcome: 'cancelled', status: r.order.status };
    case 'invalid_transition':
      return { outcome: 'already_moved', status: r.current };
    case 'not_found':
      return { outcome: 'not_found' };
    case 'conflict':
    case 'busy':
      // 狀態剛好在這時被改、或暫時忙碌 → 交給 Step Functions 重試 / Let Step Functions retry.
      throw new RetryableError(r.kind);
  }
};
