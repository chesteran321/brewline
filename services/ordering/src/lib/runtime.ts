import { Logger } from '@aws-lambda-powertools/logger';
import { Tracer } from '@aws-lambda-powertools/tracer';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { CatalogRepo } from './catalog-repo';

/** 冷啟動時建立一次，之後重複使用（連線、憑證快取）/ Created once per cold start and reused. */
export const logger = new Logger();
export const tracer = new Tracer();

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

let repo: CatalogRepo | undefined;

export function catalogRepo(): CatalogRepo {
  repo ??= new CatalogRepo(
    DynamoDBDocumentClient.from(tracer.captureAWSv3Client(new DynamoDBClient({}))),
    requiredEnv('TABLE_NAME'),
    requiredEnv('GSI1_NAME'),
  );
  return repo;
}

/** 測試用：注入假的 repo / For tests: inject a fake repo. */
export function setCatalogRepoForTesting(r: CatalogRepo | undefined): void {
  repo = r;
}
