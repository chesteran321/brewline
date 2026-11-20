import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps, Tags, Validations } from 'aws-cdk-lib';
import * as athena from 'aws-cdk-lib/aws-athena';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { DATA_CLASS_TAG, EnvName, LakeSettings } from '../config';
import { ORDER_EVENTS_PREFIX, OrderEventsFirehose } from '../constructs/order-events-firehose';
import { DataStack } from './data-stack';
import { EventsStack } from './events-stack';
import { notifyAlarms } from './ops-stack';

export interface LakeStackProps extends StackProps {
  readonly envName: EnvName;
  readonly lake: LakeSettings;
}

/** Glue 資料庫（帳號已分離，名稱不加 env）/ Glue databases (accounts are separate, so no env in the name). */
export const LAKE_DATABASES = {
  raw: 'brewline_raw',
  curated: 'brewline_curated',
  analytics: 'brewline_analytics',
} as const;

/** Dev 專用 smoke 表（P2a 手動測試、之後新鮮度檢查的範例）/ Dev-only smoke table. */
export const SMOKE_TABLE = 'lake_smoke';
export const SMOKE_PREFIX = 'raw/_smoke/';

/** 訂單事件表（P2a-2，ADR-032 D6；Dev、Prod 都建，E5）/ Order events table in both envs. */
export const ORDER_EVENTS_TABLE = 'order_events';
/** 訂單事件 projection 起點：P2a-2 開始寫入的日期 / Projection start: the day ingestion began. */
export const ORDER_EVENTS_PROJECTION_START = '2026-11-20';

/** Athena 引擎版本（D7）/ Athena engine version. */
export const ATHENA_ENGINE = 'Athena engine version 3';

/**
 * SSM 參數（`/brewline/<env>/lake/<name>`）與同名 CfnOutput（CI `outputs.json`）的對照。
 * SSM parameter name → CfnOutput id. Other stacks read SSM (no exports, ADR-018).
 */
export const LAKE_PARAMETERS = {
  'bucket-name': 'BucketName',
  'bucket-arn': 'BucketArn',
  'results-bucket-name': 'ResultsBucketName',
  'workgroup-name': 'WorkgroupName',
  'db-raw': 'DbRaw',
  'db-curated': 'DbCurated',
  'db-analytics': 'DbAnalytics',
  'dlq-arn': 'DlqArn',
  'dlq-url': 'DlqUrl',
  'order-events-stream-name': 'OrderEventsStreamName',
  'order-events-stream-arn': 'OrderEventsStreamArn',
} as const;

/** 前綴慣例（S3 沒有資料夾，不建立物件）/ Prefix convention; S3 has no folders, so nothing is created. */
export const LAKE_PREFIX_CONVENTION =
  'raw/<source>/dt=YYYY-MM-DD/, curated/<table>/..., analytics/<table>/..., analytics/serving/, ' +
  'quarantine/<source>/dt=.../, edi/{inbound,archive,quarantine}/, raw/events/ + raw/events-errors/ (Firehose), raw/_smoke/ (Dev only)';

/**
 * 資料湖基礎（P2a，ADR-032 草案，P2 設計 D3–D8）。
 * Data lake foundation: lake bucket + Athena results bucket (SSE-KMS with the data CMK and Bucket Key),
 * three Glue databases, the analytics workgroup (enforced settings, per-query scan cutoff), the lake DLQ + one alarm.
 *
 * - **沒有任何 Lambda**：Dev 的 bucket 也不用 `autoDeleteObjects`（會多一個 custom resource 函數）→ Dev 刪 stack 前手動清空。
 *   No Lambda at all: no autoDeleteObjects (it adds a custom-resource function); empty the Dev buckets by hand before deleting.
 * - Glue 目錄不加密（`DataCatalogEncryptionSettings` 是帳號層級單例、中繼資料不含敏感資料，ADR-032）。
 *   The Glue Data Catalog is not encrypted (account-wide singleton; metadata holds nothing sensitive).
 */
export class LakeStack extends Stack {
  public static parameterPrefix(envName: EnvName): string {
    return `/brewline/${envName}/lake`;
  }

  constructor(scope: Construct, id: string, props: LakeStackProps) {
    super(scope, id, props);
    const { envName, lake } = props;
    const removalPolicy = lake.retainOnDelete ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    const keyArn = ssm.StringParameter.valueForStringParameter(this, `${DataStack.parameterPrefix(envName)}/kms-key-arn`);
    const dataKey = kms.Key.fromKeyArn(this, 'DataKey', keyArn);

    // 兩個 bucket 共用的設定（D5、09 §3.2）/ Settings shared by both buckets.
    const common: s3.BucketProps = {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: dataKey,
      // Bucket Key：S3 以 bucket 層級的資料金鑰加密物件 → KMS 請求數接近 0 / KMS requests drop to near zero.
      bucketKeyEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      // RCP 也強制 TLS；bucket policy 再寫一次是 cdk-nag S10 的要求，也讓 bucket 單獨看也是安全的。
      // The RCP enforces TLS too; the bucket policy repeats it for cdk-nag S10 and so the bucket is safe on its own.
      enforceSSL: true,
      minimumTLSVersion: 1.2,
      removalPolicy,
    };

    // --- 1) Lake bucket ---
    const rawTransitions: s3.Transition[] = lake.rawGlacierIrAfterDays
      ? [{ storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL, transitionAfter: Duration.days(lake.rawGlacierIrAfterDays) }]
      : [];
    const bucket = new s3.Bucket(this, 'LakeBucket', {
      ...common,
      bucketName: `brewline-${envName}-lake-${this.account}`,
      versioned: true,
      lifecycleRules: [
        // docs/12 §3、設計草稿 §4.2 / Retention per prefix.
        { id: 'raw', prefix: 'raw/', expiration: Duration.days(lake.rawExpirationDays), transitions: rawTransitions },
        { id: 'curated', prefix: 'curated/', expiration: Duration.days(730) },
        { id: 'analytics', prefix: 'analytics/', expiration: Duration.days(730) },
        { id: 'quarantine', prefix: 'quarantine/', expiration: Duration.days(90) },
        // 所有前綴：舊版本 30 天刪除、未完成的 multipart 7 天中止 / All prefixes.
        { id: 'noncurrent-and-multipart', noncurrentVersionExpiration: Duration.days(30), abortIncompleteMultipartUploadAfter: Duration.days(7) },
      ],
    });
    // 預設加密會套用 CMK，但呼叫端可以自己指定別的金鑰（例如 aws/s3）或 SSE-S3 → 擋掉。
    // 只在標頭「存在」時判斷（Null = false），沒帶標頭的上傳交給預設加密（CMK）。
    // Default encryption applies the CMK, but a caller may name another key (e.g. aws/s3) or SSE-S3: deny those.
    // Only when the header is present (Null = false); uploads without it get the default (the CMK).
    bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'DenyWrongKmsKey',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['s3:PutObject'],
        resources: [bucket.arnForObjects('*')],
        conditions: {
          Null: { 's3:x-amz-server-side-encryption-aws-kms-key-id': 'false' },
          StringNotEquals: { 's3:x-amz-server-side-encryption-aws-kms-key-id': keyArn },
        },
      }),
    );
    bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'DenyNonKmsSse',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['s3:PutObject'],
        resources: [bucket.arnForObjects('*')],
        conditions: {
          Null: { 's3:x-amz-server-side-encryption': 'false' },
          StringNotEquals: { 's3:x-amz-server-side-encryption': 'aws:kms' },
        },
      }),
    );
    Tags.of(bucket).add(DATA_CLASS_TAG, 'internal');
    Validations.of(bucket).acknowledge({
      id: 'AwsSolutions-S1',
      reason: 'The lake holds only public-source and simulated data; writers are a few IAM roles and management events are in the org CloudTrail. Server access logs would cost more than the bucket itself (same reasoning as the trace bucket).',
    });

    // --- 2) Athena 結果 bucket（7 天即刪，不開版本控制）/ Athena results (deleted after 7 days, unversioned) ---
    const results = new s3.Bucket(this, 'ResultsBucket', {
      ...common,
      bucketName: `brewline-${envName}-athena-results-${this.account}`,
      versioned: false,
      lifecycleRules: [{ id: 'results', expiration: Duration.days(7), abortIncompleteMultipartUploadAfter: Duration.days(1) }],
    });
    Tags.of(results).add(DATA_CLASS_TAG, 'internal');
    Validations.of(results).acknowledge({
      id: 'AwsSolutions-S1',
      reason: 'Athena query results only, expired after 7 days; queries are recorded by Athena query history and CloudTrail.',
    });

    // --- 3) Glue databases（D4：CDK 定義、不用 crawler、不開 Lake Formation）---
    // 台北 describe-type 為 NON_PROVISIONABLE，但 2026-11-20 測試 stack 實際 CREATE_COMPLETE（P2 設計草稿 §3.2）。
    // describe-type says NON_PROVISIONABLE in Taipei, but a probe stack created both types (design draft §3.2).
    const lakeUri = (prefix: string) => `s3://${bucket.bucketName}/${prefix}`;
    const dbSpecs = [
      { key: 'raw', name: LAKE_DATABASES.raw, prefix: 'raw/', what: 'Raw source data as ingested (JSON, gzip), partitioned by dt' },
      { key: 'curated', name: LAKE_DATABASES.curated, prefix: 'curated/', what: 'Validated, typed tables (Parquet) produced by Athena UNLOAD' },
      { key: 'analytics', name: LAKE_DATABASES.analytics, prefix: 'analytics/', what: 'Aggregates and dashboard serving data' },
    ] as const;
    const databases = Object.fromEntries(
      dbSpecs.map((d) => {
        const db = new glue.CfnDatabase(this, `GlueDb${d.key[0]!.toUpperCase()}${d.key.slice(1)}`, {
          catalogId: this.account,
          databaseInput: { name: d.name, description: `BrewLine ${envName}: ${d.what} (docs/12, ADR-032)`, locationUri: lakeUri(d.prefix) },
        });
        return [d.key, db];
      }),
    ) as Record<(typeof dbSpecs)[number]['key'], glue.CfnDatabase>;

    // --- 4) Dev 專用 smoke 表（partition projection，不需要分區物件）/ Dev-only smoke table ---
    if (lake.smokeTable) {
      const smoke = new glue.CfnTable(this, 'SmokeTable', {
        catalogId: this.account,
        databaseName: LAKE_DATABASES.raw,
        tableInput: {
          name: SMOKE_TABLE,
          description: 'P2a smoke table: manual positive/negative tests (Dev only)',
          tableType: 'EXTERNAL_TABLE',
          partitionKeys: [{ name: 'dt', type: 'string' }],
          parameters: {
            classification: 'json',
            'projection.enabled': 'true',
            'projection.dt.type': 'date',
            'projection.dt.format': 'yyyy-MM-dd',
            'projection.dt.range': '2026-11-01,NOW',
            'projection.dt.interval': '1',
            'projection.dt.interval.unit': 'DAYS',
            'storage.location.template': `${lakeUri(SMOKE_PREFIX)}dt=\${dt}/`,
            // 出處欄位（12 §5）/ Provenance properties.
            source_id: 'SMOKE',
            synthetic: 'true',
            license: 'n/a',
            ingested_by: 'manual',
          },
          storageDescriptor: {
            location: lakeUri(SMOKE_PREFIX),
            columns: [
              { name: 'id', type: 'string' },
              { name: 'value', type: 'int' },
              { name: 'note', type: 'string' },
            ],
            inputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
            outputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
            serdeInfo: { serializationLibrary: 'org.openx.data.jsonserde.JsonSerDe' },
          },
        },
      });
      smoke.addResourceDependency(databases.raw);
    }

    // --- 5) Athena workgroup（D7）---
    // `primary` 無法刪除 → 由 IAM 只允許這個 workgroup（Developer 許可集，規格 §4）。
    // `primary` cannot be deleted, so IAM allows only this workgroup.
    const workgroup = new athena.CfnWorkGroup(this, 'Workgroup', {
      name: `brewline-${envName}-analytics`,
      description: `BrewLine ${envName} analytics (P2a): enforced results location and SSE-KMS, per-query scan cutoff (COST-006)`,
      state: 'ENABLED',
      recursiveDeleteOption: !lake.retainOnDelete,
      workGroupConfiguration: {
        enforceWorkGroupConfiguration: true,
        bytesScannedCutoffPerQuery: lake.bytesScannedCutoffPerQuery,
        engineVersion: { selectedEngineVersion: ATHENA_ENGINE },
        // AWS 提供的指標，不另收費；不建用量告警（D8）/ Free metrics; no usage alarm.
        publishCloudWatchMetricsEnabled: true,
        resultConfiguration: {
          outputLocation: `s3://${results.bucketName}/athena/`,
          encryptionConfiguration: { encryptionOption: 'SSE_KMS', kmsKey: keyArn },
          expectedBucketOwner: this.account,
        },
      },
    });
    workgroup.node.addDependency(results);

    // --- 6) lake-dlq＋告警（D8：每模組一個 DLQ）---
    // P2a 沒有生產者；P2a-2 的 Firehose 規則、curate 工作流的 Catch 會用它 → 告警與驗證先穩定下來。
    // No producer yet; P2a-2 (Firehose rule) and the curate workflow will use it.
    const dlq = new sqs.Queue(this, 'LakeDlq', {
      queueName: `brewline-${envName}-lake-dlq`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
      removalPolicy: RemovalPolicy.DESTROY,
    });
    Validations.of(dlq).acknowledge({ id: 'AwsSolutions-SQS3', reason: 'This queue is itself the data-lake module dead-letter queue (P2 design D8).' });

    new cloudwatch.Alarm(this, 'LakeDlqAlarm', {
      alarmName: `brewline-${envName}-lake-dlq-not-empty`,
      alarmDescription: 'Data-lake events or workflow failures that ended in the lake DLQ (P2 design D8).',
      metric: dlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5), statistic: 'Maximum' }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    notifyAlarms(this, envName);

    // --- 6b) 訂單事件 → Firehose → raw/events/（P2a-2，ADR-032 D6）。不新增告警（E4）---
    // Order events → Firehose → raw/events/. No new alarm: rule failures go to the lake DLQ.
    const orderEvents = new OrderEventsFirehose(this, 'OrderEvents', {
      envName,
      bucket,
      keyArn,
      busName: ssm.StringParameter.valueForStringParameter(this, `${EventsStack.parameterPrefix(envName)}/bus-name`),
      deadLetterQueue: dlq,
      logRetention: lake.orderEventsLogRetentionDays as logs.RetentionDays,
    });

    const eventsTable = new glue.CfnTable(this, 'OrderEventsTable', {
      catalogId: this.account,
      databaseName: LAKE_DATABASES.raw,
      tableInput: {
        name: ORDER_EVENTS_TABLE,
        description: 'Order domain events (OrderCreated, OrderStatusChanged) delivered by Firehose; JSON Lines, gzip (P2a-2)',
        tableType: 'EXTERNAL_TABLE',
        partitionKeys: [{ name: 'dt', type: 'string' }],
        parameters: {
          classification: 'json',
          'projection.enabled': 'true',
          'projection.dt.type': 'date',
          'projection.dt.format': 'yyyy-MM-dd',
          'projection.dt.range': `${ORDER_EVENTS_PROJECTION_START},NOW`,
          'projection.dt.interval': '1',
          'projection.dt.interval.unit': 'DAYS',
          'storage.location.template': `${lakeUri(ORDER_EVENTS_PREFIX)}dt=\${dt}/`,
          // 出處欄位（12 §5）；同一張表有模擬與非模擬事件 → 用 detail.synthetic 過濾 / Mixed: filter on detail.synthetic.
          source_id: 'BREWLINE_ORDER_EVENTS',
          synthetic: 'mixed',
          license: 'n/a (own data)',
          ingested_by: 'firehose',
        },
        storageDescriptor: {
          location: lakeUri(ORDER_EVENTS_PREFIX),
          columns: [
            { name: 'id', type: 'string' },
            { name: 'detail_type', type: 'string' },
            { name: 'source', type: 'string' },
            { name: 'time', type: 'string' },
            {
              name: 'detail',
              type:
                'struct<event_id:string,occurred_at:string,tenant_id:string,order_id:string,status:string,previous_status:string,' +
                'payment_status:string,total:double,currency:string,synthetic:boolean,items:array<struct<product_id:string,qty_kg:double>>>',
            },
          ],
          inputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
          // 格式錯誤要讓查詢失敗，不要默默略過 / Malformed JSON must fail the query, not be skipped.
          serdeInfo: { serializationLibrary: 'org.openx.data.jsonserde.JsonSerDe', parameters: { 'ignore.malformed.json': 'false' } },
        },
      },
    });
    eventsTable.addResourceDependency(databases.raw);

    // --- 7) SSM 參數與輸出（其他 stack 讀 SSM，ADR-018）/ Parameters and outputs ---
    const values: Record<keyof typeof LAKE_PARAMETERS, { value: string; description: string }> = {
      'bucket-name': { value: bucket.bucketName, description: `BrewLine ${envName} data lake bucket. Prefixes: ${LAKE_PREFIX_CONVENTION}` },
      'bucket-arn': { value: bucket.bucketArn, description: 'Data lake bucket ARN' },
      'results-bucket-name': { value: results.bucketName, description: 'Athena query results bucket (7-day expiry)' },
      'workgroup-name': { value: workgroup.name, description: 'Athena workgroup (the only one IAM allows)' },
      'db-raw': { value: databases.raw.ref, description: 'Glue database for raw data' },
      'db-curated': { value: databases.curated.ref, description: 'Glue database for curated data' },
      'db-analytics': { value: databases.analytics.ref, description: 'Glue database for analytics data' },
      'dlq-arn': { value: dlq.queueArn, description: 'Data lake module DLQ ARN (P2 design D8)' },
      'dlq-url': { value: dlq.queueUrl, description: 'Data lake module DLQ URL' },
      'order-events-stream-name': { value: orderEvents.streamName, description: 'Order events Firehose stream (P2a-2)' },
      'order-events-stream-arn': { value: orderEvents.streamArn, description: 'Order events Firehose stream ARN' },
    };
    const prefix = LakeStack.parameterPrefix(envName);
    for (const [name, outputId] of Object.entries(LAKE_PARAMETERS) as Array<[keyof typeof LAKE_PARAMETERS, string]>) {
      const { value, description } = values[name];
      new ssm.StringParameter(this, `${outputId}Param`, {
        parameterName: `${prefix}/${name}`,
        stringValue: value,
        tier: ssm.ParameterTier.STANDARD,
        description,
      });
      new CfnOutput(this, outputId, { value });
    }
  }
}
