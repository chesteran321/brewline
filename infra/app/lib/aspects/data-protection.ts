import { Annotations, AspectPriority, Aspects, CfnResource, IAspect, Stack } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { IConstruct } from 'constructs';

export interface DataProtectionOptions {
  /** Prod 必須開刪除保護 / Prod must have deletion protection. */
  readonly requireDeletionProtection: boolean;
}

/**
 * DynamoDB 資料保護檢查（ADR-018、ADR-019）。違規在 synth 時報錯，CI 因此擋下 PR。
 * DynamoDB data-protection gate. Violations are synth errors, so CI blocks the PR.
 *
 * 為什麼需要：cdk-nag AwsSolutions-DDB3（PITR）只檢查 CfnTable；TableV2 產生的是
 * CfnGlobalTable，會被當成「不適用」。這裡對兩種資源都檢查：
 * Why: cdk-nag DDB3 only inspects CfnTable; TableV2 emits CfnGlobalTable, which it treats as
 * not applicable. This checks both resource types for:
 *   1. 每個 replica 都開 PITR / PITR on every replica
 *   2. 以 KMS 客戶管理金鑰加密 / SSE with a customer managed KMS key
 *   3. （Prod）每個 replica 都開刪除保護 / (Prod) deletion protection on every replica
 */
export class DataProtectionChecker implements IAspect {
  constructor(private readonly options: DataProtectionOptions) {}

  public visit(node: IConstruct): void {
    if (node instanceof dynamodb.CfnGlobalTable) {
      this.checkGlobalTable(node);
    } else if (node instanceof dynamodb.CfnTable) {
      this.checkTable(node);
    }
  }

  private checkGlobalTable(node: dynamodb.CfnGlobalTable): void {
    const resolve = (v: unknown) => Stack.of(node).resolve(v);
    const sse = resolve(node.sseSpecification) as { sseEnabled?: boolean; sseType?: string } | undefined;
    const replicas = (resolve(node.replicas) ?? []) as Array<{
      region?: string;
      sseSpecification?: { kmsMasterKeyId?: unknown };
      pointInTimeRecoverySpecification?: { pointInTimeRecoveryEnabled?: boolean };
      deletionProtectionEnabled?: boolean;
    }>;

    if (sse?.sseEnabled !== true || sse.sseType !== 'KMS') {
      this.error(node, 'must use SSE-KMS (TableEncryptionV2.customerManagedKey)');
    }
    for (const r of replicas) {
      const where = `replica ${r.region ?? '(primary)'}`;
      if (sse?.sseType === 'KMS' && r.sseSpecification?.kmsMasterKeyId === undefined) {
        this.error(node, `${where} must reference a customer managed KMS key, not the AWS managed key`);
      }
      if (r.pointInTimeRecoverySpecification?.pointInTimeRecoveryEnabled !== true) {
        this.error(node, `${where} must enable point-in-time recovery`);
      }
      if (this.options.requireDeletionProtection && r.deletionProtectionEnabled !== true) {
        this.error(node, `${where} must enable deletion protection`);
      }
    }
  }

  private checkTable(node: dynamodb.CfnTable): void {
    const resolve = (v: unknown) => Stack.of(node).resolve(v);
    const sse = resolve(node.sseSpecification) as { sseEnabled?: boolean; sseType?: string; kmsMasterKeyId?: unknown } | undefined;
    const pitr = resolve(node.pointInTimeRecoverySpecification) as { pointInTimeRecoveryEnabled?: boolean } | undefined;

    if (sse?.sseEnabled !== true || sse.sseType !== 'KMS' || sse.kmsMasterKeyId === undefined) {
      this.error(node, 'must use SSE-KMS with a customer managed key');
    }
    if (pitr?.pointInTimeRecoveryEnabled !== true) {
      this.error(node, 'must enable point-in-time recovery');
    }
    if (this.options.requireDeletionProtection && resolve(node.deletionProtectionEnabled) !== true) {
      this.error(node, 'must enable deletion protection');
    }
  }

  private error(node: CfnResource, message: string): void {
    Annotations.of(node).addError(`[DataProtection] DynamoDB table ${message}`);
  }

  /** 掛到 scope 上 / Attach the checker to a scope. */
  public static attach(scope: IConstruct, options: DataProtectionOptions): void {
    Aspects.of(scope).add(new DataProtectionChecker(options), { priority: AspectPriority.READONLY });
  }
}
