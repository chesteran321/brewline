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
 * | RoastBatchRoasted   | MODIFY，entity = RoastBatch，status 變成 ROASTED（S2c，source `brewline.traceability`） |
 * | RoastBatchRecalled  | MODIFY，entity = RoastBatch，第一次出現 recall（S2c）                    |
 * | VesselDeparted      | MODIFY，entity = Shipment，status PLANNED → DEPARTED（P2b-2，source `brewline.shipment`） |
 * | VesselArrived       | MODIFY，entity = Shipment，status DEPARTED → ARRIVED（P2b-2）            |
 *
 * detail 一律白名單：不含 created_by（使用者 sub）、pk／sk、冪等鍵。模擬器的訂單另有 `synthetic: true`。
 * Details are allow-listed: never the user's sub, keys, or idempotency key.
 * 烘焙批次事件**不含 QR token**：token 只在資料表與公開投影中，不進事件日誌 / Roast events never carry the QR token.
 */

export const EVENT_SOURCE = 'brewline.ordering';
export const TRACE_EVENT_SOURCE = 'brewline.traceability';
export const SHIPMENT_EVENT_SOURCE = 'brewline.shipment';

export type DetailType =
  | 'OrderCreated'
  | 'OrderStatusChanged'
  | 'StockLow'
  | 'RoastBatchRoasted'
  | 'RoastBatchRecalled'
  | 'VesselDeparted'
  | 'VesselArrived';

export interface DomainEvent {
  readonly source: string;
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
      // 模擬資料標記（ADR-030 D6）：下游分析可以排除 / Synthetic marker so analytics can filter it out.
      ...(now.synthetic === true ? { synthetic: true } : {}),
    };
    if (!order.tenant_id || !order.order_id || !order.status) return undefined;
    if (record.eventName === 'INSERT') {
      return {
        source: EVENT_SOURCE,
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
        source: EVENT_SOURCE,
        detailType: 'OrderStatusChanged',
        time,
        detail: { ...base, ...order, previous_status: str(old.status), items: lines(now.items) },
      };
    }
    return undefined;
  }

  if (now?.entity === 'RoastBatch' && record.eventName === 'MODIFY' && old) {
    const roast = {
      roast_id: str(now.roast_id),
      product_id: str(now.product_id),
      lot_id: str(now.lot_id),
      ...(now.synthetic === true ? { synthetic: true } : {}),
    };
    if (!roast.roast_id || !roast.product_id || !roast.lot_id) return undefined;
    if (old.status !== 'ROASTED' && now.status === 'ROASTED') {
      return { source: TRACE_EVENT_SOURCE, detailType: 'RoastBatchRoasted', time, detail: { ...base, ...roast } };
    }
    if (!old.recall && now.recall) {
      return { source: TRACE_EVENT_SOURCE, detailType: 'RoastBatchRecalled', time, detail: { ...base, ...roast } };
    }
    return undefined;
  }

  // P2b-2（ADR-032 補充 E6）：偵測器只寫 DynamoDB，事件由 Streams 發布（Outbox）。detail 白名單：
  // 不含貨櫃號、訂艙號、船 ID（E10）/ Allow-listed detail: no container, booking or vessel identifiers.
  if (now?.entity === 'Shipment' && record.eventName === 'MODIFY' && old && old.status !== now.status) {
    const ship = {
      shipment_id: str(now.shipment_id),
      lot_id: str(now.lot_id),
      pol: str(now.pol),
      pod: str(now.pod),
      ...(now.synthetic === true ? { synthetic: true } : {}),
    };
    if (!ship.shipment_id || !ship.lot_id || !ship.pol || !ship.pod) return undefined;
    if (old.status === 'PLANNED' && now.status === 'DEPARTED' && str(now.atd)) {
      return { source: SHIPMENT_EVENT_SOURCE, detailType: 'VesselDeparted', time, detail: { ...base, ...ship, at: str(now.atd) } };
    }
    if (old.status === 'DEPARTED' && now.status === 'ARRIVED' && str(now.ata)) {
      return { source: SHIPMENT_EVENT_SOURCE, detailType: 'VesselArrived', time, detail: { ...base, ...ship, at: str(now.ata) } };
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
        source: EVENT_SOURCE,
        detailType: 'StockLow',
        time,
        detail: { ...base, product_id: pk.slice('PRODUCT#'.length), available_kg: after, low_threshold_kg: threshold },
      };
    }
  }
  return undefined;
}
