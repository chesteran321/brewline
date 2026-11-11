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

export interface BrewlineEnv {
  readonly name: EnvName;
  readonly account: string;
  readonly region: string;
  readonly data: DataSettings;
}

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
