import { Annotations, AspectPriority, Aspects, CfnResource, IAspect, Stack } from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { IConstruct } from 'constructs';

/**
 * HTTP API 防護欄（ADR-020、ADR-021、ADR-022、COST-003）。違規在 synth 時報錯。
 * HTTP API guardrails. Violations are synth errors.
 *
 * - 每條路由都要 JWT authorizer **而且** 至少一個 scope：只驗證「有登入」不夠，ID token 或沒有權限的使用者
 *   也能通過；scope 讓 Gateway 在叫起 Lambda 前就回 403。
 *   Every route needs a JWT authorizer AND at least one scope; "signed in" alone is not authorization.
 * - 每個 stage 都要 access log 與預設限流（沒有 WAF 時，限流是第一道錢包阻斷防線）。
 *   Every stage needs access logs and default throttling (the first Denial-of-Wallet guard without WAF).
 */
export class ApiGuardrailsChecker implements IAspect {
  public visit(node: IConstruct): void {
    if (!(node instanceof CfnResource)) return;
    const resolve = (v: unknown) => Stack.of(node).resolve(v);

    if (node instanceof apigwv2.CfnRoute) {
      const routeKey = resolve(node.routeKey);
      if (resolve(node.authorizationType) !== 'JWT') {
        this.error(node, `Route ${routeKey} must use the JWT authorizer`);
      }
      const scopes = resolve(node.authorizationScopes) as string[] | undefined;
      if (!scopes || scopes.length === 0) {
        this.error(node, `Route ${routeKey} must require at least one OAuth scope`);
      }
    } else if (node instanceof apigwv2.CfnStage) {
      const logsCfg = resolve(node.accessLogSettings) as { destinationArn?: unknown } | undefined;
      if (logsCfg?.destinationArn === undefined) {
        this.error(node, 'Stage must enable access logging');
      }
      const route = resolve(node.defaultRouteSettings) as
        | { throttlingRateLimit?: number; throttlingBurstLimit?: number }
        | undefined;
      if (typeof route?.throttlingRateLimit !== 'number' || typeof route?.throttlingBurstLimit !== 'number') {
        this.error(node, 'Stage must set default throttling (COST-003)');
      }
    }
  }

  private error(node: CfnResource, message: string): void {
    Annotations.of(node).addError(`[ApiGuardrails] ${message}`);
  }

  public static attach(scope: IConstruct): void {
    Aspects.of(scope).add(new ApiGuardrailsChecker(), { priority: AspectPriority.READONLY });
  }
}
