import { ArnFormat, CfnOutput, Duration, RemovalPolicy, Stack, StackProps, Validations } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsDlq } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { EnvName, LambdaSettings } from '../config';
import { BrewlineFunction } from '../constructs/brewline-function';
import { DataStack } from './data-stack';

export interface EventsStackProps extends StackProps {
  readonly envName: EnvName;
  readonly lambda: LambdaSettings;
}

/**
 * 事件層（A3b，ADR-026）：自訂 bus、DynamoDB Streams → EventBridge 發布函數、稽核 log、DLQ、告警。
 * Event layer: custom bus, Streams → EventBridge publisher, audit log, DLQs and alarms.
 *
 * 台北沒有 EventBridge Pipes 與 Archive（status §2）→ 用 Lambda 發布、用 CloudWatch Logs 規則留存事件。
 * No Pipes or Archive in ap-east-2, so a Lambda publishes and a Logs rule keeps the events.
 */
export class EventsStack extends Stack {
  public readonly bus: events.EventBus;

  public static parameterPrefix(envName: EnvName): string {
    return `/brewline/${envName}/events`;
  }

  constructor(scope: Construct, id: string, props: EventsStackProps) {
    super(scope, id, props);
    const { envName } = props;
    const dataPrefix = DataStack.parameterPrefix(envName);
    const param = (name: string) => ssm.StringParameter.valueForStringParameter(this, name);
    const streamArn = param(`${dataPrefix}/table-stream-arn`);
    const keyArn = param(`${dataPrefix}/kms-key-arn`);
    const retention = props.lambda.logRetentionDays as logs.RetentionDays;

    // --- 1) 自訂 bus / Custom bus ---
    this.bus = new events.EventBus(this, 'Bus', {
      eventBusName: `brewline-${envName}`,
      description: `BrewLine ${envName} domain events (source brewline.<module>)`,
    });

    // --- 2) DLQ（SSE-SQS）---
    // 用 SQS 管理的加密而不是 CMK：stream DLQ 只放批次的「位置資訊」（shard、sequence），不含項目內容；
    // 規則 DLQ 放的事件 detail 是白名單（無個資）。CMK 需要在 key policy 加 events.amazonaws.com，而 CMK 由 data stack 管理。
    // SSE-SQS instead of the CMK: the stream DLQ holds only batch pointers, rule DLQs hold allow-listed details;
    // a CMK would need key-policy grants for events.amazonaws.com on a key owned by the data stack.
    const dlq = (cid: string, name: string, purpose: string) => {
      const q = new sqs.Queue(this, cid, {
        queueName: `brewline-${envName}-${name}`,
        encryption: sqs.QueueEncryption.SQS_MANAGED,
        enforceSSL: true,
        retentionPeriod: Duration.days(14),
        removalPolicy: RemovalPolicy.DESTROY,
      });
      Validations.of(q).acknowledge({
        id: 'AwsSolutions-SQS3',
        reason: `This queue is itself a dead-letter queue (${purpose}); a DLQ for a DLQ adds nothing.`,
      });
      return q;
    };
    const streamDlq = dlq('StreamDlq', 'events-stream-dlq', 'stream publisher batches that exhausted retries');
    const ruleDlq = dlq('RuleDlq', 'events-rule-dlq', 'events a rule target could not accept');

    // --- 3) Streams → EventBridge 發布函數 / Stream publisher ---
    const publisher = new BrewlineFunction(this, 'StreamPublisher', {
      envName,
      lambda: props.lambda,
      module: 'events',
      name: 'stream-publisher',
      entry: 'ordering/src/events/stream-publisher.ts',
      description: 'DynamoDB Streams -> EventBridge: OrderCreated, OrderStatusChanged, StockLow (no Pipes in ap-east-2)',
      reservedConcurrency: props.lambda.reservedConcurrency.streamPublisher,
      timeout: Duration.seconds(30),
      environment: { EVENT_BUS_NAME: this.bus.eventBusName, POWERTOOLS_SERVICE_NAME: 'events-stream-publisher' },
    });
    // 讀 stream（stream 以表的 CMK 加密 → 需要 kms:Decrypt）/ Read the CMK-encrypted stream.
    publisher.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadTableStream',
        actions: ['dynamodb:DescribeStream', 'dynamodb:GetRecords', 'dynamodb:GetShardIterator'],
        resources: [streamArn],
      }),
    );
    publisher.role.addToPolicy(
      new iam.PolicyStatement({ sid: 'ListStreams', actions: ['dynamodb:ListStreams'], resources: ['*'] }),
    );
    publisher.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'DecryptStream',
        actions: ['kms:Decrypt'],
        resources: [keyArn],
        conditions: { StringEquals: { 'kms:ViaService': `dynamodb.${this.region}.amazonaws.com` } },
      }),
    );
    this.bus.grantPutEventsTo(publisher.role);
    Validations.of(publisher.role).acknowledge({
      id: 'AwsSolutions-IAM5[Resource::*]',
      reason: 'dynamodb:ListStreams does not support resource-level permissions (it is an account-level list call).',
    });

    const mapping = new lambda.EventSourceMapping(this, 'StreamMapping', {
      target: publisher.function,
      eventSourceArn: streamArn,
      startingPosition: lambda.StartingPosition.LATEST,
      batchSize: 25,
      bisectBatchOnError: true,
      retryAttempts: 3,
      maxRecordAge: Duration.hours(1),
      reportBatchItemFailures: true,
      // 失敗的批次（位置資訊）由事件來源對應以**函數角色**送到 DLQ（SqsDlq 會授權 sqs:SendMessage）
      // Failed batches (pointers) go to the DLQ using the function role; SqsDlq grants sqs:SendMessage.
      onFailure: new SqsDlq(streamDlq),
      // 事件過濾：只叫起訂單與庫存的變更（冪等記錄、商品 META、刪除都不會叫起函數）
      // Event filtering: only order and stock changes invoke the function.
      filters: [
        lambda.FilterCriteria.filter({ dynamodb: { NewImage: { entity: { S: lambda.FilterRule.isEqual('Order') } } } }),
        lambda.FilterCriteria.filter({
          eventName: lambda.FilterRule.isEqual('MODIFY'),
          dynamodb: { Keys: { sk: { S: lambda.FilterRule.isEqual('STOCK') } } },
        }),
      ],
    });
    // 建立對應時 Lambda 會檢查角色能否讀 stream → 先建好政策 / The mapping validates stream permissions on create.
    const defaultPolicy = publisher.role.node.tryFindChild('DefaultPolicy');
    if (defaultPolicy) mapping.node.addDependency(defaultPolicy);

    // --- 4) 事件稽核 log（取代台北沒有的 Archive）/ Audit log (Archive is unavailable in ap-east-2) ---
    const eventLog = new logs.LogGroup(this, 'EventLog', {
      logGroupName: `/aws/events/brewline-${envName}`,
      retention,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const auditRule = new events.Rule(this, 'AuditRule', {
      eventBus: this.bus,
      ruleName: `brewline-${envName}-audit-log`,
      description: 'Every brewline.* event to CloudWatch Logs (audit and verification; Archive is unavailable here)',
      eventPattern: { source: events.Match.prefix('brewline.') },
    });
    // 不用 targets.CloudWatchLogGroup：它會建立一個 AwsCustomResource Lambda 來寫 log 資源政策（不符 Lambda 標準）。
    // 改用 CloudFormation 原生的 AWS::Logs::ResourcePolicy，並限定 aws:SourceArn = 這條規則。
    // Avoid targets.CloudWatchLogGroup (it deploys an AwsCustomResource Lambda); use a native Logs resource policy
    // scoped to this rule via aws:SourceArn.
    const logGroupTargetArn = this.formatArn({
      service: 'logs',
      resource: 'log-group',
      resourceName: eventLog.logGroupName,
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });
    new logs.ResourcePolicy(this, 'EventLogPolicy', {
      resourcePolicyName: `brewline-${envName}-events-to-logs`,
      policyStatements: [
        new iam.PolicyStatement({
          principals: [new iam.ServicePrincipal('events.amazonaws.com'), new iam.ServicePrincipal('delivery.logs.amazonaws.com')],
          actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
          resources: [eventLog.logGroupArn],
          conditions: { ArnEquals: { 'aws:SourceArn': auditRule.ruleArn } },
        }),
      ],
    });
    auditRule.addTarget({
      bind: () => ({
        arn: logGroupTargetArn,
        deadLetterConfig: { arn: ruleDlq.queueArn },
        retryPolicy: { maximumRetryAttempts: 3, maximumEventAgeInSeconds: 2 * 60 * 60 },
      }),
    });
    // 規則把送不出去的事件放進 DLQ：只允許這條規則 / Only this rule may write to the rule DLQ.
    ruleDlq.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowAuditRuleDlq',
        principals: [new iam.ServicePrincipal('events.amazonaws.com')],
        actions: ['sqs:SendMessage'],
        resources: [ruleDlq.queueArn],
        conditions: { ArnEquals: { 'aws:SourceArn': auditRule.ruleArn } },
      }),
    );

    // --- 5) 告警（A3 決策 D7：通知目標在 A4）/ Alarms (notification target arrives in A4) ---
    new cloudwatch.Alarm(this, 'IteratorAgeAlarm', {
      alarmName: `brewline-${envName}-events-stream-iterator-age`,
      alarmDescription: 'Stream publisher is more than 5 minutes behind (OPS-A04-like). Runbook RB-OPS-02.',
      metric: publisher.function.metric('IteratorAge', { statistic: 'Maximum', period: Duration.minutes(5) }),
      threshold: 5 * 60 * 1000,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    for (const [cid, q, qname] of [
      ['StreamDlqAlarm', streamDlq, 'events-stream-dlq'],
      ['RuleDlqAlarm', ruleDlq, 'events-rule-dlq'],
    ] as const) {
      new cloudwatch.Alarm(this, cid, {
        alarmName: `brewline-${envName}-${qname}-not-empty`,
        alarmDescription: 'Dead-letter queue has messages (OPS-A05). Runbook RB-OPS-02.',
        metric: q.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5), statistic: 'Maximum' }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
    }

    // --- 6) 給其他 stack 的 SSM 參數 / SSM parameters for other stacks ---
    const prefix = EventsStack.parameterPrefix(envName);
    for (const [pid, name, value] of [
      ['BusNameParam', 'bus-name', this.bus.eventBusName],
      ['BusArnParam', 'bus-arn', this.bus.eventBusArn],
    ] as const) {
      new ssm.StringParameter(this, pid, {
        parameterName: `${prefix}/${name}`,
        stringValue: value,
        tier: ssm.ParameterTier.STANDARD,
        description: `BrewLine ${envName} event layer: ${name}`,
      });
    }

    new CfnOutput(this, 'BusName', { value: this.bus.eventBusName });
    new CfnOutput(this, 'PublisherFunctionName', { value: publisher.function.functionName });
    new CfnOutput(this, 'StreamMappingId', { value: mapping.eventSourceMappingId });
    new CfnOutput(this, 'EventLogGroup', { value: eventLog.logGroupName });
    new CfnOutput(this, 'StreamDlqUrl', { value: streamDlq.queueUrl });
    new CfnOutput(this, 'RuleDlqUrl', { value: ruleDlq.queueUrl });
  }
}
