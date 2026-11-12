import { Logger } from '@aws-lambda-powertools/logger';
import type { PreTokenGenerationV2TriggerEvent } from 'aws-lambda';
import { GROUP_SCOPES, GROUPS, Group, Scope, TENANT_GROUPS, TENANT_ID_PATTERN } from './scopes';

/**
 * Cognito pre token generation 觸發器（事件版本 V2_0，需 Essentials 方案；ADR-022）。
 * Cognito pre token generation trigger (event version V2_0, requires the Essentials plan).
 *
 * 做兩件事 / Two jobs:
 *   1. 依群組把 scope 加進 access token → API Gateway 的 JWT authorizer 依 scope 授權，
 *      越權請求在 Gateway 就回 403，不會叫起 Lambda。
 *      Map groups to access-token scopes so the HTTP API authorizer rejects with 403 before any Lambda runs.
 *   2. 把 custom:tenant_id 以 `tenant_id` claim 放進 access token（A2 的租戶隔離會用到）。
 *      Copy custom:tenant_id into the access token as `tenant_id` (used by A2 tenant isolation).
 *
 * 一律 fail closed：群組衝突、缺 tenant_id 或格式錯誤時不加任何 scope（登入仍成功，但呼叫 API 會 403）。
 * Always fail closed: on conflicts or a missing/invalid tenant_id no scopes are added.
 */

const logger = new Logger({ serviceName: 'identity-pre-token' });

export interface TokenDecision {
  readonly scopes: Scope[];
  readonly tenantId?: string;
  /** 不授予 scope 的原因（記錄用）/ Why no scopes were granted (for logs). */
  readonly denyReason?: 'no-known-group' | 'conflicting-groups' | 'missing-tenant-id' | 'invalid-tenant-id';
}

const isGroup = (g: string): g is Group => (GROUPS as readonly string[]).includes(g);

/** 純函式，方便測試 / Pure function for easy testing. */
export function decide(groupNames: readonly string[], rawTenantId: string | undefined): TokenDecision {
  const groups = [...new Set(groupNames.filter(isGroup))];
  if (groups.length === 0) {
    return { scopes: [], denyReason: 'no-known-group' };
  }

  const isStaff = groups.includes('staff');
  const isTenantMember = groups.some((g) => TENANT_GROUPS.includes(g));
  // 內部人員與租戶身分不可同時存在：避免一個帳號同時拿到 admin 與租戶範圍。
  // Staff and tenant membership are mutually exclusive.
  if (isStaff && isTenantMember) {
    return { scopes: [], denyReason: 'conflicting-groups' };
  }

  if (isTenantMember) {
    if (rawTenantId === undefined || rawTenantId === '') {
      return { scopes: [], denyReason: 'missing-tenant-id' };
    }
    if (!TENANT_ID_PATTERN.test(rawTenantId)) {
      return { scopes: [], denyReason: 'invalid-tenant-id' };
    }
  }

  const scopes = [...new Set(groups.flatMap((g) => GROUP_SCOPES[g]))].sort();
  // staff 不屬於任何租戶：就算屬性被誤設，也不放進 token。
  // Staff never carry a tenant claim, even if the attribute was set by mistake.
  return isTenantMember ? { scopes, tenantId: rawTenantId } : { scopes };
}

export const handler = async (event: PreTokenGenerationV2TriggerEvent): Promise<PreTokenGenerationV2TriggerEvent> => {
  const groups = event.request.groupConfiguration.groupsToOverride ?? [];
  const decision = decide(groups, event.request.userAttributes['custom:tenant_id']);

  // 只記錄判斷結果，不記錄 Email 等個資 / Log the decision only, never PII such as email.
  const logFields = {
    triggerSource: event.triggerSource,
    groups,
    scopes: decision.scopes,
    hasTenant: decision.tenantId !== undefined,
  };
  if (decision.denyReason) {
    logger.warn('No scopes granted', { ...logFields, denyReason: decision.denyReason });
  } else {
    logger.info('Scopes granted', logFields);
  }

  event.response = {
    claimsAndScopeOverrideDetails: {
      accessTokenGeneration: {
        scopesToAdd: decision.scopes,
        ...(decision.tenantId ? { claimsToAddOrOverride: { tenant_id: decision.tenantId } } : {}),
      },
    },
  };
  return event;
};
