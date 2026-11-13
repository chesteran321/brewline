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
  /** 讀自己租戶的訂單（A2）/ Read own tenant's orders. */
  ordersRead: 'brewline/orders.read',
  /** 為自己租戶下單（A2）/ Place orders for own tenant. */
  ordersWrite: 'brewline/orders.write',
} as const;

export type Scope = (typeof SCOPES)[keyof typeof SCOPES];

export const GROUPS = ['cafe', 'staff', 'simulator'] as const;
export type Group = (typeof GROUPS)[number];

/** 每個群組授予的 scope / Scopes granted per group. */
export const GROUP_SCOPES: Record<Group, readonly Scope[]> = {
  cafe: [SCOPES.catalogRead, SCOPES.ordersRead, SCOPES.ordersWrite],
  // 模擬器以咖啡廳身分呼叫公開 API（ADR-011）/ The simulator acts as a café (ADR-011).
  simulator: [SCOPES.catalogRead, SCOPES.ordersRead, SCOPES.ordersWrite],
  // staff 不屬於任何租戶，不能以租戶身分下單；跨租戶的訂單端點在 A3（/admin/orders）。
  // Staff belong to no tenant and cannot order as one; cross-tenant order endpoints come in A3.
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
