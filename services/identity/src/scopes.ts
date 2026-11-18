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
  /** 讀自己租戶的聯絡人（A4c）/ Read own tenant's contact. */
  profileRead: 'brewline/profile.read',
  /** 更新自己租戶的聯絡人（A4c）/ Update own tenant's contact. */
  profileWrite: 'brewline/profile.write',
  /** 烘焙廠作業（S2，ADR-031 D6）：烘焙批次、推進訂單、補貨 / Roastery operations: roast batches, order progress, restock. */
  roastery: 'brewline/roastery',
} as const;

export type Scope = (typeof SCOPES)[keyof typeof SCOPES];

export const GROUPS = ['cafe', 'staff', 'simulator', 'simulator-roastery'] as const;
export type Group = (typeof GROUPS)[number];

/** 每個群組授予的 scope / Scopes granted per group. */
export const GROUP_SCOPES: Record<Group, readonly Scope[]> = {
  // 聯絡人（個資）只給 cafe：模擬器不需要、也不該讀寫真人聯絡資料（ADR-029 D4）。
  // Contacts (PII) are cafe-only: the simulator has no reason to touch real contact data.
  cafe: [SCOPES.catalogRead, SCOPES.ordersRead, SCOPES.ordersWrite, SCOPES.profileRead, SCOPES.profileWrite],
  // 模擬器以咖啡廳身分呼叫公開 API（ADR-011）/ The simulator acts as a café (ADR-011).
  simulator: [SCOPES.catalogRead, SCOPES.ordersRead, SCOPES.ordersWrite],
  // staff 不屬於任何租戶，不能以租戶身分下單；跨租戶的訂單端點在 A3（/admin/orders）。
  // Staff belong to no tenant and cannot order as one; cross-tenant order endpoints come in A3.
  // S2：staff 也能做烘焙廠作業；召回（admin）只有 staff / Staff also run roastery operations; recall (admin) is staff-only.
  staff: [SCOPES.catalogRead, SCOPES.admin, SCOPES.roastery],
  // 模擬烘焙廠操作員（ADR-031 D6）：沒有租戶、沒有 admin；伺服器只讓它碰 synthetic 資料。
  // Simulated roastery operator: no tenant, no admin; the server lets it touch synthetic data only.
  'simulator-roastery': [SCOPES.catalogRead, SCOPES.roastery],
};

/** 需要 tenant_id 的群組 / Groups whose members must belong to a tenant. */
export const TENANT_GROUPS: readonly Group[] = ['cafe', 'simulator'];

/** 不屬於租戶的操作員群組；一個帳號最多一個，且不能同時屬於租戶群組 / Operator groups: at most one, never with a tenant group. */
export const OPERATOR_GROUPS: readonly Group[] = ['staff', 'simulator-roastery'];

/** 模擬器群組：token 帶 synthetic claim，可經由 simulator client 登入 / Simulator groups: synthetic claim, simulator client allowed. */
export const SIMULATOR_GROUPS: readonly Group[] = ['simulator', 'simulator-roastery'];

/**
 * tenant_id 格式：`t_` + 26 字元 ULID（Crockford Base32，大寫）。
 * 固定長度、只含 STS session tag 允許的字元，且不含個資。
 * Format: "t_" + 26-char ULID. Fixed length, STS-session-tag safe, no PII.
 */
export const TENANT_ID_PATTERN = /^t_[0-9A-HJKMNP-TV-Z]{26}$/;
