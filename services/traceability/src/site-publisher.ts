import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Logger } from '@aws-lambda-powertools/logger';
import type { CloudFormationCustomResourceEvent } from 'aws-lambda';
import { z } from 'zod';

/**
 * 部署時發布溯源頁的靜態檔（S2c）。檔案內容由 CDK 從 services/traceability/site 讀出，以 base64 放在
 * custom resource 屬性裡 → 檔案變更時才 Update。只寫這幾個固定的鍵，不會碰到 `v1/` 的投影。
 * 刪除時不動 bucket（bucket 保留）。
 * Publishes the static site at deploy time. CDK reads services/traceability/site and passes the files as base64
 * properties, so the resource updates only when a file changes. Writes only these fixed keys, never `v1/`.
 */

export const logger = new Logger();

export const SITE_FILES = {
  'index.html': 'text/html; charset=utf-8',
  'app.js': 'text/javascript; charset=utf-8',
  'app.css': 'text/css; charset=utf-8',
  '404.html': 'text/html; charset=utf-8',
  'robots.txt': 'text/plain; charset=utf-8',
} as const;
export type SiteKey = keyof typeof SITE_FILES;

/** 頁面本身 5 分鐘（與投影相同）；更新最多 5 分鐘生效 / The page itself caches for 5 minutes like the data. */
export const SITE_CACHE_CONTROL = 'public, max-age=300';

const PropsSchema = z.object({
  BucketName: z.string().min(3),
  Files: z
    .array(z.object({ Key: z.enum(Object.keys(SITE_FILES) as [SiteKey, ...SiteKey[]]), Body: z.string() }))
    .min(1),
});

let s3: S3Client | undefined;
export function setClientForTesting(c: S3Client | undefined): void {
  s3 = c;
}

export const handler = async (event: CloudFormationCustomResourceEvent) => {
  const physicalId = 'PhysicalResourceId' in event ? event.PhysicalResourceId : `trace-site-${event.LogicalResourceId}`;
  if (event.RequestType === 'Delete') return { PhysicalResourceId: physicalId };
  const props = PropsSchema.parse(event.ResourceProperties);
  s3 ??= new S3Client({});
  for (const f of props.Files) {
    await s3.send(
      new PutObjectCommand({
        Bucket: props.BucketName,
        Key: f.Key,
        Body: Buffer.from(f.Body, 'base64'),
        ContentType: SITE_FILES[f.Key],
        CacheControl: SITE_CACHE_CONTROL,
      }),
    );
  }
  logger.info('Trace site published', { files: props.Files.map((f) => f.Key) });
  return { PhysicalResourceId: physicalId, Data: { Files: props.Files.map((f) => f.Key).join(',') } };
};
