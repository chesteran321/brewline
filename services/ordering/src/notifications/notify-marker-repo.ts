import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { tenantPk } from '../lib/order-model';
import type { NotifyKind } from './order-email';

/**
 * 寄送記錄 `TENANT#<t>` / `NOTIFY#<event_id>`（ADR-029 D5）：EventBridge 至少送達一次 → 用條件寫入確保同一事件只寄一次。
 * 記錄不含收件地址（個資留在加密的聯絡人項目裡）；TTL 7 天。
 * Delivery record per event: EventBridge is at-least-once, so a conditional write ensures one e-mail per event.
 * No recipient address is stored; TTL 7 days.
 *
 * 狀態 / States: sending → sent | rejected | skipped_* ；failed（可重新認領 / reclaimable）
 */

export const NOTIFY_SK_PREFIX = 'NOTIFY#';
export const NOTIFY_TTL_SECONDS = 7 * 24 * 60 * 60;
/** 「寄送中」超過這個時間視為中斷，可重新認領 / A "sending" claim older than this is considered abandoned. */
export const STALE_CLAIM_MS = 60_000;

export type FinalStatus = 'sent' | 'rejected' | 'failed' | 'skipped_no_contact' | 'skipped_reserved';
export type ClaimResult = 'claimed' | 'done' | 'in_flight';

export class NotifyMarkerRepo {
  constructor(
    private readonly docFor: (tenantId: string) => DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  private key(tenantId: string, eventId: string) {
    return { pk: tenantPk(tenantId), sk: `${NOTIFY_SK_PREFIX}${eventId}` };
  }

  private base(tenantId: string, eventId: string, kind: NotifyKind, orderId: string, now: Date) {
    return {
      ...this.key(tenantId, eventId),
      entity: 'Notification',
      kind,
      order_id: orderId,
      expires_at: Math.floor(now.getTime() / 1000) + NOTIFY_TTL_SECONDS,
    };
  }

  /** 認領這個事件 / Claim the event for sending. */
  async claim(tenantId: string, eventId: string, kind: NotifyKind, orderId: string, now: Date): Promise<ClaimResult> {
    const doc = this.docFor(tenantId);
    try {
      await doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { ...this.base(tenantId, eventId, kind, orderId, now), status: 'sending', claimed_at: now.getTime() },
          // 第一次、上次失敗、或上次認領已過期 → 可以認領 / First time, previous failure, or an abandoned claim.
          ConditionExpression: 'attribute_not_exists(pk) OR #s = :failed OR (#s = :sending AND claimed_at < :stale)',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':failed': 'failed', ':sending': 'sending', ':stale': now.getTime() - STALE_CLAIM_MS },
        }),
      );
      return 'claimed';
    } catch (err) {
      if (!(err instanceof ConditionalCheckFailedException) && (err as Error).name !== 'ConditionalCheckFailedException') throw err;
      const cur = await doc.send(new GetCommand({ TableName: this.tableName, Key: this.key(tenantId, eventId), ConsistentRead: true }));
      return cur.Item?.status === 'sending' ? 'in_flight' : 'done';
    }
  }

  /** 寫入最終狀態（覆寫認領記錄）/ Record the outcome, overwriting the claim. */
  async finish(
    tenantId: string,
    eventId: string,
    kind: NotifyKind,
    orderId: string,
    status: FinalStatus,
    now: Date,
    messageId?: string,
  ): Promise<void> {
    await this.docFor(tenantId).send(
      new PutCommand({
        TableName: this.tableName,
        Item: { ...this.base(tenantId, eventId, kind, orderId, now), status, finished_at: now.toISOString(), message_id: messageId },
      }),
    );
  }
}
