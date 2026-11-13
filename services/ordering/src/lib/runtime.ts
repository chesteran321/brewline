import { Logger } from '@aws-lambda-powertools/logger';
import { Tracer } from '@aws-lambda-powertools/tracer';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { STSClient } from '@aws-sdk/client-sts';
import { CatalogRepo } from './catalog-repo';
import { AdminOrderRepo } from './admin-order-repo';
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

let orders: OrderRepo | undefined;

/**
 * 訂單 repo：每個租戶一個 DynamoDB client，憑證來自 AssumeRole（租戶範圍，ADR-024）。
 * 函數本身的角色沒有任何 DynamoDB 權限。
 * Order repo: one DynamoDB client per tenant, using tenant-scoped credentials. The function role itself has no
 * DynamoDB permissions at all.
 */
export function orderRepo(): OrderRepo {
  if (!orders) {
    const fnName = process.env.AWS_LAMBDA_FUNCTION_NAME ?? 'orders';
    const creds = new TenantCredentials(
      tracer.captureAWSv3Client(new STSClient({})),
      requiredEnv('TENANT_ROLE_ARN'),
      fnName.replace(/^brewline-[a-z]+-ordering-/, ''),
    );
    const clients = new Map<string, DynamoDBDocumentClient>();
    const tableName = requiredEnv('TABLE_NAME');
    orders = new OrderRepo((tenantId) => {
      let c = clients.get(tenantId);
      if (!c) {
        if (clients.size >= 200) clients.delete(clients.keys().next().value as string);
        c = DynamoDBDocumentClient.from(
          tracer.captureAWSv3Client(new DynamoDBClient({ credentials: () => creds.get(tenantId) })),
          { marshallOptions: { removeUndefinedValues: true } },
        );
        clients.set(tenantId, c);
      }
      return c;
    }, tableName);
  }
  return orders;
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
