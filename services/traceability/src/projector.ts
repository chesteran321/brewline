import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { Logger } from '@aws-lambda-powertools/logger';
import { Tracer } from '@aws-lambda-powertools/tracer';
import type { EventBridgeEvent } from 'aws-lambda';
import { z } from 'zod';
import { RoastIdSchema } from '../../ordering/src/lib/trace-model';
import { TraceRepo } from '../../ordering/src/lib/trace-repo';
import { buildProjection, PROJECTION_CACHE_CONTROL } from './projection';

/**
 * 溯源投影函數（S2c）：RoastBatchRoasted／RoastBatchRecalled → 讀 ROAST／LOT／PRODUCT 的 META →
 * 寫 S3 `v1/<qr_token>.json`。公開讀取路徑只有 CloudFront＋S3，沒有 Lambda／API／DynamoDB（ADR-031 D2）。
 * Projects a roast batch to S3 on RoastBatchRoasted/Recalled; the public read path is CloudFront + S3 only.
 *
 * - 冪等：同一批次重複投影只是覆寫同一個物件（內容只差 generated_at）→ 不需要去重表。
 * - 一律用強一致讀取：事件可能比最終一致讀取更早到 / Strongly consistent reads (the event may beat replication).
 * - 日誌不記錄 QR token（token 等於公開頁的網址）/ Never log the QR token (it is the page URL).
 */

export const logger = new Logger();
const tracer = new Tracer();

const DetailSchema = z.object({ roast_id: RoastIdSchema, event_id: z.string().optional() });

let repo: TraceRepo | undefined;
let s3: S3Client | undefined;

export function setClientsForTesting(r: TraceRepo | undefined, s: S3Client | undefined): void {
  repo = r;
  s3 = s;
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

export type ProjectorOutcome = 'published' | 'skipped' | 'ignored';

export const handler = async (event: EventBridgeEvent<string, unknown>): Promise<{ outcome: ProjectorOutcome }> => {
  const parsed = DetailSchema.safeParse(event.detail);
  if (!parsed.success) {
    // 格式錯誤的事件重試也不會變好 → 記錄後略過 / Malformed events never get better on retry.
    logger.error('Malformed trace event ignored', { detailType: event['detail-type'] });
    return { outcome: 'ignored' };
  }
  const { roast_id: roastId } = parsed.data;
  repo ??= new TraceRepo(DynamoDBDocumentClient.from(tracer.captureAWSv3Client(new DynamoDBClient({}))), env('TABLE_NAME'));
  s3 ??= tracer.captureAWSv3Client(new S3Client({}));

  const roast = await repo.getRoast(roastId, true);
  if (!roast) {
    // 只有 Dev smoke test 的清理會刪除批次（可能比事件早）→ 略過，不重試、不告警。
    // Only the Dev smoke-test cleanup deletes batches (possibly before the event arrives) → skip, no retry.
    logger.warn('Roast batch no longer exists; projection skipped', { roastId, detailType: event['detail-type'] });
    return { outcome: 'skipped' };
  }
  const [lot, product] = await Promise.all([repo.getLot(roast.lot_id), repo.getProduct(roast.product_id)]);
  // 生豆批次與商品由種子寫入、不會刪除 → 找不到是錯誤：重試，最後進 DLQ（告警）
  // Lots and products are seeded and never deleted, so a miss is an error: retry, then the DLQ alarm.
  if (!lot || !product) throw new Error('Lot or product not found');

  const result = buildProjection(roast, lot, product, new Date());
  if (result.kind === 'skip') {
    logger.info('Projection skipped', { roastId, reason: result.reason, detailType: event['detail-type'] });
    return { outcome: 'skipped' };
  }
  await s3.send(
    new PutObjectCommand({
      Bucket: env('BUCKET_NAME'),
      Key: result.key,
      Body: JSON.stringify(result.body),
      ContentType: 'application/json; charset=utf-8',
      CacheControl: PROJECTION_CACHE_CONTROL,
    }),
  );
  logger.info('Projection published', { roastId, recalled: result.body.recall !== undefined, demo: result.body.demo });
  return { outcome: 'published' };
};
