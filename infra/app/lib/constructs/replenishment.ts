import { Duration, Stack, Validations } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as destinations from 'aws-cdk-lib/aws-lambda-destinations';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { EnvName, LambdaSettings } from '../config';
import { BrewlineFunction } from './brewline-function';
import { TenantAccessRole } from './tenant-access-role';

export interface ReplenishmentProps {
  readonly envName: EnvName;
  readonly lambda: LambdaSettings;
  readonly tableName: string;
  readonly busName: string;
  readonly busArn: string;
  readonly tenantAccess: TenantAccessRole;
  /** API 路由用的保留併發 / Reserved concurrency for the API functions. */
  readonly apiConcurrency: number;
}

/**
 * 定期補貨（A4e，ADR-029 D6）：API 函數 3 個、執行函數 1 個、Scheduler 群組、Scheduler 執行角色、DLQ、告警。
 * Recurring replenishment: three API functions, the run function, the schedule group, the Scheduler role, DLQ, alarm.
 *
 * 所有函數的角色都是 `brewline-<env>-orders-*` → 只能經租戶角色碰資料；本身沒有 DynamoDB／KMS 權限。
 * Every role matches `brewline-<env>-orders-*`, so data access goes through the tenant role only.
 */
export class Replenishment extends Construct {
  public readonly group: scheduler.CfnScheduleGroup;
  public readonly runFunction: BrewlineFunction;
  public readonly schedulerRole: iam.Role;
  public readonly dlq: sqs.Queue;
  public readonly createFn: BrewlineFunction;
  public readonly listFn: BrewlineFunction;
  public readonly deleteFn: BrewlineFunction;

  public static groupName(envName: EnvName): string {
    return `brewline-${envName}-replenish`;
  }

  constructor(scope: Construct, id: string, props: ReplenishmentProps) {
    super(scope, id);
    const { envName } = props;
    const { account, region } = Stack.of(this);
    const groupName = Replenishment.groupName(envName);
    const schedulesArn = `arn:aws:scheduler:${region}:${account}:schedule/${groupName}/*`;
    // Scheduler 扮演角色時帶的 aws:SourceArn 是**排程群組**的 ARN（不是個別排程）；寫成 schedule/... 會讓
    // CreateSchedule 回 ValidationException（2026-11-16 實際踩到）。
    // Scheduler presents the *schedule group* ARN as aws:SourceArn; scoping to schedule/... makes CreateSchedule fail.
    const groupArn = `arn:aws:scheduler:${region}:${account}:schedule-group/${groupName}`;

    // CDK 內建區域資料可能過時（A4d 的 SES 即是）；部署前已以 describe-type 確認 / Verified with describe-type.
    this.group = new scheduler.CfnScheduleGroup(this, 'Group', { name: groupName });

    this.dlq = new sqs.Queue(this, 'Dlq', {
      queueName: `brewline-${envName}-replenish-dlq`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
    });
    Validations.of(this.dlq).acknowledge({
      id: 'AwsSolutions-SQS3',
      reason: 'This queue is itself the dead-letter queue for replenishment runs (Scheduler and async Lambda failures).',
    });

    const fn = (cid: string, name: string, roleSuffix: string, entry: string, description: string, concurrency: number) => {
      const f = new BrewlineFunction(this, cid, {
        envName,
        lambda: props.lambda,
        module: 'ordering',
        name,
        entry,
        description,
        reservedConcurrency: concurrency,
        roleName: `${TenantAccessRole.callerRolePrefix(envName)}${roleSuffix}`,
        environment: {
          TABLE_NAME: props.tableName,
          TENANT_ROLE_ARN: props.tenantAccess.role.roleArn,
          POWERTOOLS_SERVICE_NAME: `ordering-${name}`,
          POWERTOOLS_TRACER_CAPTURE_RESPONSE: 'false',
        },
      });
      props.tenantAccess.grantAssume(f.role);
      return f;
    };

    // --- 執行函數 / Run function ---
    this.runFunction = fn('Run', 'replenish', 'replenish', 'ordering/src/handlers/replenish.ts',
      'Scheduler target: place the recurring order (tenant credentials); ReplenishmentFailed on insufficient stock',
      props.lambda.reservedConcurrency.replenish);
    this.runFunction.function.addEnvironment('BUS_NAME', props.busName);
    this.runFunction.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PublishReplenishmentFailed',
        actions: ['events:PutEvents'],
        resources: [props.busArn],
        // 只能發這一種事件 / Only this one event type.
        conditions: { StringEquals: { 'events:source': 'brewline.ordering', 'events:detail-type': 'ReplenishmentFailed' } },
      }),
    );
    // Scheduler → Lambda 是非同步呼叫：失敗重試 2 次，再進 DLQ / Async: 2 retries, then the DLQ.
    this.runFunction.function.configureAsyncInvoke({
      retryAttempts: 2,
      maxEventAge: Duration.hours(6),
      onFailure: new destinations.SqsDestination(this.dlq),
    });

    // --- Scheduler 執行角色：只能呼叫執行函數、寫 DLQ；只有本帳號這個群組的排程能使用 ---
    //     Scheduler role: invoke the run function and write the DLQ; usable only by this group's schedules.
    this.schedulerRole = new iam.Role(this, 'SchedulerRole', {
      roleName: `brewline-${envName}-replenish-scheduler`,
      description: 'Assumed by EventBridge Scheduler for brewline replenishment schedules (A4e)',
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': account, 'aws:SourceArn': groupArn },
        },
      }),
    });
    this.schedulerRole.addToPolicy(
      new iam.PolicyStatement({ sid: 'InvokeRun', actions: ['lambda:InvokeFunction'], resources: [this.runFunction.function.functionArn] }),
    );
    this.schedulerRole.addToPolicy(
      new iam.PolicyStatement({ sid: 'WriteDlq', actions: ['sqs:SendMessage'], resources: [this.dlq.queueArn] }),
    );

    // --- API 函數 / API functions ---
    const schedEnv = {
      SCHEDULE_GROUP: groupName,
      REPLENISH_FUNCTION_ARN: this.runFunction.function.functionArn,
      SCHEDULER_ROLE_ARN: this.schedulerRole.roleArn,
      REPLENISH_DLQ_ARN: this.dlq.queueArn,
    };
    this.createFn = fn('Create', 'create-replenishment', 'repl-create', 'ordering/src/handlers/create-replenishment.ts',
      'POST /replenishments: store the subscription and create its schedule (compensated on failure)', props.apiConcurrency);
    this.listFn = fn('List', 'list-replenishments', 'repl-list', 'ordering/src/handlers/list-replenishments.ts',
      "GET /replenishments: own tenant's active subscriptions", props.apiConcurrency);
    this.deleteFn = fn('Delete', 'delete-replenishment', 'repl-delete', 'ordering/src/handlers/delete-replenishment.ts',
      'DELETE /replenishments/{id}: soft delete, then remove the schedule', props.apiConcurrency);
    for (const f of [this.createFn, this.listFn, this.deleteFn]) {
      for (const [k, v] of Object.entries(schedEnv)) f.function.addEnvironment(k, v);
      // 群組名稱是字串，不會自動產生依賴 → 明確指定（群組要先存在才能建排程）
      // The group is referenced by name only, so declare the dependency explicitly.
      f.node.addDependency(this.group);
    }
    this.createFn.role.addToPolicy(
      new iam.PolicyStatement({ sid: 'CreateSchedule', actions: ['scheduler:CreateSchedule'], resources: [schedulesArn] }),
    );
    this.createFn.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PassSchedulerRole',
        actions: ['iam:PassRole'],
        resources: [this.schedulerRole.roleArn],
        conditions: { StringEquals: { 'iam:PassedToService': 'scheduler.amazonaws.com' } },
      }),
    );
    this.deleteFn.role.addToPolicy(
      new iam.PolicyStatement({ sid: 'DeleteSchedule', actions: ['scheduler:DeleteSchedule'], resources: [schedulesArn] }),
    );
    for (const f of [this.createFn, this.deleteFn]) {
      Validations.of(f.role).acknowledge({
        id: `AwsSolutions-IAM5[Resource::arn:aws:scheduler:${region}:${account}:schedule/${groupName}/*]`,
        reason: 'Schedule names are <tenant_id>-<replenishment_id>, created at runtime; access is limited to the replenish group.',
      });
    }

    new cloudwatch.Alarm(this, 'DlqAlarm', {
      alarmName: `brewline-${envName}-replenish-dlq-not-empty`,
      alarmDescription: 'Replenishment runs that failed after retries (OPS-A05). Runbook RB-OPS-02.',
      metric: this.dlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5), statistic: 'Maximum' }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
  }
}
