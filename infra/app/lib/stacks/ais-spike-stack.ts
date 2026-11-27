import { CfnOutput, Duration, Stack, StackProps, Validations } from 'aws-cdk-lib';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as destinations from 'aws-cdk-lib/aws-lambda-destinations';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { AisSpikeSettings, EnvName, LambdaSettings } from '../config';
import { BrewlineFunction } from '../constructs/brewline-function';
import { DataStack } from './data-stack';
import { LAKE_DATABASES, LakeStack } from './lake-stack';
import { ShipmentStack } from './shipment-stack';

export interface AisSpikeStackProps extends StackProps {
  readonly envName: EnvName;
  readonly lambda: LambdaSettings;
  readonly spike: AisSpikeSettings;
}

/** F8：API key 只在這個 SecureString（由 Chester 以 read -s 建立；部署不建立、不覆蓋）/ Created by hand, never by deploy. */
export const AIS_KEY_PARAM = (envName: EnvName) => `/brewline/${envName}/ais/api-key`;
export const AIS_POSITIONS_PREFIX = 'raw/positions/source=ais/';
export const AIS_STATIC_PREFIX = 'raw/ais-static/';
export const AIS_STATIC_TABLE = 'ais_static';
/** F3：每 30 分 :10／:40（台北），避開模擬器 :05、:20、:50 / Clear of the simulator's minutes. */
export const AIS_SCHEDULE_EXPRESSION = 'cron(10,40 * * * ? *)';
export const AIS_SCHEDULE_TIMEZONE = 'Asia/Taipei';

/**
 * aisstream spike（P2b-spike，**只在 Dev**，ADR-032 D2／D9，spike 規格 F1–F12）。
 * Dev-only aisstream spike.
 *
 * | 資源 | 說明 |
 * |---|---|
 * | 取樣函數 `brewline-dev-ais-spike-sampler` | 256 MB、逾時 150 秒、保留併發 1；連線 120 秒 → raw/positions/source=ais/＋raw/ais-static/ |
 * | 排程群組 `brewline-dev-ais-spike` | 每 30 分 :10／:40，StartDate／EndDate 7 天（F2，到期自動停止）；不重試、DLQ＝shipment-dlq |
 * | Glue 表 `brewline_raw.ais_static` | 船名、船種、目的地（F12；位置沿用 `positions` 表的 source=ais 分區）|
 *
 * - **不新增告警**（F7）：失敗 → 非同步重試 0 → 既有的 `shipment-dlq`（告警已存在）。
 * - API key 只在 SSM SecureString；函數只能讀這一個參數，KMS 只經 SSM 且加密內容＝參數 ARN（F8）。
 * - 沒有 DynamoDB、沒有 S3 Get／Delete、只能寫兩個前綴。
 * - spike 結束後整個 stack 以一個 PR 刪除；資料靠 Dev raw/ 的 30 天生命週期刪除（D2）。
 */
export class AisSpikeStack extends Stack {
  public static scheduleGroupName(envName: EnvName): string {
    return `brewline-${envName}-ais-spike`;
  }

  constructor(scope: Construct, id: string, props: AisSpikeStackProps) {
    super(scope, id, props);
    const { envName, spike } = props;
    if (envName !== 'dev') throw new Error('The aisstream spike is Dev-only (ADR-032 D2, F1)');
    const start = Date.parse(spike.startDate);
    const end = Date.parse(spike.endDate);
    // Scheduler 只接受 yyyy-MM-ddTHH:mm:ss.SSSZ（毫秒必填；沒有毫秒 → CREATE_FAILED）/ Milliseconds are required.
    const SCHEDULER_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    if (Number.isNaN(start) || Number.isNaN(end) || !SCHEDULER_DATE.test(spike.startDate) || !SCHEDULER_DATE.test(spike.endDate)) {
      throw new Error('aisSpike startDate/endDate must be UTC in the Scheduler format yyyy-MM-ddTHH:mm:ss.SSSZ');
    }
    if (end <= start || end - start > 7 * 86_400_000) throw new Error('aisSpike must run for at most 7 days (ADR-032 D2)');
    if (spike.collectSeconds < 30 || spike.collectSeconds > 120) throw new Error('aisSpike collectSeconds must be 30–120 (D9)');

    const param = (name: string) => ssm.StringParameter.valueForStringParameter(this, name);
    const keyArn = param(`${DataStack.parameterPrefix(envName)}/kms-key-arn`);
    const lakePrefix = LakeStack.parameterPrefix(envName);
    const bucketName = param(`${lakePrefix}/bucket-name`);
    const bucketArn = param(`${lakePrefix}/bucket-arn`);
    const dlq = sqs.Queue.fromQueueArn(this, 'ShipmentDlq', param(`${ShipmentStack.parameterPrefix(envName)}/dlq-arn`));
    const keyParam = AIS_KEY_PARAM(envName);
    const keyParamArn = `arn:${this.partition}:ssm:${this.region}:${this.account}:parameter${keyParam}`;

    // --- 1) 取樣函數 / Sampler ---
    const sampler = new BrewlineFunction(this, 'Sampler', {
      envName,
      lambda: props.lambda,
      module: 'ais-spike',
      name: 'sampler',
      entry: 'shipment/src/handlers/ais-sampler.ts',
      description: 'Dev-only aisstream spike: 120 s WebSocket sample of 10 port boxes -> raw/positions/source=ais/ and raw/ais-static/',
      reservedConcurrency: 1, // 一次只開一個連線（帳號上限 3）/ One connection at a time (account limit 3).
      memorySize: 256, // D9
      timeout: Duration.seconds(150), // 連線 120 秒＋讀參數、寫檔 / 120 s of streaming plus setup and writes.
      // 只放參數名稱，不放 key（F8）/ The parameter NAME only, never the key.
      environment: {
        LAKE_BUCKET: bucketName,
        AIS_KEY_PARAM: keyParam,
        COLLECT_SECONDS: String(spike.collectSeconds),
        POWERTOOLS_SERVICE_NAME: 'ais-spike-sampler',
      },
    });
    const statements = [
      new iam.PolicyStatement({ sid: 'ReadApiKeyParameter', actions: ['ssm:GetParameter'], resources: [keyParamArn] }),
      // SecureString 以 CMK 加密：加密內容是 PARAMETER_ARN → 只解得開這一個參數 / Pinned to this one parameter.
      new iam.PolicyStatement({
        sid: 'DecryptApiKeyViaSsm',
        actions: ['kms:Decrypt'],
        resources: [keyArn],
        conditions: { StringEquals: { 'kms:ViaService': `ssm.${this.region}.amazonaws.com`, 'kms:EncryptionContext:PARAMETER_ARN': keyParamArn } },
      }),
      new iam.PolicyStatement({
        sid: 'WriteAisObjects',
        actions: ['s3:PutObject'],
        resources: [`${bucketArn}/${AIS_POSITIONS_PREFIX}*`, `${bucketArn}/${AIS_STATIC_PREFIX}*`],
      }),
      // Bucket Key：加密內容是 bucket ARN（P2a-2 教訓）/ With a Bucket Key the encryption context is the bucket ARN.
      new iam.PolicyStatement({
        sid: 'EncryptAisObjectsViaS3',
        actions: ['kms:GenerateDataKey'],
        resources: [keyArn],
        conditions: { StringEquals: { 'kms:ViaService': `s3.${this.region}.amazonaws.com`, 'kms:EncryptionContext:aws:s3:arn': bucketArn } },
      }),
    ];
    for (const s of statements) sampler.role.addToPolicy(s);
    const lakeArnToken = `<SsmParameterValuebrewline${envName}lakebucketarnC96584B6F00A464EAD1953AFF4B05118Parameter>`;
    Validations.of(sampler.role).acknowledge({
      id: `AwsSolutions-IAM5[Resource::${lakeArnToken}/${AIS_POSITIONS_PREFIX}*]`,
      reason: 'One object per 30-minute run under raw/positions/source=ais/; keys are dated, so the prefix cannot be narrower.',
    });
    Validations.of(sampler.role).acknowledge({
      id: `AwsSolutions-IAM5[Resource::${lakeArnToken}/${AIS_STATIC_PREFIX}*]`,
      reason: 'One object per 30-minute run under raw/ais-static/; keys are dated, so the prefix cannot be narrower.',
    });
    // F7：不重試（下一輪 30 分鐘後照常跑）→ 失敗直接進 shipment-dlq（既有告警）/ No retries; failures go to shipment-dlq.
    sampler.function.configureAsyncInvoke({ retryAttempts: 0, maxEventAge: Duration.hours(1), onFailure: new destinations.SqsDestination(dlq) });

    // --- 2) 排程（F2、F3）/ Schedule ---
    const groupName = AisSpikeStack.scheduleGroupName(envName);
    const group = new scheduler.CfnScheduleGroup(this, 'ScheduleGroup', { name: groupName });
    const groupArn = `arn:${this.partition}:scheduler:${this.region}:${this.account}:schedule-group/${groupName}`;
    const schedulerRole = new iam.Role(this, 'SchedulerRole', {
      roleName: `brewline-${envName}-ais-spike-scheduler`,
      description: 'EventBridge Scheduler: invoke the aisstream spike sampler only',
      // aws:SourceArn 必須是排程「群組」ARN（status §10.15 教訓）/ Must be the schedule GROUP ARN.
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com', {
        conditions: { StringEquals: { 'aws:SourceAccount': this.account, 'aws:SourceArn': groupArn } },
      }),
    });
    schedulerRole.addToPolicy(new iam.PolicyStatement({ sid: 'InvokeSampler', actions: ['lambda:InvokeFunction'], resources: [sampler.function.functionArn] }));
    dlq.grantSendMessages(schedulerRole);
    const schedule = new scheduler.CfnSchedule(this, 'Schedule', {
      name: `brewline-${envName}-ais-spike-sampler`,
      groupName,
      description: 'aisstream spike: every 30 minutes (:10/:40 Asia/Taipei) between StartDate and EndDate (7 days, ADR-032 D2)',
      scheduleExpression: AIS_SCHEDULE_EXPRESSION,
      scheduleExpressionTimezone: AIS_SCHEDULE_TIMEZONE,
      startDate: spike.startDate,
      endDate: spike.endDate,
      flexibleTimeWindow: { mode: 'OFF' },
      state: 'ENABLED',
      target: {
        arn: sampler.function.functionArn,
        roleArn: schedulerRole.roleArn,
        input: JSON.stringify({ source: 'schedule' }),
        retryPolicy: { maximumRetryAttempts: 0 },
        deadLetterConfig: { arn: dlq.queueArn },
      },
    });
    schedule.addDependency(group);

    // --- 3) Glue 表 brewline_raw.ais_static（F12）/ Static-data table ---
    const lakeUri = (prefix: string) => `s3://${bucketName}/${prefix}`;
    const projectionStart = spike.startDate.slice(0, 10);
    new glue.CfnTable(this, 'AisStaticTable', {
      catalogId: this.account,
      databaseName: LAKE_DATABASES.raw,
      tableInput: {
        name: AIS_STATIC_TABLE,
        description: 'aisstream ShipStaticData (name, ship type, destination) from the Dev-only spike; JSON Lines, gzip',
        tableType: 'EXTERNAL_TABLE',
        partitionKeys: [{ name: 'dt', type: 'string' }],
        parameters: {
          classification: 'json',
          'projection.enabled': 'true',
          'projection.dt.type': 'date',
          'projection.dt.format': 'yyyy-MM-dd',
          'projection.dt.range': `${projectionStart},NOW`,
          'projection.dt.interval': '1',
          'projection.dt.interval.unit': 'DAYS',
          'storage.location.template': `${lakeUri(AIS_STATIC_PREFIX)}dt=\${dt}/`,
          source_id: 'AISSTREAM_SPIKE',
          synthetic: 'false',
          license: 'aisstream.io: no formal terms and no SLA; Dev-only, internal, deleted after 30 days (ADR-032 D2, DS-01)',
          ingested_by: 'ais-spike-sampler',
        },
        storageDescriptor: {
          location: lakeUri(AIS_STATIC_PREFIX),
          columns: [
            { name: 'source', type: 'string' },
            { name: 'vessel_id', type: 'string' },
            { name: 'vessel_name', type: 'string' },
            { name: 'ship_type', type: 'int' },
            { name: 'destination', type: 'string' },
            { name: 'ts', type: 'string' },
          ],
          inputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
          serdeInfo: { serializationLibrary: 'org.openx.data.jsonserde.JsonSerDe', parameters: { 'ignore.malformed.json': 'false' } },
        },
      },
    });

    new CfnOutput(this, 'SamplerFunctionName', { value: sampler.function.functionName });
    new CfnOutput(this, 'ScheduleName', { value: schedule.name! });
    new CfnOutput(this, 'ScheduleGroupName', { value: groupName });
    new CfnOutput(this, 'ApiKeyParameterName', { value: keyParam });
  }
}
