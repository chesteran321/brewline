import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { DynamoDBRecord } from 'aws-lambda';

/**
 * DynamoDB Streams 紀錄 → 領域事件（A3b，ADR-026）。純函數，方便單元測試。
 * Maps stream records to domain events. Pure, for unit testing.
 *
 * | 事件 detail-type    | 條件 Condition                                                     |
 * |---------------------|--------------------------------------------------------------------|
 * | OrderCreated        | INSERT，entity = Order                                             |
 * | OrderStatusChanged  | MODIFY，entity = Order，status 改變                                  |
 * | StockLow            | MODIFY，sk = STOCK，available_kg 從 ≥ 門檻 **跌破** 門檻（只在跨越時發一次） |
 *
 * detail 一律白名單：不含 created_by（使用者 sub）、pk／sk、冪等鍵。
 * Details are allow-listed: never the user's sub, keys, or idempotency key.
 */

export const EVENT_SOURCE = 'brewline.ordering';

export type DetailType = 'OrderCreated' | 'OrderStatusChanged' | 'StockLow';

export interface DomainEvent {
  readonly detailType: DetailType;
  readonly time: Date;
  readonly detail: Record<string, unknown>;
}

type Item = Record<string, unknown>;

function image(raw: unknown): Item | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  return unmarshall(raw as Record<string, AttributeValue>) as Item;
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function lines(items: unknown): Array<{ product_id: string; qty_kg: number }> {
  if (!Array.isArray(items)) return [];
  return items.flatMap((l) => {
    const pid = str((l as Item)?.product_id);
    const qty = num((l as Item)?.qty_kg);
    return pid && qty !== undefined ? [{ product_id: pid, qty_kg: qty }] : [];
  });
}

/**
 * 一筆 stream 紀錄最多產生 1 個事件。event_id 用 stream 的 eventID：同一筆紀錄重試時 event_id 相同，下游可以去重。
 * At most one event per record. event_id is the stream eventID, stable across retries, so consumers can dedupe.
 */
export function toDomainEvent(record: DynamoDBRecord): DomainEvent | undefined {
  const ddb = record.dynamodb;
  if (!ddb || !record.eventID) return undefined;
  const now = image(ddb.NewImage);
  const old = image(ddb.OldImage);
  const time = ddb.ApproximateCreationDateTime ? new Date(ddb.ApproximateCreationDateTime * 1000) : new Date();
  const base = { event_id: record.eventID, occurred_at: time.toISOString() };

  if (now?.entity === 'Order') {
    const order = {
      tenant_id: str(now.tenant_id),
      order_id: str(now.order_id),
      status: str(now.status),
    };
    if (!order.tenant_id || !order.order_id || !order.status) return undefined;
    if (record.eventName === 'INSERT') {
      return {
        detailType: 'OrderCreated',
        time,
        detail: {
          ...base,
          ...order,
          payment_status: str(now.payment_status),
          total: num(now.total),
          currency: str(now.currency),
          items: lines(now.items),
        },
      };
    }
    if (record.eventName === 'MODIFY' && old && old.status !== now.status) {
      return {
        detailType: 'OrderStatusChanged',
        time,
        detail: { ...base, ...order, previous_status: str(old.status), items: lines(now.items) },
      };
    }
    return undefined;
  }

  if (record.eventName === 'MODIFY' && now?.sk === 'STOCK' && old) {
    const threshold = num(now.low_threshold_kg) ?? 0;
    const before = num(old.available_kg);
    const after = num(now.available_kg);
    const pk = str(now.pk);
    if (threshold > 0 && before !== undefined && after !== undefined && before >= threshold && after < threshold && pk?.startsWith('PRODUCT#')) {
      return {
        detailType: 'StockLow',
        time,
        detail: { ...base, product_id: pk.slice('PRODUCT#'.length), available_kg: after, low_threshold_kg: threshold },
      };
    }
  }
  return undefined;
}
