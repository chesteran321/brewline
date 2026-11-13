/**
 * BrewLine 環境設定 / Environment configuration.
 *
 * 帳號與區域是固定事實（見 docs/landing-zone-status.md §1、§2）。
 * Account IDs and region are fixed facts; see docs/landing-zone-status.md.
 */

export type EnvName = 'dev' | 'prod';

/**
 * 共用資料層的各環境設定（docs/09 §3.1、ADR-018、ADR-019）。
 * Per-environment settings for the shared data layer.
 */
export interface DataSettings {
  /** DynamoDB 刪除保護 / Deletion protection. */
  readonly deletionProtection: boolean;
  /** PITR 保留天數（1–35）；費用依表大小計，與天數無關 / PITR window; cost is by table size, not days. */
  readonly pitrRecoveryDays: number;
  /** On-demand 最大吞吐量上限（COST-005）/ On-demand max throughput caps. */
  readonly maxReadRequestUnits: number;
  readonly maxWriteRequestUnits: number;
  /** 刪除 stack 時保留資料表與金鑰 / Keep table and key when the stack is deleted. */
  readonly retainOnDelete: boolean;
  /** KMS 金鑰排程刪除等待天數（7–30）/ KMS key deletion waiting period. */
  readonly keyPendingWindowDays: number;
}

/**
 * 身分層（Cognito）的各環境設定（docs/09 §1.3、ADR-022）。
 * Per-environment settings for the identity layer.
 */
export interface AuthSettings {
  /** User pool 刪除保護 / User pool deletion protection. */
  readonly deletionProtection: boolean;
  /** 刪除 stack 時保留 user pool（使用者資料無法重建）/ Keep the pool when the stack is deleted. */
  readonly retainOnDelete: boolean;
  /**
   * 建立 Dev 專用的 smoke-test app client（ADMIN_USER_PASSWORD_AUTH，只能以 IAM 身分呼叫）。
   * Create the Dev-only smoke-test client (ADMIN_USER_PASSWORD_AUTH, callable only with IAM credentials).
   */
  readonly smokeTestClient: boolean;
}

/**
 * Lambda 的各環境設定（docs/09 §2.2、COST-004、COST-007）。
 * Per-environment Lambda settings.
 */
export interface LambdaSettings {
  /** CloudWatch Logs 保留天數；必須是 CloudWatch 允許的值 / Log retention (a CloudWatch-supported value). */
  readonly logRetentionDays: 7 | 14 | 30 | 60 | 90;
  /**
   * 每個函數的保留併發（reserved concurrency）上限。帳號必須保留至少 100 未保留併發，
   * 部署前先確認 `aws lambda get-account-settings` 的 ConcurrentExecutions（新帳號可能只有 10）。
   * Reserved concurrency per function. The account must keep ≥ 100 unreserved, so check the quota first.
   */
  readonly reservedConcurrency: {
    readonly preTokenGeneration: number;
    /** 每個 API 函數 / Each API function. */
    readonly api: number;
    /** 部署時才執行的 custom resource（種子、smoke test）/ Deploy-time custom resources. */
    readonly customResource: number;
    /** DynamoDB Streams 事件發布（每個 shard 一個並行）/ Stream publisher (one concurrent batch per shard). */
    readonly streamPublisher: number;
  };
}

/**
 * HTTP API 的各環境設定（docs/09 §2.1、COST-003、ADR-021）。
 * Per-environment HTTP API settings.
 */
export interface ApiSettings {
  /** Stage 預設限流（每秒請求數）/ Stage default throttle (requests per second). */
  readonly throttleRateLimit: number;
  readonly throttleBurstLimit: number;
  /** 部署時執行 smoke test（需要 auth stack 的 smoke-test client）/ Run the smoke test on deploy. */
  readonly smokeTest: boolean;
  /**
   * `POST /orders` 的路由限流（A2 決策 D3：HTTP API 無法每租戶限流，改以路由限流控制下單量）。
   * Route throttle for POST /orders (per-tenant throttling is not possible on HTTP API).
   */
  readonly orderThrottleRateLimit: number;
  readonly orderThrottleBurstLimit: number;
  /** 寫入 Dev 測試商品 p-9xxx（不在目錄）/ Seed hidden p-9xxx test products. */
  readonly testProducts: boolean;
  /**
   * 部署手動觸發的訂單測試函數（冪等風暴、搶庫存、IAM 探測；A2b-2）。需要 testProducts。
   * Deploy the manually-invoked order-test function (needs testProducts).
   */
  readonly orderTests: boolean;
  /**
   * 未確認訂單的逾時取消（秒，A3 決策 D5：Dev 10 分鐘方便實測、Prod 48 小時）。
   * Seconds before an unconfirmed order is cancelled (Dev 10 min to observe it, Prod 48 h).
   */
  readonly orderTimeoutSeconds: number;
}

export interface BrewlineEnv {
  readonly name: EnvName;
  readonly account: string;
  readonly region: string;
  readonly data: DataSettings;
  readonly auth: AuthSettings;
  readonly lambda: LambdaSettings;
  readonly api: ApiSettings;
}

/** Lambda 標準 runtime（ADR-023）/ Standard Lambda runtime. */
export const LAMBDA_RUNTIME = 'nodejs24.x';

/** 主要區域一律 ap-east-2（台北）/ Primary region is always ap-east-2 (Taipei). */
export const PRIMARY_REGION = 'ap-east-2';

export const ENVIRONMENTS: Record<EnvName, BrewlineEnv> = {
  dev: {
    name: 'dev',
    account: '610935435571',
    region: PRIMARY_REGION,
    data: {
      deletionProtection: false,
      pitrRecoveryDays: 35, // ADR-019：Dev 也開 PITR / PITR on in Dev too
      maxReadRequestUnits: 50,
      maxWriteRequestUnits: 25,
      retainOnDelete: false,
      keyPendingWindowDays: 7,
    },
    auth: {
      deletionProtection: false,
      retainOnDelete: false,
      smokeTestClient: true, // A1c 的 Dev smoke test 用 / for the A1c Dev smoke test
    },
    lambda: {
      logRetentionDays: 7, // COST-007
      reservedConcurrency: { preTokenGeneration: 5, api: 5, customResource: 1, streamPublisher: 2 },
    },
    api: {
      throttleRateLimit: 10,
      throttleBurstLimit: 20,
      smokeTest: true,
      orderThrottleRateLimit: 2,
      orderThrottleBurstLimit: 5,
      testProducts: true,
      orderTests: true,
      orderTimeoutSeconds: 10 * 60,
    },
  },
  prod: {
    name: 'prod',
    account: '062868712468',
    region: PRIMARY_REGION,
    data: {
      deletionProtection: true,
      pitrRecoveryDays: 35,
      maxReadRequestUnits: 200,
      maxWriteRequestUnits: 100,
      retainOnDelete: true,
      keyPendingWindowDays: 30,
    },
    auth: {
      deletionProtection: true,
      retainOnDelete: true,
      smokeTestClient: false, // Prod 不建立可用密碼直接取得 token 的 client / no password-grant client in Prod
    },
    lambda: {
      logRetentionDays: 30, // COST-007
      reservedConcurrency: { preTokenGeneration: 10, api: 10, customResource: 1, streamPublisher: 2 },
    },
    api: {
      throttleRateLimit: 50,
      throttleBurstLimit: 100,
      smokeTest: false,
      orderThrottleRateLimit: 10,
      orderThrottleBurstLimit: 20,
      testProducts: false,
      orderTests: false,
      orderTimeoutSeconds: 48 * 60 * 60,
    },
  },
};

/** 所有資源必帶的標籤 / Tags every taggable resource must carry. */
export const REQUIRED_TAG_KEYS = ['project', 'env', 'module', 'owner'] as const;

/** 資料資源另外必帶的標籤（docs/02 §6）/ Extra tag required on data resources. */
export const DATA_CLASS_TAG = 'data-class';
export const DATA_CLASS_VALUES = ['public', 'internal', 'pii'] as const;
export type DataClass = (typeof DATA_CLASS_VALUES)[number];

/**
 * 依 context 取得環境；未指定或拼錯時直接失敗，避免誤部署到錯的帳號。
 * Resolve the environment from context; fail fast when missing or invalid.
 */
export function resolveEnv(value: unknown): BrewlineEnv {
  if (value === 'dev' || value === 'prod') {
    return ENVIRONMENTS[value];
  }
  throw new Error(
    `Missing or invalid context "env" (got: ${JSON.stringify(value)}). ` +
      'Use -c env=dev or -c env=prod.',
  );
}
