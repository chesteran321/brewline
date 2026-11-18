import { Logger } from '@aws-lambda-powertools/logger';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import type { PreTokenGenerationV2TriggerEvent } from 'aws-lambda';
import { GROUP_SCOPES, GROUPS, Group, OPERATOR_GROUPS, SIMULATOR_GROUPS, Scope, TENANT_GROUPS, TENANT_ID_PATTERN } from './scopes';

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
 *   3. 模擬器（ADR-030 D2／D6）：`simulator` app client 只發 scope 給 `simulator` 群組；`simulator` 群組的 token
 *      加上 `synthetic: "true"` claim，訂單函數據此標記模擬資料（由簽章保護，client 無法偽造）。
 *      The `simulator` app client issues scopes only to the simulator group; simulator tokens carry
 *      `synthetic: "true"`, which the order function uses to tag synthetic data (signed, so unforgeable).
 *
 * 一律 fail closed：群組衝突、缺 tenant_id 或格式錯誤時不加任何 scope（登入仍成功，但呼叫 API 會 403）。
 * Always fail closed: on conflicts or a missing/invalid tenant_id no scopes are added.
 */

const logger = new Logger({ serviceName: 'identity-pre-token' });

export interface TokenDecision {
  readonly scopes: Scope[];
  readonly tenantId?: string;
  /** 模擬器產生的資料（simulator、simulator-roastery 群組）/ Synthetic data (simulator groups only). */
  readonly synthetic?: true;
  /** 不授予 scope 的原因（記錄用）/ Why no scopes were granted (for logs). */
  readonly denyReason?:
    | 'no-known-group'
    | 'conflicting-groups'
    | 'missing-tenant-id'
    | 'invalid-tenant-id'
    | 'client-not-allowed';
}

export interface DecideOptions {
  /** 這次登入是否來自 `simulator` app client / Whether this sign-in came through the simulator app client. */
  readonly viaSimulatorClient?: boolean;
}

const isGroup = (g: string): g is Group => (GROUPS as readonly string[]).includes(g);

/** 純函式，方便測試 / Pure function for easy testing. */
export function decide(groupNames: readonly string[], rawTenantId: string | undefined, opts: DecideOptions = {}): TokenDecision {
  const groups = [...new Set(groupNames.filter(isGroup))];
  if (groups.length === 0) {
    return { scopes: [], denyReason: 'no-known-group' };
  }
  // simulator client 只服務 simulator 群組：外洩的 cafe／staff 密碼無法透過這個 client（IAM 呼叫）取得 scope。
  // The simulator client serves only the simulator group, so leaked cafe/staff passwords get no scopes through it.
  if (opts.viaSimulatorClient && groups.some((g) => !SIMULATOR_GROUPS.includes(g))) {
    return { scopes: [], denyReason: 'client-not-allowed' };
  }

  const operators = groups.filter((g) => OPERATOR_GROUPS.includes(g));
  const tenantGroups = groups.filter((g) => TENANT_GROUPS.includes(g));
  const isTenantMember = tenantGroups.length > 0;
  // 操作員（staff、模擬烘焙廠）與租戶身分不可同時存在，操作員也最多一種；一個帳號不會同時拿到 admin 與租戶範圍，
  // 模擬帳號也不會同時是 staff（RSK-018 的不變條件）。
  // Operators and tenant membership are mutually exclusive, and at most one operator group: no account gets both
  // admin and tenant scope, and no simulator account is also staff (RSK-018 invariant).
  if ((operators.length > 0 && isTenantMember) || operators.length > 1 || tenantGroups.length > 1) {
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
  const synthetic = groups.some((g) => SIMULATOR_GROUPS.includes(g)) ? ({ synthetic: true } as const) : {};
  // 操作員不屬於任何租戶：就算屬性被誤設，也不放進 token。
  // Operators never carry a tenant claim, even if the attribute was set by mistake.
  if (!isTenantMember) return { scopes, ...synthetic };
  return { scopes, tenantId: rawTenantId, ...synthetic };
}

const ssm = new SSMClient({});
let simulatorClientIdCache: Promise<string> | undefined;

/**
 * simulator client ID 從 SSM 讀取並快取（user pool → 觸發器 → client → user pool 會形成循環依賴，不能用環境變數）。
 * 讀取失敗就丟錯 → 登入失敗（fail closed）；失敗不快取，下次重試。
 * Read from SSM and cached (an env var would create a pool → trigger → client → pool cycle).
 * Errors fail the sign-in (fail closed) and are not cached.
 */
export function simulatorClientId(): Promise<string> {
  const name = process.env.SIMULATOR_CLIENT_ID_PARAM;
  if (!name) return Promise.reject(new Error('SIMULATOR_CLIENT_ID_PARAM is not set'));
  simulatorClientIdCache ??= ssm
    .send(new GetParameterCommand({ Name: name }))
    .then((out) => {
      const v = out.Parameter?.Value;
      if (!v) throw new Error('simulator client id parameter is empty');
      return v;
    })
    .catch((err: unknown) => {
      simulatorClientIdCache = undefined;
      throw err;
    });
  return simulatorClientIdCache;
}

/** 測試用 / For tests. */
export function resetSimulatorClientIdCache(): void {
  simulatorClientIdCache = undefined;
}

export const handler = async (event: PreTokenGenerationV2TriggerEvent): Promise<PreTokenGenerationV2TriggerEvent> => {
  const groups = event.request.groupConfiguration.groupsToOverride ?? [];
  const viaSimulatorClient = event.callerContext.clientId === (await simulatorClientId());
  const decision = decide(groups, event.request.userAttributes['custom:tenant_id'], { viaSimulatorClient });

  // 只記錄判斷結果，不記錄 Email 等個資 / Log the decision only, never PII such as email.
  const logFields = {
    triggerSource: event.triggerSource,
    groups,
    scopes: decision.scopes,
    hasTenant: decision.tenantId !== undefined,
    viaSimulatorClient,
    synthetic: decision.synthetic === true,
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
        ...(decision.tenantId || decision.synthetic
          ? {
              claimsToAddOrOverride: {
                ...(decision.tenantId ? { tenant_id: decision.tenantId } : {}),
                ...(decision.synthetic ? { synthetic: 'true' } : {}),
              },
            }
          : {}),
      },
    },
  };
  return event;
};
