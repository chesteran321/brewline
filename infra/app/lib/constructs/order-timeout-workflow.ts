import { Duration, RemovalPolicy, Stack, Validations } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct } from 'constructs';
import { EnvName, LambdaSettings } from '../config';
import { BrewlineFunction } from './brewline-function';

export interface OrderTimeoutWorkflowProps {
  readonly envName: EnvName;
  readonly lambda: LambdaSettings;
  readonly tableName: string;
  readonly tableArn: string;
  readonly keyArn: string;
  readonly gsi1Name: string;
  /** 事件 bus 名稱（SSM）/ Event bus name from SSM. */
  readonly busName: string;
  readonly timeoutSeconds: number;
}

/**
 * 未確認訂單的逾時取消（A3d，ADR-028）：OrderCreated → Standard 狀態機 → 等待 → 仍是 CREATED 就取消並釋放庫存。
 * Unconfirmed-order timeout: OrderCreated → Standard workflow → wait → cancel if still CREATED.
 *
 * 狀態以 DynamoDB 為準（A3 決策 D2）：工作流**不保存**訂單狀態，只負責「時間到了去檢查一次」。
 * DynamoDB stays the source of truth; the workflow only checks once when the time is up.
 */
export class OrderTimeoutWorkflow extends Construct {
  public readonly stateMachine: sfn.StateMachine;
  public readonly function: BrewlineFunction;
  public readonly dlq: sqs.Queue;

  constructor(scope: Construct, id: string, props: OrderTimeoutWorkflowProps) {
    super(scope, id);
    const { envName } = props;
    const region = Stack.of(this).region;

    // --- 取消函數（staff 邏輯，actor system:timeout）/ Cancel function ---
    this.function = new BrewlineFunction(this, 'CancelFunction', {
      envName,
      lambda: props.lambda,
      module: 'ordering',
      name: 'order-timeout',
      entry: 'ordering/src/handlers/order-timeout.ts',
      description: 'Step Functions task: cancel an order still CREATED after the timeout and release its stock',
      reservedConcurrency: props.lambda.reservedConcurrency.streamPublisher,
      environment: {
        TABLE_NAME: props.tableName,
        GSI1_NAME: props.gsi1Name,
        POWERTOOLS_SERVICE_NAME: 'ordering-order-timeout',
      },
    });
    const role = this.function.role;
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'TransitionTenantOrder',
        actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
        resources: [props.tableArn],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['TENANT#*'] } },
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReleaseStockOnly',
        actions: ['dynamodb:UpdateItem'],
        resources: [props.tableArn],
        conditions: {
          'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['PRODUCT#*'] },
          'ForAllValues:StringEquals': {
            'dynamodb:Attributes': ['pk', 'sk', 'available_kg', 'reserved_kg', 'version', 'updated_at'],
          },
          StringEqualsIfExists: { 'dynamodb:ReturnValues': ['NONE', 'UPDATED_NEW', 'UPDATED_OLD'] },
        },
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'DenyScan',
        effect: iam.Effect.DENY,
        actions: ['dynamodb:Scan'],
        resources: [props.tableArn, `${props.tableArn}/index/*`],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'KeyViaDynamoDB',
        actions: ['kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKey'],
        resources: [props.keyArn],
        conditions: { StringEquals: { 'kms:ViaService': `dynamodb.${region}.amazonaws.com` } },
      }),
    );

    // --- 狀態機 / State machine ---
    const wait = new sfn.Wait(this, 'WaitForConfirmation', {
      comment: `Give staff ${props.timeoutSeconds} seconds to confirm the order`,
      time: sfn.WaitTime.duration(Duration.seconds(props.timeoutSeconds)),
    });
    const cancel = new tasks.LambdaInvoke(this, 'CancelIfStillCreated', {
      lambdaFunction: this.function.function,
      payload: sfn.TaskInput.fromObject({ tenant_id: sfn.JsonPath.stringAt('$.tenant_id'), order_id: sfn.JsonPath.stringAt('$.order_id') }),
      payloadResponseOnly: true,
      resultPath: '$.result',
      retryOnServiceExceptions: true,
    });
    // 狀態剛好被改（conflict）或忙碌：指數退避重試 3 次（09 §2.3）/ Exponential backoff, 3 attempts.
    cancel.addRetry({ errors: ['RetryableError'], interval: Duration.seconds(10), maxAttempts: 3, backoffRate: 2 });
    const failed = new sfn.Fail(this, 'CancelFailed', {
      error: 'OrderTimeoutCancelFailed',
      cause: 'Could not cancel the unconfirmed order; see the execution history and the function logs',
    });
    cancel.addCatch(failed, { errors: ['States.ALL'], resultPath: '$.error' });
    const done = new sfn.Succeed(this, 'Done');

    const logGroup = new logs.LogGroup(this, 'Logs', {
      logGroupName: `/aws/vendedlogs/states/brewline-${envName}-order-lifecycle`,
      retention: props.lambda.logRetentionDays as logs.RetentionDays,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.stateMachine = new sfn.StateMachine(this, 'StateMachine', {
      stateMachineName: `brewline-${envName}-order-lifecycle`,
      stateMachineType: sfn.StateMachineType.STANDARD,
      comment: 'Cancel an order that staff did not confirm in time (ADR-028)',
      definitionBody: sfn.DefinitionBody.fromChainable(wait.next(cancel).next(done)),
      timeout: Duration.seconds(props.timeoutSeconds + 60 * 60),
      tracingEnabled: true,
      // ALL：每個狀態轉換都記錄（cdk-nag SF1）；不含執行資料（輸入只有 tenant_id／order_id，仍不必寫進 log）
      // Log every transition (cdk-nag SF1) but not the execution data.
      logs: { destination: logGroup, level: sfn.LogLevel.ALL, includeExecutionData: false },
    });
    Validations.of(this.stateMachine.role).acknowledge({
      id: 'AwsSolutions-IAM5[Resource::*]',
      reason:
        'CDK-generated: CloudWatch Logs vended-log delivery APIs (logs:CreateLogDelivery, ...) and X-Ray do not support resource-level permissions.',
    });
    Validations.of(this.stateMachine.role).acknowledge({
      id: `AwsSolutions-IAM5[Resource::<${Stack.of(this).getLogicalId(this.function.function.node.defaultChild as never)}.Arn>:*]`,
      reason: 'CDK-generated lambda:InvokeFunction on the cancel function and its versions/aliases (the function ARN plus ":*").',
    });

    // --- OrderCreated → 啟動執行 / OrderCreated starts an execution ---
    this.dlq = new sqs.Queue(this, 'Dlq', {
      queueName: `brewline-${envName}-order-timeout-dlq`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
      removalPolicy: RemovalPolicy.DESTROY,
    });
    Validations.of(this.dlq).acknowledge({
      id: 'AwsSolutions-SQS3',
      reason: 'This queue is itself the dead-letter queue for OrderCreated events the rule could not deliver to Step Functions.',
    });
    const bus = events.EventBus.fromEventBusName(this, 'Bus', props.busName);
    new events.Rule(this, 'OrderCreatedRule', {
      eventBus: bus,
      ruleName: `brewline-${envName}-order-timeout`,
      description: 'OrderCreated → order-lifecycle state machine (timeout cancel)',
      eventPattern: { source: ['brewline.ordering'], detailType: ['OrderCreated'] },
      targets: [
        new targets.SfnStateMachine(this.stateMachine, {
          // 只傳需要的欄位 / Pass only what the workflow needs.
          input: events.RuleTargetInput.fromObject({
            tenant_id: events.EventField.fromPath('$.detail.tenant_id'),
            order_id: events.EventField.fromPath('$.detail.order_id'),
            event_id: events.EventField.fromPath('$.detail.event_id'),
          }),
          deadLetterQueue: this.dlq,
          retryAttempts: 3,
          maxEventAge: Duration.hours(2),
        }),
      ],
    });

    // --- 告警（A3 決策 D7，通知在 A4）/ Alarms (notifications arrive in A4) ---
    new cloudwatch.Alarm(this, 'FailedAlarm', {
      alarmName: `brewline-${envName}-order-lifecycle-failed`,
      alarmDescription: 'Order timeout workflow failed (OPS-A06). Runbook RB-OPS-02.',
      metric: this.stateMachine.metricFailed({ period: Duration.minutes(5), statistic: 'Sum' }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    new cloudwatch.Alarm(this, 'DlqAlarm', {
      alarmName: `brewline-${envName}-order-timeout-dlq-not-empty`,
      alarmDescription: 'OrderCreated events could not start the timeout workflow (OPS-A05). Runbook RB-OPS-02.',
      metric: this.dlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5), statistic: 'Maximum' }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
  }
}
