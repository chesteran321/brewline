import { EventBridgeClient, PutEventsCommand, PutEventsRequestEntry } from '@aws-sdk/client-eventbridge';
import { Logger } from '@aws-lambda-powertools/logger';
import { Tracer } from '@aws-lambda-powertools/tracer';
import type { DynamoDBBatchResponse, DynamoDBStreamEvent } from 'aws-lambda';
import { EVENT_SOURCE, toDomainEvent } from './order-events';

/**
 * DynamoDB Streams → EventBridge（A3b，ADR-026）。台北沒有 EventBridge Pipes，所以用 Lambda。
 * Streams → EventBridge publisher (no EventBridge Pipes in ap-east-2).
 *
 * - 部分失敗回報（ReportBatchItemFailures）：回傳第一筆失敗的 SequenceNumber，Lambda 從那筆重試，
 *   之前的不會重送 → 同一個 shard 內事件順序不變。
 * - 解析不了的紀錄只記錄、不重試（重試也不會變好），避免卡住整個 shard。
 * Partial batch responses keep per-shard ordering; unparseable records are logged and skipped, never retried.
 */

const MAX_ENTRIES_PER_PUT = 10; // PutEvents 上限 / PutEvents limit

export const logger = new Logger();
const tracer = new Tracer();
let client: EventBridgeClient | undefined;
const eb = () => (client ??= tracer.captureAWSv3Client(new EventBridgeClient({})));

export function setClientForTesting(c: EventBridgeClient | undefined): void {
  client = c;
}

export const handler = async (event: DynamoDBStreamEvent): Promise<DynamoDBBatchResponse> => {
  const busName = process.env.EVENT_BUS_NAME;
  if (!busName) throw new Error('EVENT_BUS_NAME is required');

  const pending: Array<{ seq: string; entry: PutEventsRequestEntry }> = [];
  for (const record of event.Records) {
    const seq = record.dynamodb?.SequenceNumber ?? '';
    let mapped;
    try {
      mapped = toDomainEvent(record);
    } catch (err) {
      logger.error('Unparseable stream record skipped', { eventID: record.eventID, error: (err as Error).name });
      continue;
    }
    if (!mapped) continue;
    pending.push({
      seq,
      entry: {
        EventBusName: busName,
        Source: EVENT_SOURCE,
        DetailType: mapped.detailType,
        Time: mapped.time,
        Detail: JSON.stringify(mapped.detail),
      },
    });
  }

  for (let i = 0; i < pending.length; i += MAX_ENTRIES_PER_PUT) {
    const chunk = pending.slice(i, i + MAX_ENTRIES_PER_PUT);
    let firstFailed: string | undefined;
    try {
      const out = await eb().send(new PutEventsCommand({ Entries: chunk.map((c) => c.entry) }));
      const idx = (out.Entries ?? []).findIndex((e) => e.ErrorCode);
      if ((out.FailedEntryCount ?? 0) > 0) firstFailed = chunk[idx >= 0 ? idx : 0]!.seq;
    } catch (err) {
      logger.warn('PutEvents failed', { error: (err as Error).name });
      firstFailed = chunk[0]!.seq;
    }
    if (firstFailed !== undefined) {
      // 從第一筆失敗的紀錄重試；之後的紀錄會一起重送（下游以 event_id 去重）
      // Retry from the first failed record; later ones are resent too (consumers dedupe by event_id).
      logger.warn('Partial failure; retrying from sequence', { sequence: firstFailed });
      return { batchItemFailures: [{ itemIdentifier: firstFailed }] };
    }
  }
  logger.info('Published', { records: event.Records.length, events: pending.length });
  return { batchItemFailures: [] };
};
