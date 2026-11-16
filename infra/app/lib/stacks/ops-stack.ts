import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct, IConstruct } from 'constructs';
import { EnvName } from '../config';
import { DataStack } from './data-stack';

export interface OpsStackProps extends StackProps {
  readonly envName: EnvName;
}

/**
 * 維運通知（A4b，ADR-029 D3）：以每帳號 CMK 加密的 SNS 主題 `brewline-<env>-ops-alerts`。
 * Ops notifications: an SNS topic encrypted with the account CMK.
 *
 * - 主題 ARN 發布到 SSM `/brewline/<env>/ops/alerts-topic-arn`；其他 stack 以 `notifyAlarms()` 把告警接上。
 * - Email 訂閱**不在 IaC 裡**（公開 repo 不能有 Email）：以 CLI 手動訂閱並確認。
 * - Topic ARN goes to SSM; other stacks attach alarms with notifyAlarms(). Email subscriptions are manual (public repo).
 */
export class OpsStack extends Stack {
  public readonly topic: sns.Topic;

  public static parameterPrefix(envName: EnvName): string {
    return `/brewline/${envName}/ops`;
  }

  constructor(scope: Construct, id: string, props: OpsStackProps) {
    super(scope, id, props);
    const { envName } = props;
    const keyArn = ssm.StringParameter.valueForStringParameter(this, `${DataStack.parameterPrefix(envName)}/kms-key-arn`);

    this.topic = new sns.Topic(this, 'AlertsTopic', {
      topicName: `brewline-${envName}-ops-alerts`,
      displayName: `BrewLine ${envName} ops alerts`,
      masterKey: kms.Key.fromKeyArn(this, 'DataKey', keyArn),
      enforceSSL: true,
    });
    // 只允許本帳號的 CloudWatch 告警與 EventBridge 規則發布（金鑰端的授權在 data stack，A4a）。
    // Only this account's CloudWatch alarms and EventBridge rules may publish (the key side is in the data stack).
    this.topic.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowAlarmsAndRulesToPublish',
        principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com'), new iam.ServicePrincipal('events.amazonaws.com')],
        actions: ['sns:Publish'],
        resources: [this.topic.topicArn],
        conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
      }),
    );

    // SES configuration set 的退信／投訴事件（A4d，ADR-029 E5）：只限本帳號、brewline-<env>-* 的 configuration set。
    // SES bounce/complaint events from this account's brewline-<env>-* configuration sets only.
    this.topic.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowSesEventsToPublish',
        principals: [new iam.ServicePrincipal('ses.amazonaws.com')],
        actions: ['sns:Publish'],
        resources: [this.topic.topicArn],
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnLike: { 'aws:SourceArn': `arn:aws:ses:${this.region}:${this.account}:configuration-set/brewline-${envName}-*` },
        },
      }),
    );

    new ssm.StringParameter(this, 'AlertsTopicArnParam', {
      parameterName: `${OpsStack.parameterPrefix(envName)}/alerts-topic-arn`,
      stringValue: this.topic.topicArn,
      tier: ssm.ParameterTier.STANDARD,
      description: `BrewLine ${envName} ops alerts SNS topic`,
    });
    new CfnOutput(this, 'AlertsTopicArn', { value: this.topic.topicArn });
  }
}

/**
 * 把 scope 底下**所有** CloudWatch 告警接上維運主題（ALARM 與 OK 都通知）。之後新增的告警自動涵蓋。
 * Attach every CloudWatch alarm under the scope to the ops topic (ALARM and OK). Future alarms are covered too.
 */
export function notifyAlarms(scope: Construct, envName: EnvName): number {
  const topicArn = ssm.StringParameter.valueForStringParameter(scope, `${OpsStack.parameterPrefix(envName)}/alerts-topic-arn`);
  const alarms = scope.node.findAll().filter((c: IConstruct): c is cloudwatch.CfnAlarm => c instanceof cloudwatch.CfnAlarm);
  for (const a of alarms) {
    a.alarmActions = [topicArn];
    a.okActions = [topicArn];
  }
  return alarms.length;
}
