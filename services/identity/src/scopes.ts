/**
 * OAuth scope 與 Cognito 群組的對照（ADR-022）。這個檔案不 import 任何套件，
 * 讓 CDK app（API 路由的 authorizationScopes）與 Lambda 共用同一份定義。
 * Scope ↔ Cognito group mapping. Dependency-free so the CDK app and the Lambda share one source of truth.
 */

export const SCOPES = {
  /** 讀商品目錄 / Read the product catalog. */
  catalogRead: 'brewline/catalog.read',
  /** 內部人員端點（/admin/*）/ Staff-only endpoints. */
  admin: 'brewline/admin',
} as const;

export type Scope = (typeof SCOPES)[keyof typeof SCOPES];

export const GROUPS = ['cafe', 'staff', 'simulator'] as const;
export type Group = (typeof GROUPS)[number];

/** 每個群組授予的 scope / Scopes granted per group. */
export const GROUP_SCOPES: Record<Group, readonly Scope[]> = {
  cafe: [SCOPES.catalogRead],
  // 模擬器以咖啡廳身分呼叫公開 API（ADR-011）/ The simulator acts as a café (ADR-011).
  simulator: [SCOPES.catalogRead],
  staff: [SCOPES.catalogRead, SCOPES.admin],
};

/** 需要 tenant_id 的群組 / Groups whose members must belong to a tenant. */
export const TENANT_GROUPS: readonly Group[] = ['cafe', 'simulator'];

/**
 * tenant_id 格式：`t_` + 26 字元 ULID（Crockford Base32，大寫）。
 * 固定長度、只含 STS session tag 允許的字元，且不含個資。
 * Format: "t_" + 26-char ULID. Fixed length, STS-session-tag safe, no PII.
 */
export const TENANT_ID_PATTERN = /^t_[0-9A-HJKMNP-TV-Z]{26}$/;
