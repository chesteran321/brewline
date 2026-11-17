import { CfnOutput, CustomResource, Duration, RemovalPolicy, Stack, StackProps, Validations } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as destinations from 'aws-cdk-lib/aws-lambda-destinations';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { LambdaGuardrailsChecker } from '../aspects/lambda-guardrails';
import { EnvName, LambdaSettings, SimulatorSettings } from '../config';
import { BrewlineFunction, LATEST_RUNTIME_ACK } from '../constructs/brewline-function';
import { ApiStack } from './api-stack';
import { AuthStack } from './auth-stack';
import { DataStack } from './data-stack';
import { notifyAlarms } from './ops-stack';

export interface SimulatorStackProps extends StackProps {
  readonly envName: EnvName;
  readonly lambda: LambdaSettings;
  readonly simulator: SimulatorSettings;
  /** 每次部署都重跑帳號檢查（自我修復缺少的帳號或密碼）/ Re-run the account check on every deploy (self-healing). */
  readonly commitSha: string;
}

/**
 * 模擬器（docs/07、ADR-030）：帳號、開關、排程（S1b）與訂單產生器（S1c）。
 * Simulator: accounts, kill switch, schedule (S1b) and the order generator (S1c).
 *
 * | 資源 | 說明 |
 * |---|---|
 * | 帳號 custom resource | 部署時建立 `sim-NNN@example.com`（D3）；密碼存 SecureString（CMK）。有 Cognito 管理權限 → RSK-018 |
 * | SSM `state` | 開關，**只在第一次建立**為 `paused`（D7）；之後由人切換，部署不覆蓋 |
 * | SSM `config` | 產生器參數（CDK 管理）|
 * | 排程 | 台北 08:05–19:05 每小時（D8）；自己的排程群組；不重試，失敗進 DLQ |
 * | 執行函數 | 只有 `AdminInitiateAuth`＋讀這 3 個參數；**不能**建立帳號、不能碰 DynamoDB |
 * | 告警 | 函數錯誤、DLQ 有訊息（D9：預期沒達成就丟錯）|
 */
export class SimulatorStack extends Stack {
  public static parameterPrefix(envName: EnvName): string {
    return `/brewline/${envName}/simulator`;
  }

  public static scheduleGroupName(envName: EnvName): string {
    return `brewline-${envName}-simulator`;
  }

  /** 台北 08:05–19:05 每小時（ADR-030 D8）/ Hourly 08:05–19:05 Taipei. */
  public static readonly SCHEDULE_EXPRESSION = 'cron(5 8-19 * * ? *)';
  public static readonly SCHEDULE_TIMEZONE = 'Asia/Taipei';

  constructor(scope: Construct, id: string, props: SimulatorStackProps) {
    super(scope, id, props);
    const { envName, simulator: sim } = props;
    const param = (name: string) => ssm.StringParameter.valueForStringParameter(this, name);
    const authPrefix = AuthStack.parameterPrefix(envName);
    const userPoolArn = param(`${authPrefix}/user-pool-arn`);
    const keyArn = param(`${DataStack.parameterPrefix(envName)}/kms-key-arn`);

    const prefix = SimulatorStack.parameterPrefix(envName);
    const names = { state: `${prefix}/state`, config: `${prefix}/config`, credentials: `${prefix}/credentials` };
    const paramArn = (name: string) => `arn:${this.partition}:ssm:${this.region}:${this.account}:parameter${name}`;

    // SSM SecureString 以 CMK 加密時，encryption context 是 PARAMETER_ARN → 金鑰權限只限這一個參數
    // SSM encrypts SecureStrings with the context PARAMETER_ARN, so key use is pinned to this one parameter.
    const credentialsKey = (actions: string[]) =>
      new iam.PolicyStatement({
        sid: 'CredentialsParameterKey',
        actions,
        resources: [keyArn],
        conditions: {
          StringEquals: {
            'kms:ViaService': `ssm.${this.region}.amazonaws.com`,
            'kms:EncryptionContext:PARAMETER_ARN': paramArn(names.credentials),
          },
        },
      });

    // --- 1) 產生器設定（CDK 管理）/ Generator config (CDK-managed) ---
    const { retainOnDelete: _retain, ...configValue } = sim;
    new ssm.StringParameter(this, 'ConfigParam', {
      parameterName: names.config,
      stringValue: JSON.stringify(configValue),
      tier: ssm.ParameterTier.STANDARD,
      description: `BrewLine ${envName} simulator config (ADR-030)`,
    });

    // --- 2) 帳號 custom resource（D3）/ Account provisioning ---
    const provisioner = new BrewlineFunction(this, 'Provision', {
      envName,
      lambda: props.lambda,
      module: 'simulator',
      name: 'provision',
      entry: 'simulator/src/provision.ts',
      description: 'Deploy-time only: creates the simulated café accounts and stores their passwords (SecureString)',
      reservedConcurrency: props.lambda.reservedConcurrency.customResource,
      timeout: Duration.minutes(5),
      environment: { POWERTOOLS_SERVICE_NAME: 'simulator-provision' },
    });
    provisioner.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ManageSimulatorAccounts',
        actions: [
          'cognito-idp:AdminGetUser',
          'cognito-idp:AdminCreateUser',
          'cognito-idp:AdminAddUserToGroup',
          'cognito-idp:AdminSetUserPassword',
          'cognito-idp:AdminDeleteUser',
        ],
        resources: [userPoolArn],
      }),
    );
    provisioner.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SimulatorParameters',
        actions: ['ssm:GetParameter', 'ssm:PutParameter', 'ssm:DeleteParameter'],
        resources: [paramArn(names.credentials), paramArn(names.state)],
      }),
    );
    provisioner.role.addToPolicy(credentialsKey(['kms:Encrypt', 'kms:Decrypt', 'kms:GenerateDataKey']));

    const accounts = new CustomResource(this, 'Accounts', {
      serviceToken: createProvider(this, 'AccountsProvider', provisioner).serviceToken,
      resourceType: 'Custom::BrewlineSimulatorAccounts',
      properties: {
        UserPoolId: param(`${authPrefix}/user-pool-id`),
        PoolSize: String(sim.poolSize),
        Seed: sim.seed,
        CredentialsParam: names.credentials,
        StateParam: names.state,
        KmsKeyId: keyArn,
        RetainOnDelete: String(sim.retainOnDelete),
        Commit: props.commitSha, // 每次部署都檢查一次 / checked on every deploy
      },
    });

    // --- 3) 執行函數 / Run function ---
    const runFn = new BrewlineFunction(this, 'Run', {
      envName,
      lambda: props.lambda,
      module: 'simulator',
      name: 'run',
      entry: 'simulator/src/run.ts',
      description: 'Scheduled simulator: kill switch (SSM state); orders through the public API as simulated cafes',
      reservedConcurrency: props.lambda.reservedConcurrency.simulator,
      timeout: Duration.minutes(2),
      environment: {
        POWERTOOLS_SERVICE_NAME: 'simulator-run',
        STATE_PARAM: names.state,
        CONFIG_PARAM: names.config,
        CREDENTIALS_PARAM: names.credentials,
        USER_POOL_ID: param(`${authPrefix}/user-pool-id`),
        SIMULATOR_CLIENT_ID: param(`${authPrefix}/simulator-client-id`),
        API_ENDPOINT: param(`${ApiStack.parameterPrefix(envName)}/endpoint`),
      },
    });
    runFn.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadSimulatorParameters',
        actions: ['ssm:GetParameter'],
        resources: [paramArn(names.state), paramArn(names.config), paramArn(names.credentials)],
      }),
    );
    runFn.role.addToPolicy(credentialsKey(['kms:Decrypt']));
    // 只能登入，不能建立或修改帳號（D3）/ Sign in only; cannot create or change accounts.
    runFn.role.addToPolicy(
      new iam.PolicyStatement({ sid: 'SignInOnly', actions: ['cognito-idp:AdminInitiateAuth'], resources: [userPoolArn] }),
    );
    runFn.function.node.addDependency(accounts); // 帳號與開關先就緒 / Accounts and the switch exist first.

    // --- 4) DLQ ---
    const dlq = new sqs.Queue(this, 'Dlq', {
      queueName: `brewline-${envName}-simulator-dlq`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
      removalPolicy: RemovalPolicy.DESTROY,
    });
    Validations.of(dlq).acknowledge({
      id: 'AwsSolutions-SQS3',
      reason: 'This queue is itself the dead-letter queue for the simulator schedule and its async invocations.',
    });
    // 失敗不重試：下一輪會照常執行，重試只會讓同一小時多跑一次 / No retries: the next hourly run follows anyway.
    runFn.function.configureAsyncInvoke({
      retryAttempts: 0,
      maxEventAge: Duration.hours(1),
      onFailure: new destinations.SqsDestination(dlq),
    });

    // --- 5) 排程（D8）/ Schedule ---
    const groupName = SimulatorStack.scheduleGroupName(envName);
    const group = new scheduler.CfnScheduleGroup(this, 'ScheduleGroup', { name: groupName });
    const groupArn = `arn:${this.partition}:scheduler:${this.region}:${this.account}:schedule-group/${groupName}`;
    const schedulerRole = new iam.Role(this, 'SchedulerRole', {
      roleName: `brewline-${envName}-simulator-scheduler`,
      description: 'EventBridge Scheduler: invoke the simulator run function only',
      // aws:SourceArn 必須是**排程群組** ARN（status §10.15 教訓）/ Must be the schedule GROUP ARN (§10.15 lesson).
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com', {
        conditions: { StringEquals: { 'aws:SourceAccount': this.account, 'aws:SourceArn': groupArn } },
      }),
    });
    schedulerRole.addToPolicy(
      new iam.PolicyStatement({ sid: 'InvokeRun', actions: ['lambda:InvokeFunction'], resources: [runFn.function.functionArn] }),
    );
    dlq.grantSendMessages(schedulerRole);
    const schedule = new scheduler.CfnSchedule(this, 'Schedule', {
      name: `brewline-${envName}-simulator-tick`,
      groupName,
      description: 'Simulator tick: hourly 08:05-19:05 Asia/Taipei; the run function checks the SSM state first',
      scheduleExpression: SimulatorStack.SCHEDULE_EXPRESSION,
      scheduleExpressionTimezone: SimulatorStack.SCHEDULE_TIMEZONE,
      flexibleTimeWindow: { mode: 'OFF' },
      state: 'ENABLED',
      target: {
        arn: runFn.function.functionArn,
        roleArn: schedulerRole.roleArn,
        input: JSON.stringify({ source: 'schedule' }),
        retryPolicy: { maximumRetryAttempts: 0 },
        deadLetterConfig: { arn: dlq.queueArn },
      },
    });
    schedule.addDependency(group);

    // --- 6) 告警（D9）/ Alarms ---
    new cloudwatch.Alarm(this, 'RunErrorsAlarm', {
      alarmName: `brewline-${envName}-simulator-run-errors`,
      alarmDescription: 'Simulator run failed an expectation (probe/orders) or crashed (ADR-030 D9).',
      metric: runFn.function.metricErrors({ period: Duration.minutes(5), statistic: 'Sum' }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    new cloudwatch.Alarm(this, 'DlqAlarm', {
      alarmName: `brewline-${envName}-simulator-dlq-not-empty`,
      alarmDescription: 'Simulator schedule or async invocation failed (OPS-A05).',
      metric: dlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5), statistic: 'Maximum' }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    notifyAlarms(this, envName);

    new CfnOutput(this, 'RunFunctionName', { value: runFn.function.functionName });
    new CfnOutput(this, 'ProvisionFunctionName', { value: provisioner.function.functionName });
    new CfnOutput(this, 'ScheduleName', { value: schedule.name! });
    new CfnOutput(this, 'ScheduleGroupName', { value: groupName });
    new CfnOutput(this, 'DlqUrl', { value: dlq.queueUrl });
    new CfnOutput(this, 'AccountCount', { value: accounts.getAttString('Users') });
  }
}

/**
 * CDK Provider framework（與 api stack 相同的作法：自己的角色、log 權限限定 log group、明確豁免 Lambda 標準）。
 * CDK provider framework, same pattern as the api stack.
 */
function createProvider(scope: Stack, pid: string, onEvent: BrewlineFunction): cr.Provider {
  const logGroup = new logs.LogGroup(scope, `${pid}Logs`, { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: RemovalPolicy.DESTROY });
  const role = new iam.Role(scope, `${pid}Role`, {
    assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    description: `CDK provider framework role for ${onEvent.function.node.path}`,
  });
  role.addToPolicy(new iam.PolicyStatement({ actions: ['logs:CreateLogStream', 'logs:PutLogEvents'], resources: [logGroup.logGroupArn] }));
  const provider = new cr.Provider(scope, pid, { onEventHandler: onEvent.function, frameworkOnEventRole: role, logGroup });
  // 框架函數的 runtime 由 CDK 決定 / CDK chooses the framework function's runtime.
  Validations.of(provider).acknowledge(LATEST_RUNTIME_ACK);
  LambdaGuardrailsChecker.exempt(provider, 'CDK provider framework function: runtime/architecture are chosen by CDK; it runs only during deployments.');
  Validations.of(role).acknowledge({
    id: `AwsSolutions-IAM5[Resource::<${scope.getLogicalId(onEvent.function.node.defaultChild as never)}.Arn>:*]`,
    reason: 'grantInvoke adds "<function ARN>:*" so the framework can invoke any version/alias of its own handler only.',
  });
  return provider;
}
