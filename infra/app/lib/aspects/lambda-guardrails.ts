import { Annotations, AspectPriority, Aspects, CfnResource, IAspect, Stack } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { IConstruct } from 'constructs';
import { LAMBDA_RUNTIME } from '../config';

const EXEMPT_METADATA = 'brewline:lambda-guardrails-exempt';

/**
 * Lambda 與日誌的防護欄（docs/09 §2.2、COST-004、COST-007、ADR-023）。違規在 synth 時報錯。
 * Lambda and log guardrails. Violations are synth errors, so CI blocks the PR.
 *
 * 每個 Lambda / Every Lambda function:
 *   1. runtime = nodejs24.x
 *   2. arm64
 *   3. X-Ray tracing Active
 *   4. 有保留併發上限（錢包阻斷防護）/ reserved concurrency set (Denial-of-Wallet guard)
 *   5. 使用自建 log group（才能控制保留期）/ an explicit log group (so retention is controlled)
 * 每個 log group 都必須設定保留期 / Every log group has a retention period.
 *
 * CDK 內部產生的函數（例如 custom resource provider）無法完全控制，可用 `exempt()` 明確豁免並寫明原因。
 * CDK-internal functions (e.g. custom-resource providers) can be exempted explicitly with a reason.
 */
export class LambdaGuardrailsChecker implements IAspect {
  public visit(node: IConstruct): void {
    if (!(node instanceof CfnResource) || LambdaGuardrailsChecker.isExempt(node)) {
      return;
    }
    if (node instanceof lambda.CfnFunction) {
      this.checkFunction(node);
    } else if (node instanceof logs.CfnLogGroup) {
      if (Stack.of(node).resolve(node.retentionInDays) === undefined) {
        this.error(node, 'Log group must set a retention period (COST-007)');
      }
    }
  }

  private checkFunction(node: lambda.CfnFunction): void {
    const resolve = (v: unknown) => Stack.of(node).resolve(v);
    const runtime = resolve(node.runtime);
    const architectures = resolve(node.architectures) as string[] | undefined;
    const tracing = resolve(node.tracingConfig) as { mode?: string } | undefined;
    const logging = resolve(node.loggingConfig) as { logGroup?: unknown } | undefined;

    if (runtime !== LAMBDA_RUNTIME) {
      this.error(node, `Lambda runtime must be ${LAMBDA_RUNTIME} (got ${JSON.stringify(runtime)}; ADR-023)`);
    }
    if (architectures?.length !== 1 || architectures[0] !== 'arm64') {
      this.error(node, `Lambda must run on arm64 (got ${JSON.stringify(architectures ?? ['x86_64'])})`);
    }
    if (tracing?.mode !== 'Active') {
      this.error(node, 'Lambda must enable X-Ray tracing (Active)');
    }
    if (typeof resolve(node.reservedConcurrentExecutions) !== 'number') {
      this.error(node, 'Lambda must set reserved concurrency (COST-004)');
    }
    if (logging?.logGroup === undefined) {
      this.error(node, 'Lambda must use an explicit log group with retention (COST-007)');
    }
  }

  private error(node: CfnResource, message: string): void {
    Annotations.of(node).addError(`[LambdaGuardrails] ${message}`);
  }

  private static isExempt(node: IConstruct): boolean {
    for (let c: IConstruct | undefined = node; c; c = c.node.scope) {
      if (c.node.metadata.some((m) => m.type === EXEMPT_METADATA)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 明確豁免（含子節點），原因會寫進 metadata 供稽核。
   * Exempt a scope (and its children); the reason is recorded in metadata for audit.
   */
  public static exempt(scope: IConstruct, reason: string): void {
    scope.node.addMetadata(EXEMPT_METADATA, reason);
  }

  /** 掛到 scope 上 / Attach the checker to a scope. */
  public static attach(scope: IConstruct): void {
    Aspects.of(scope).add(new LambdaGuardrailsChecker(), { priority: AspectPriority.READONLY });
  }
}
