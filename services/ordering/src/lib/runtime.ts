import { Logger } from '@aws-lambda-powertools/logger';
import { Tracer } from '@aws-lambda-powertools/tracer';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { KMSClient } from '@aws-sdk/client-kms';
import { SchedulerClient } from '@aws-sdk/client-scheduler';
import { STSClient } from '@aws-sdk/client-sts';
import { CatalogRepo } from './catalog-repo';
import { AdminOrderRepo } from './admin-order-repo';
import { ContactRepo } from './contact-repo';
import { ReplenishmentRepo } from './replenishment-repo';
import { ReplenishmentScheduler } from './replenishment-scheduler';
import { OrderRepo } from './order-repo';
import { TenantCredentials } from './tenant-credentials';

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

let tenantCreds: TenantCredentials | undefined;
const tenantDocs = new Map<string, DynamoDBDocumentClient>();

/** 租戶範圍的憑證（每個冷啟動一份快取）/ Tenant-scoped credentials, one cache per cold start. */
function credentials(): TenantCredentials {
  const fnName = process.env.AWS_LAMBDA_FUNCTION_NAME ?? 'orders';
  tenantCreds ??= new TenantCredentials(
    tracer.captureAWSv3Client(new STSClient({})),
    requiredEnv('TENANT_ROLE_ARN'),
    fnName.replace(/^brewline-[a-z]+-ordering-/, ''),
  );
  return tenantCreds;
}

/** 有上限的 Map 快取（最多 200 個租戶）/ Bounded per-tenant cache (200 tenants). */
function cached<T>(map: Map<string, T>, tenantId: string, make: () => T): T {
  let v = map.get(tenantId);
  if (!v) {
    if (map.size >= 200) map.delete(map.keys().next().value as string);
    v = make();
    map.set(tenantId, v);
  }
  return v;
}

/** 租戶專用的 DynamoDB client / DynamoDB client bound to the tenant's credentials. */
export function tenantDocClient(tenantId: string): DynamoDBDocumentClient {
  const creds = credentials();
  return cached(tenantDocs, tenantId, () =>
    DynamoDBDocumentClient.from(
      tracer.captureAWSv3Client(new DynamoDBClient({ credentials: () => creds.get(tenantId) })),
      { marshallOptions: { removeUndefinedValues: true } },
    ),
  );
}

let orders: OrderRepo | undefined;

/**
 * 訂單 repo：每個租戶一個 DynamoDB client，憑證來自 AssumeRole（租戶範圍，ADR-024）。
 * 函數本身的角色沒有任何 DynamoDB 權限。
 * Order repo: one DynamoDB client per tenant, using tenant-scoped credentials. The function role itself has no
 * DynamoDB permissions at all.
 */
export function orderRepo(): OrderRepo {
  orders ??= new OrderRepo(tenantDocClient, requiredEnv('TABLE_NAME'));
  return orders;
}

let contacts: ContactRepo | undefined;
const tenantKms = new Map<string, KMSClient>();

/**
 * 聯絡人 repo（A4c）：DynamoDB 與 KMS 都用租戶範圍憑證；函數角色本身沒有 KMS 權限。
 * Contact repo: DynamoDB and KMS both use tenant-scoped credentials; the function role has no KMS access.
 */
export function contactRepo(): ContactRepo {
  if (!contacts) {
    const creds = credentials();
    contacts = new ContactRepo(
      tenantDocClient,
      (tenantId) =>
        cached(tenantKms, tenantId, () =>
          tracer.captureAWSv3Client(new KMSClient({ credentials: () => creds.get(tenantId) })),
        ),
      requiredEnv('TABLE_NAME'),
      requiredEnv('KMS_KEY_ARN'),
    );
  }
  return contacts;
}

/** 測試用 / For tests. */
export function setContactRepoForTesting(r: ContactRepo | undefined): void {
  contacts = r;
}

/** 測試用 / For tests. */
export function setOrderRepoForTesting(r: OrderRepo | undefined): void {
  orders = r;
}

let admin: AdminOrderRepo | undefined;

/** staff 用：函數自己的角色（跨租戶、受 IAM 限制）/ Staff repo using the function's own role. */
export function adminOrderRepo(): AdminOrderRepo {
  admin ??= new AdminOrderRepo(
    DynamoDBDocumentClient.from(tracer.captureAWSv3Client(new DynamoDBClient({})), {
      marshallOptions: { removeUndefinedValues: true },
    }),
    requiredEnv('TABLE_NAME'),
    requiredEnv('GSI1_NAME'),
  );
  return admin;
}

export function setAdminOrderRepoForTesting(r: AdminOrderRepo | undefined): void {
  admin = r;
}

let replenishments: ReplenishmentRepo | undefined;

/** 定期補貨 repo（A4e，租戶憑證）/ Replenishment repo (tenant credentials). */
export function replenishmentRepo(): ReplenishmentRepo {
  replenishments ??= new ReplenishmentRepo(tenantDocClient, requiredEnv('TABLE_NAME'));
  return replenishments;
}

let scheduler: ReplenishmentScheduler | undefined;

/** Scheduler 用函數自己的角色（只能管 brewline-<env>-replenish 群組）/ Uses the function's own role. */
export function replenishmentScheduler(): ReplenishmentScheduler {
  scheduler ??= new ReplenishmentScheduler(tracer.captureAWSv3Client(new SchedulerClient({})), {
    groupName: requiredEnv('SCHEDULE_GROUP'),
    functionArn: requiredEnv('REPLENISH_FUNCTION_ARN'),
    roleArn: requiredEnv('SCHEDULER_ROLE_ARN'),
    dlqArn: requiredEnv('REPLENISH_DLQ_ARN'),
  });
  return scheduler;
}

/** 測試用 / For tests. */
export function setReplenishmentDepsForTesting(r?: ReplenishmentRepo, s?: ReplenishmentScheduler): void {
  replenishments = r;
  scheduler = s;
}
