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
    /** 訂單通知信（A4d；SES 沙盒每秒 1 封）/ Order e-mail notifier (SES sandbox: 1 message/s). */
    readonly notifier: number;
    /** 定期補貨執行（A4e；09:00 同時觸發，節流由非同步重試處理）/ Replenishment runs (throttles retried async). */
    readonly replenish: number;
    /** 模擬器執行（ADR-030；1 = 同一時間只跑一輪）/ Simulator run (1 = one run at a time). */
    readonly simulator: number;
  };
}

/**
 * 模擬器（docs/07、ADR-030）。產生器參數（每日筆數、商品數、公斤數、異常比例）在 S1c 才使用，
 * 但先放進 SSM config，讓 S1b 部署時就能驗證格式。
 * Simulator settings. Generator parameters are used from S1c but already live in the SSM config.
 */
export interface SimulatorSettings {
  /** 部署時建立的模擬咖啡廳帳號數（D3）/ Simulated café accounts created at deploy time. */
  readonly poolSize: number;
  /** 一開始啟用的帳號數；之後依日期每月啟用 1–2 個（S1c）/ Active at start; more are activated monthly. */
  readonly initialActive: number;
  /** 每日訂單數範圍（D4）/ Orders per day. */
  readonly ordersPerDay: { readonly min: number; readonly max: number };
  /** 每筆商品數、每個商品公斤數（D4，避免佔滿庫存）/ Lines per order and kg per line (keeps reservations small). */
  readonly linesPerOrder: { readonly min: number; readonly max: number };
  readonly kgPerLine: { readonly min: number; readonly max: number };
  /** 重複下單的比例（SIM-F-008，D1）/ Share of requests resent with the same Idempotency-Key. */
  readonly duplicateOrderRate: number;
  /** 亂數種子（SIM-F-009）；也決定租戶 ID，改了會建立新的一批租戶 / Seed; also derives tenant ids. */
  readonly seed: string;
  /** 刪除 stack 時保留模擬帳號與密碼參數 / Keep accounts and the credentials parameter when the stack is deleted. */
  readonly retainOnDelete: boolean;
}

/**
 * 寄信（A4d，ADR-029 D1／D5）。網域在 Prod 帳號以 Route 53 註冊；`dev.` 子網域委派給 Dev 帳號。
 * Outbound mail. The domain is registered in Prod with Route 53; the `dev.` subdomain is delegated to Dev.
 */
export interface MailSettings {
  /** SES 網域身分＝寄件網域 / SES domain identity and From domain. */
  readonly domain: string;
  /**
   * 已存在的 hosted zone（Prod：註冊網域時 Route 53 自動建立）。省略 → 由 CDK 建立（Dev 子網域）。
   * Existing hosted zone (Prod: created by domain registration). Omitted → CDK creates it (Dev subdomain).
   */
  readonly hostedZoneId?: string;
  /** 寄件地址的 local part / Local part of the From address. */
  readonly fromLocalPart: string;
  readonly fromName: string;
  /**
   * 子網域委派（ADR-029 E2：NS 值手動從 Dev 部署輸出複製，不需要跨帳號角色）。
   * 名稱伺服器還沒填（空陣列）時不建立記錄。
   * Subdomain delegations; NS values are copied from the Dev deploy output (no cross-account role).
   * No record is created while the list is empty.
   */
  readonly delegations: ReadonlyArray<{ readonly subdomain: string; readonly nameServers: readonly string[] }>;
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
  readonly mail: MailSettings;
  readonly simulator: SimulatorSettings;
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
      reservedConcurrency: { preTokenGeneration: 5, api: 5, customResource: 1, streamPublisher: 2, notifier: 1, replenish: 2, simulator: 1 },
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
    simulator: {
      poolSize: 40,
      initialActive: 30,
      ordersPerDay: { min: 2, max: 6 }, // D4：Dev 少量 / small in Dev
      linesPerOrder: { min: 1, max: 3 },
      kgPerLine: { min: 1, max: 5 },
      duplicateOrderRate: 0.02,
      seed: 'brewline-dev-sim-2026',
      retainOnDelete: false,
    },
    mail: {
      domain: 'dev.brewline-demo.click',
      fromLocalPart: 'orders',
      fromName: 'BrewLine (Demo)',
      delegations: [],
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
      reservedConcurrency: { preTokenGeneration: 10, api: 10, customResource: 1, streamPublisher: 2, notifier: 1, replenish: 2, simulator: 1 },
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
    simulator: {
      poolSize: 40,
      initialActive: 30,
      ordersPerDay: { min: 5, max: 40 }, // docs/07 §2
      linesPerOrder: { min: 1, max: 3 },
      kgPerLine: { min: 1, max: 5 },
      duplicateOrderRate: 0.02,
      seed: 'brewline-prod-sim-2026',
      retainOnDelete: true,
    },
    mail: {
      domain: 'brewline-demo.click',
      // Route 53 註冊網域時建立的 hosted zone（2026-11-16）/ Created by the Route 53 registration.
      hostedZoneId: 'Z039360620HRFCTYO5R5J',
      fromLocalPart: 'orders',
      fromName: 'BrewLine (Demo)',
      // Dev 第一次部署後，把輸出 MailZoneNameServers 的 4 個值貼到這裡 / Paste Dev's MailZoneNameServers here.
      delegations: [
        {
          subdomain: 'dev',
          // brewline-dev-notify 輸出 MailZoneNameServers（2026-11-16，Dev zone Z00697733VLK1TK9WUYKL）
          nameServers: ['ns-406.awsdns-50.com', 'ns-1983.awsdns-55.co.uk', 'ns-1160.awsdns-17.org', 'ns-970.awsdns-57.net'],
        },
      ],
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
