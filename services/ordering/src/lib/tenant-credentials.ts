import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import type { AwsCredentialIdentity } from '@aws-sdk/types';
import { TENANT_ID_PATTERN } from '../../../identity/src/scopes';

/**
 * 以租戶為範圍的臨時憑證（ADR-024）。
 * Tenant-scoped temporary credentials.
 *
 * 函數角色（brewline-<env>-orders-*）帶 session tag `tenant_id` 扮演 brewline-<env>-tenant-access；
 * IAM 以 `${aws:PrincipalTag/tenant_id}` 限定只能碰 TENANT#<自己>。
 * The function role assumes the tenant role with a `tenant_id` session tag; IAM then limits access to TENANT#<own>.
 *
 * 快取：每個租戶一份，到期前 5 分鐘更新；最多快取 MAX_ENTRIES 個租戶（避免記憶體無限成長）。
 * Cache per tenant, refreshed 5 minutes before expiry, bounded to MAX_ENTRIES tenants.
 */

const REFRESH_MARGIN_MS = 5 * 60 * 1000;
/** 角色鏈結（role chaining）最長 1 小時 / Role chaining caps sessions at 1 hour. */
const SESSION_SECONDS = 3600;
const MAX_ENTRIES = 200;

export class TenantIsolationError extends Error {
  override readonly name = 'TenantIsolationError';
}

export class TenantCredentials {
  private readonly cache = new Map<string, Promise<AwsCredentialIdentity>>();

  constructor(
    private readonly sts: Pick<STSClient, 'send'>,
    private readonly roleArn: string,
    /** 出現在 CloudTrail 的 session 名稱前綴 / Session-name prefix shown in CloudTrail. */
    private readonly sessionPrefix: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** 回傳該租戶的憑證（同一租戶的同時請求共用同一次 AssumeRole）/ Concurrent calls for a tenant share one AssumeRole. */
  async get(tenantId: string): Promise<AwsCredentialIdentity> {
    // 縱深防禦：信任政策也會檢查 tag 長度 / Defense in depth: the trust policy checks the tag too.
    if (!TENANT_ID_PATTERN.test(tenantId)) throw new TenantIsolationError('Invalid tenant id');

    const cached = this.cache.get(tenantId);
    if (cached) {
      try {
        const creds = await cached;
        if (creds.expiration && creds.expiration.getTime() - REFRESH_MARGIN_MS > this.now()) return creds;
      } catch {
        /* 上次失敗 → 重新取得 / previous attempt failed → fetch again */
      }
      this.cache.delete(tenantId);
    }

    if (this.cache.size >= MAX_ENTRIES) {
      // Map 依插入順序 → 刪掉最舊的 / Maps keep insertion order → evict the oldest.
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    const pending = this.assume(tenantId);
    this.cache.set(tenantId, pending);
    pending.catch(() => this.cache.delete(tenantId));
    return pending;
  }

  private async assume(tenantId: string): Promise<AwsCredentialIdentity> {
    const out = await this.sts.send(
      new AssumeRoleCommand({
        RoleArn: this.roleArn,
        // 64 字元以內；含 tenant_id → CloudTrail 的 AssumeRole 事件就是稽核證據
        // ≤ 64 chars; includes the tenant so CloudTrail AssumeRole events are audit evidence.
        RoleSessionName: `${this.sessionPrefix}.${tenantId}`.slice(0, 64),
        DurationSeconds: SESSION_SECONDS,
        Tags: [{ Key: 'tenant_id', Value: tenantId }],
      }),
    );
    const c = out.Credentials;
    if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken || !c.Expiration) {
      throw new Error('AssumeRole returned no credentials');
    }
    return {
      accessKeyId: c.AccessKeyId,
      secretAccessKey: c.SecretAccessKey,
      sessionToken: c.SessionToken,
      expiration: c.Expiration,
    };
  }
}
