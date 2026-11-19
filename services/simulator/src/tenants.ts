import { createHash } from 'node:crypto';
import { TENANT_ID_PATTERN } from '../../identity/src/scopes';

/**
 * 模擬咖啡廳帳號（ADR-030 D3）。由種子決定：同一個種子永遠得到同一批帳號與租戶 ID（SIM-F-009），
 * 所以帳號被刪除後重新部署，會建回同一個租戶，DynamoDB 裡的歷史訂單仍然對得上。
 * Simulated café accounts, derived from the seed: the same seed always yields the same usernames and tenant ids,
 * so re-provisioning after a deletion recreates the same tenants and existing orders still match.
 */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export interface SimUser {
  /** 1 起算 / 1-based. */
  readonly index: number;
  /** 保留網域 example.com（SIM-F-001、SIM-N-004）/ Reserved domain. */
  readonly username: string;
  readonly tenantId: string;
}

export function simUsername(index: number): string {
  return `sim-${String(index).padStart(3, '0')}@example.com`;
}

/** t_ ＋ 26 個 Crockford 字元，由 sha256(seed:index) 決定 / Deterministic t_<26 Crockford chars>. */
export function simTenantId(seed: string, index: number): string {
  const digest = createHash('sha256').update(`${seed}:tenant:${index}`).digest();
  let out = '';
  for (let i = 0; i < 26; i++) out += CROCKFORD[digest[i]! % 32];
  const id = `t_${out}`;
  if (!TENANT_ID_PATTERN.test(id)) throw new Error(`generated tenant id is invalid: ${id}`);
  return id;
}

export function simUsers(seed: string, poolSize: number): SimUser[] {
  if (!Number.isInteger(poolSize) || poolSize < 1 || poolSize > 60) throw new Error(`poolSize must be 1-60, got ${poolSize}`);
  return Array.from({ length: poolSize }, (_, i) => ({
    index: i + 1,
    username: simUsername(i + 1),
    tenantId: simTenantId(seed, i + 1),
  }));
}

/**
 * 模擬烘焙廠帳號（S2d，ADR-031 D6／D8）：群組 `simulator-roastery`，**沒有租戶**、沒有 admin；token 帶 `synthetic`，
 * 伺服器只讓它碰模擬訂單與模擬批次。
 * Simulated roastery account: group `simulator-roastery`, no tenant, no admin; synthetic data only.
 */
export const ROASTER_USERNAME = 'sim-roaster@example.com';
export const ROASTER_GROUP = 'simulator-roastery';
