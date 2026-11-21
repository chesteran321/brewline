import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps, Validations } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as destinations from 'aws-cdk-lib/aws-lambda-destinations';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { EnvName, LambdaSettings } from '../config';
import { BrewlineFunction } from '../constructs/brewline-function';
import { DataStack } from './data-stack';
import { LAKE_DATABASES, LakeStack } from './lake-stack';
import { notifyAlarms } from './ops-stack';

export interface ShipmentStackProps extends StackProps {
  readonly envName: EnvName;
  readonly lambda: LambdaSettings;
}

/** 位置檔的入口前綴（E3：模擬器 source=sim、aisstream spike source=ais）/ Entry prefix for position files. */
export const POSITIONS_PREFIX = 'raw/positions/';
export const POSITIONS_TABLE = 'positions';
export const POSITIONS_PROJECTION_START = '2026-11-21';

/**
 * 海運追蹤（P2b-2，docs/06，ADR-032 D1／D8 與補充 E3–E7）：
 * Shipment tracking:
 *
 * | 資源 | 說明 |
 * |---|---|
 * | 偵測函數 `brewline-<env>-shipment-voyage-detector` | 讀 `raw/positions/` 的新物件 → geofence 判斷離港／抵港 → DCSA 運輸事件、ETA、航跡（只寫 DynamoDB） |
 * | 規則（**預設 bus**）`brewline-<env>-shipment-positions` | `aws.s3` `Object Created`，只比對 lake bucket 與 `raw/positions/` 前綴（E5） |
 * | `shipment-dlq`＋告警 | 規則投遞失敗與函數重試 2 次後的失敗都進這裡（D8：每模組一個 DLQ） |
 * | Glue 表 `brewline_raw.positions` | 位置檔的 Athena 表（partition projection：source × dt） |
 *
 * `VesselDeparted`／`VesselArrived` 由 events stack 的 Streams 發布函數產生（E6）→ 這裡沒有 events:PutEvents，
 * bus 資源政策的白名單不用改。
 * Vessel events come from the Streams publisher in the events stack, so nothing here may PutEvents.
 */
export class ShipmentStack extends Stack {
  public static parameterPrefix(envName: EnvName): string {
    return `/brewline/${envName}/shipment`;
  }

  constructor(scope: Construct, id: string, props: ShipmentStackProps) {
    super(scope, id, props);
    const { envName } = props;
    const param = (name: string) => ssm.StringParameter.valueForStringParameter(this, name);
    const dataPrefix = DataStack.parameterPrefix(envName);
    const lakePrefix = LakeStack.parameterPrefix(envName);
    const tableName = param(`${dataPrefix}/table-name`);
    const tableArn = param(`${dataPrefix}/table-arn`);
    const keyArn = param(`${dataPrefix}/kms-key-arn`);
    const bucketName = param(`${lakePrefix}/bucket-name`);
    const bucketArn = param(`${lakePrefix}/bucket-arn`);

    // --- 1) DLQ（D8）---
    const dlq = new sqs.Queue(this, 'Dlq', {
      queueName: `brewline-${envName}-shipment-dlq`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
      removalPolicy: RemovalPolicy.DESTROY,
    });
    Validations.of(dlq).acknowledge({ id: 'AwsSolutions-SQS3', reason: 'This queue is itself the dead-letter queue of the shipment module (ADR-032 D8).' });

    // --- 2) 偵測函數 / Detector ---
    const detector = new BrewlineFunction(this, 'VoyageDetector', {
      envName,
      lambda: props.lambda,
      module: 'shipment',
      name: 'voyage-detector',
      entry: 'shipment/src/handlers/voyage-detector.ts',
      description: 'raw/positions/ objects → geofence departures/arrivals, DCSA transport events, ETA and track (DynamoDB only)',
      // 1：位置檔依序處理，同一艘船不會被兩個檔案同時更新（E5）/ Files in sequence (E5).
      reservedConcurrency: props.lambda.reservedConcurrency.voyageDetector,
      timeout: Duration.seconds(60),
      environment: { TABLE_NAME: tableName, LAKE_BUCKET: bucketName, POWERTOOLS_SERVICE_NAME: 'shipment-voyage-detector' },
    });
    const keys = (k: string[]) => ({ 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': k } });
    const statements = [
      new iam.PolicyStatement({ sid: 'ReadPositions', actions: ['s3:GetObject'], resources: [`${bucketArn}/${POSITIONS_PREFIX}*`] }),
      // Bucket Key：加密內容是 bucket ARN（P2a-2 教訓）/ With a Bucket Key the encryption context is the bucket ARN.
      new iam.PolicyStatement({
        sid: 'DecryptPositionsViaS3',
        actions: ['kms:Decrypt'],
        resources: [keyArn],
        conditions: { StringEquals: { 'kms:ViaService': `s3.${this.region}.amazonaws.com`, 'kms:EncryptionContext:aws:s3:arn': bucketArn } },
      }),
      new iam.PolicyStatement({ sid: 'QueryVesselEdges', actions: ['dynamodb:Query'], resources: [tableArn], conditions: keys(['VESSEL#*']) }),
      new iam.PolicyStatement({
        sid: 'ReadWriteShipment',
        actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem', 'dynamodb:PutItem'],
        resources: [tableArn],
        conditions: keys(['SHIP#*']),
      }),
      // 邊只能改狀態 → 寫不了 LOT#…/META 或其他欄位 / Edges: status only, so a lot's META can never change.
      new iam.PolicyStatement({
        sid: 'UpdateEdgeStatusOnly',
        actions: ['dynamodb:UpdateItem'],
        resources: [tableArn],
        conditions: { ...keys(['LOT#*', 'VESSEL#*']), 'ForAllValues:StringEquals': { 'dynamodb:Attributes': ['pk', 'sk', 'status'] } },
      }),
      new iam.PolicyStatement({
        sid: 'KmsViaDynamoDB',
        actions: ['kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKey'],
        resources: [keyArn],
        conditions: { StringEquals: { 'kms:ViaService': `dynamodb.${this.region}.amazonaws.com` } },
      }),
      new iam.PolicyStatement({ sid: 'DenyScan', effect: iam.Effect.DENY, actions: ['dynamodb:Scan'], resources: [tableArn, `${tableArn}/index/*`] }),
    ];
    for (const s of statements) detector.role.addToPolicy(s);
    Validations.of(detector.role).acknowledge({
      id: `AwsSolutions-IAM5[Resource::<SsmParameterValuebrewline${envName}lakebucketarnC96584B6F00A464EAD1953AFF4B05118Parameter>/${POSITIONS_PREFIX}*]`,
      reason: 'One object per 30-minute window under raw/positions/; keys are dated, so the prefix cannot be narrower.',
    });
    // 非同步重試 2 次 → DLQ（格式錯誤的檔案最後會在這裡）/ Two async retries, then the DLQ (malformed files end here).
    detector.function.configureAsyncInvoke({ retryAttempts: 2, maxEventAge: Duration.hours(6), onFailure: new destinations.SqsDestination(dlq) });

    // --- 3) 規則（預設 bus，E5）/ Rule on the default bus ---
    const rule = new events.Rule(this, 'PositionsRule', {
      ruleName: `brewline-${envName}-shipment-positions`,
      description: 'New raw/positions/ objects in the lake bucket → voyage detector (P2b-2)',
      eventPattern: {
        source: ['aws.s3'],
        detailType: ['Object Created'],
        detail: { bucket: { name: [bucketName] }, object: { key: [{ prefix: POSITIONS_PREFIX }] } },
      },
      targets: [new targets.LambdaFunction(detector.function, { deadLetterQueue: dlq, retryAttempts: 3, maxEventAge: Duration.hours(2) })],
    });

    // --- 4) 告警（每環境 12 個，ADR-030 D9 修訂）/ Alarm ---
    new cloudwatch.Alarm(this, 'DlqAlarm', {
      alarmName: `brewline-${envName}-shipment-dlq-not-empty`,
      alarmDescription: 'Position files the voyage detector could not process, or rule deliveries that failed (ADR-032 D8).',
      metric: dlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5), statistic: 'Maximum' }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    notifyAlarms(this, envName);

    // --- 5) Glue 表 brewline_raw.positions（位置檔的 Athena 表）/ Athena table for position files ---
    const lakeUri = (prefix: string) => `s3://${bucketName}/${prefix}`;
    new glue.CfnTable(this, 'PositionsTable', {
      catalogId: this.account,
      databaseName: LAKE_DATABASES.raw,
      tableInput: {
        name: POSITIONS_TABLE,
        description: 'Vessel positions (JSON Lines, gzip): source=sim (simulator, P2b-2) and source=ais (Dev spike)',
        tableType: 'EXTERNAL_TABLE',
        partitionKeys: [
          { name: 'source', type: 'string' },
          { name: 'dt', type: 'string' },
        ],
        parameters: {
          classification: 'json',
          'projection.enabled': 'true',
          'projection.source.type': 'enum',
          'projection.source.values': 'sim,ais',
          'projection.dt.type': 'date',
          'projection.dt.format': 'yyyy-MM-dd',
          'projection.dt.range': `${POSITIONS_PROJECTION_START},NOW`,
          'projection.dt.interval': '1',
          'projection.dt.interval.unit': 'DAYS',
          'storage.location.template': `${lakeUri(POSITIONS_PREFIX)}source=\${source}/dt=\${dt}/`,
          // 出處欄位（12 §5）/ Provenance properties.
          source_id: 'BREWLINE_POSITIONS',
          synthetic: 'mixed',
          license: 'sim: own synthetic data; ais: not used outside the Dev spike (DS-01)',
          ingested_by: 'simulator-run (sim), ais-sampler (ais)',
        },
        storageDescriptor: {
          location: lakeUri(POSITIONS_PREFIX),
          columns: [
            { name: 'vessel_id', type: 'string' },
            { name: 'vessel_name', type: 'string' },
            { name: 'ts', type: 'string' },
            { name: 'lat', type: 'double' },
            { name: 'lon', type: 'double' },
            { name: 'sog', type: 'double' },
            { name: 'cog', type: 'double' },
            { name: 'nav_status', type: 'int' },
            { name: 'destination', type: 'string' },
            { name: 'synthetic', type: 'boolean' },
          ],
          inputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
          serdeInfo: { serializationLibrary: 'org.openx.data.jsonserde.JsonSerDe', parameters: { 'ignore.malformed.json': 'false' } },
        },
      },
    });

    // --- 6) SSM 參數與輸出 / Parameters and outputs ---
    const prefix = ShipmentStack.parameterPrefix(envName);
    const outputs: Array<[string, string, string, string]> = [
      ['dlq-arn', 'DlqArn', dlq.queueArn, 'Shipment module DLQ ARN (ADR-032 D8)'],
      ['dlq-url', 'DlqUrl', dlq.queueUrl, 'Shipment module DLQ URL'],
      ['detector-function-name', 'DetectorFunctionName', detector.function.functionName, 'Voyage detector function name'],
    ];
    for (const [name, outputId, value, description] of outputs) {
      new ssm.StringParameter(this, `Param${outputId}`, {
        parameterName: `${prefix}/${name}`,
        stringValue: value,
        tier: ssm.ParameterTier.STANDARD,
        description,
      });
      new CfnOutput(this, outputId, { value });
    }
    new CfnOutput(this, 'PositionsRuleName', { value: rule.ruleName });
  }
}
