import { RemovalPolicy, Stack, Validations } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { LambdaGuardrailsChecker } from '../aspects/lambda-guardrails';
import { BrewlineFunction, LATEST_RUNTIME_ACK } from './brewline-function';

/**
 * 部署時 custom resource 的 CDK Provider framework（與 api stack 相同的做法）：自己的角色（日誌只限 log group、
 * 沒有 AWS 託管政策）、明確豁免 Lambda 標準檢查（框架函數的 runtime 由 CDK 決定）。
 * CDK Provider framework for deploy-time custom resources, same pattern as the api stack.
 */
export function deployTimeProvider(scope: Construct, pid: string, onEvent: BrewlineFunction): cr.Provider {
  const logGroup = new logs.LogGroup(scope, `${pid}Logs`, {
    retention: logs.RetentionDays.ONE_WEEK,
    removalPolicy: RemovalPolicy.DESTROY,
  });
  const role = new iam.Role(scope, `${pid}Role`, {
    assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    description: `CDK provider framework role for ${onEvent.function.node.path}`,
  });
  role.addToPolicy(new iam.PolicyStatement({ actions: ['logs:CreateLogStream', 'logs:PutLogEvents'], resources: [logGroup.logGroupArn] }));
  const provider = new cr.Provider(scope, pid, { onEventHandler: onEvent.function, frameworkOnEventRole: role, logGroup });
  Validations.of(provider).acknowledge(LATEST_RUNTIME_ACK);
  LambdaGuardrailsChecker.exempt(
    provider,
    'CDK provider framework function: runtime/architecture are chosen by CDK; it runs only during deployments.',
  );
  Validations.of(role).acknowledge({
    id: `AwsSolutions-IAM5[Resource::<${Stack.of(scope).getLogicalId(onEvent.function.node.defaultChild as never)}.Arn>:*]`,
    reason: 'grantInvoke adds "<function ARN>:*" so the framework can invoke any version/alias of its own handler only.',
  });
  return provider;
}
