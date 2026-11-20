import { Aws, RemovalPolicy, Stack, Validations } from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as firehose from 'aws-cdk-lib/aws-kinesisfirehose';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { EnvName } from '../config';

/** 進資料湖的訂單事件（ADR-032 D6、P2a-2 E2）/ Order events that go to the lake. */
export const ORDER_EVENT_SOURCE = 'brewline.ordering';
export const ORDER_EVENT_TYPES = ['OrderCreated', 'OrderStatusChanged'] as const;

/** Firehose 落地前綴（UTC 日期，與 partition projection 的 NOW 一致）/ Delivery prefixes (UTC date). */
export const ORDER_EVENTS_PREFIX = 'raw/events/';
export const ORDER_EVENTS_S3_PREFIX = `${ORDER_EVENTS_PREFIX}dt=!{timestamp:yyyy-MM-dd}/`;
export const ORDER_EVENTS_ERROR_PREFIX = 'raw/events-errors/';
export const ORDER_EVENTS_S3_ERROR_PREFIX = `${ORDER_EVENTS_ERROR_PREFIX}!{firehose:error-output-type}/dt=!{timestamp:yyyy-MM-dd}/`;
export const ORDER_EVENTS_LOG_STREAM = 'DestinationDelivery';

/**
 * Input transformer（P2a-2 E1-A）：Firehose 不會在記錄之間加換行 → 由規則輸出「一行一筆」的 JSON。
 * 依 AWS 文件，變數可以當 JSON 值使用；`<aws.events.event.json>` 只能當欄位值、不能嵌在字串裡，
 * 所以明確列出欄位（也把 `detail-type` 改成 Athena 可用的 `detail_type`），最後加 `\n`。
 * The rule emits one JSON object per line: Firehose adds no delimiter between records.
 */
export const ORDER_EVENTS_INPUT_PATHS = {
  id: '$.id',
  detail_type: '$.detail-type',
  source: '$.source',
  time: '$.time',
  detail: '$.detail',
} as const;
export const ORDER_EVENTS_INPUT_TEMPLATE =
  '{"id":<id>,"detail_type":<detail_type>,"source":<source>,"time":<time>,"detail":<detail>}\n';

export interface OrderEventsFirehoseProps {
  readonly envName: EnvName;
  readonly bucket: s3.IBucket;
  /** 資料層 CMK ARN（SSM token）/ Data CMK ARN. */
  readonly keyArn: string;
  /** bus 名稱（SSM token）/ Bus name. */
  readonly busName: string;
  readonly deadLetterQueue: sqs.IQueue;
  readonly logRetention: logs.RetentionDays;
}

/**
 * 訂單事件 → Firehose → lake `raw/events/`（ADR-032 D6，P2a-2）。沒有 Lambda、沒有 Firehose 資料處理。
 * Order events → Firehose → lake raw/events/. No Lambda, no Firehose processing.
 *
 * 用 L1：L2 的 S3 目的地會給角色整個 bucket 的讀寫；這裡要限定兩個前綴、KMS 條件也要寫清楚。
 * L1 on purpose: the L2 S3 destination grants read/write on the whole bucket.
 */
export class OrderEventsFirehose extends Construct {
  public readonly stream: firehose.CfnDeliveryStream;
  public readonly streamName: string;
  public readonly streamArn: string;
  public readonly ruleName: string;
  public readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: OrderEventsFirehoseProps) {
    super(scope, id);
    const { envName, bucket, keyArn, busName, deadLetterQueue } = props;
    const stack = Stack.of(this);
    this.streamName = `brewline-${envName}-order-events`;
    this.streamArn = stack.formatArn({ service: 'firehose', resource: 'deliverystream', resourceName: this.streamName });
    this.ruleName = `brewline-${envName}-lake-order-events`;
    // 規則 ARN 以名稱組出，避免「規則 ↔ 角色信任政策」循環依賴 / Built from names to avoid a rule ↔ role cycle.
    const ruleArn = `arn:${Aws.PARTITION}:events:${Aws.REGION}:${Aws.ACCOUNT_ID}:rule/${busName}/${this.ruleName}`;

    // --- 錯誤日誌（只有失敗時才有內容）/ Error logging ---
    const logGroup = new logs.LogGroup(this, 'Logs', {
      logGroupName: `/aws/kinesisfirehose/${this.streamName}`,
      retention: props.logRetention,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const logStream = new logs.LogStream(this, 'DeliveryLogStream', {
      logGroup,
      logStreamName: ORDER_EVENTS_LOG_STREAM,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // --- Firehose 角色：只能寫兩個前綴、只能經由 S3 使用 CMK / Write two prefixes only; CMK only via S3 ---
    this.role = new iam.Role(this, 'Role', {
      roleName: `brewline-${envName}-order-events-firehose`,
      description: 'Firehose delivery role for order events into the data lake (P2a-2): two prefixes only, CMK via S3 only',
      assumedBy: new iam.ServicePrincipal('firehose.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': Aws.ACCOUNT_ID },
          ArnEquals: { 'aws:SourceArn': this.streamArn },
        },
      }),
    });
    const policy = new iam.Policy(this, 'RolePolicy', {
      statements: [
        new iam.PolicyStatement({
          sid: 'WriteOrderEventPrefixes',
          actions: ['s3:PutObject', 's3:AbortMultipartUpload'],
          resources: [bucket.arnForObjects(`${ORDER_EVENTS_PREFIX}*`), bucket.arnForObjects(`${ORDER_EVENTS_ERROR_PREFIX}*`)],
        }),
        new iam.PolicyStatement({
          sid: 'LakeBucketMetadata',
          actions: ['s3:GetBucketLocation', 's3:ListBucket', 's3:ListBucketMultipartUploads'],
          resources: [bucket.bucketArn],
        }),
        // 開了 Bucket Key：加密內容（encryption context）是 **bucket ARN**，不是物件 ARN。
        // With S3 Bucket Key the encryption context is the bucket ARN, not the object ARN.
        new iam.PolicyStatement({
          sid: 'DataKeyViaS3ForLakeBucket',
          actions: ['kms:GenerateDataKey', 'kms:Decrypt'],
          resources: [keyArn],
          conditions: {
            StringEquals: {
              'kms:ViaService': `s3.${Aws.REGION}.amazonaws.com`,
              'kms:EncryptionContext:aws:s3:arn': bucket.bucketArn,
            },
          },
        }),
        new iam.PolicyStatement({
          sid: 'DeliveryErrorLogs',
          actions: ['logs:PutLogEvents'],
          resources: [`arn:${Aws.PARTITION}:logs:${Aws.REGION}:${Aws.ACCOUNT_ID}:log-group:/aws/kinesisfirehose/${this.streamName}:log-stream:${ORDER_EVENTS_LOG_STREAM}`],
        }),
      ],
    });
    policy.attachToRole(this.role);
    // cdk-nag IAM5 逐一列出萬用字元的資源（不整條規則豁免）/ Acknowledge each wildcard resource, not the whole rule.
    const bucketLogicalId = stack.getLogicalId(bucket.node.defaultChild as s3.CfnBucket);
    for (const p of [ORDER_EVENTS_PREFIX, ORDER_EVENTS_ERROR_PREFIX]) {
      Validations.of(policy).acknowledge({
        id: `AwsSolutions-IAM5[Resource::<${bucketLogicalId}.Arn>/${p}*]`,
        reason: `Object keys under ${p} only; Firehose names the objects itself (date prefix + random suffix).`,
      });
    }

    // --- Delivery stream ---
    this.stream = new firehose.CfnDeliveryStream(this, 'Stream', {
      deliveryStreamName: this.streamName,
      deliveryStreamType: 'DirectPut',
      // 串流內的暫存資料以 AWS 擁有的金鑰加密（免費）；落地物件另用資料層 CMK / Free AWS-owned key in transit.
      deliveryStreamEncryptionConfigurationInput: { keyType: 'AWS_OWNED_CMK' },
      extendedS3DestinationConfiguration: {
        bucketArn: bucket.bucketArn,
        roleArn: this.role.roleArn,
        prefix: ORDER_EVENTS_S3_PREFIX,
        errorOutputPrefix: ORDER_EVENTS_S3_ERROR_PREFIX,
        compressionFormat: 'GZIP',
        bufferingHints: { sizeInMBs: 5, intervalInSeconds: 300 },
        // 標頭帶 CMK ARN → 通過 bucket policy 的 DenyWrongKmsKey / The header names the CMK ARN.
        encryptionConfiguration: { kmsEncryptionConfig: { awskmsKeyArn: keyArn } },
        cloudWatchLoggingOptions: { enabled: true, logGroupName: logGroup.logGroupName, logStreamName: logStream.logStreamName },
      },
    });
    // 角色政策要先存在，Firehose 建立時會檢查權限 / The policy must exist before the stream is created.
    this.stream.node.addDependency(policy);

    // --- 規則 → Firehose（L1：需要 input transformer）/ Rule → Firehose ---
    const ruleRole = new iam.Role(this, 'RuleRole', {
      roleName: `brewline-${envName}-lake-order-events-rule`,
      description: 'EventBridge rule role: put order events into the order-events Firehose stream (P2a-2)',
      assumedBy: new iam.ServicePrincipal('events.amazonaws.com', {
        conditions: { StringEquals: { 'aws:SourceAccount': Aws.ACCOUNT_ID }, ArnEquals: { 'aws:SourceArn': ruleArn } },
      }),
    });
    ruleRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PutIntoOrderEventsStream',
        actions: ['firehose:PutRecord', 'firehose:PutRecordBatch'],
        resources: [this.streamArn],
      }),
    );

    const rule = new events.CfnRule(this, 'Rule', {
      name: this.ruleName,
      description: 'Order events (OrderCreated, OrderStatusChanged) to the data lake via Firehose (ADR-032 D6)',
      eventBusName: busName,
      state: 'ENABLED',
      eventPattern: { source: [ORDER_EVENT_SOURCE], 'detail-type': [...ORDER_EVENT_TYPES] },
      targets: [
        {
          id: 'OrderEventsFirehose',
          arn: this.streamArn,
          roleArn: ruleRole.roleArn,
          inputTransformer: { inputPathsMap: { ...ORDER_EVENTS_INPUT_PATHS }, inputTemplate: ORDER_EVENTS_INPUT_TEMPLATE },
          retryPolicy: { maximumRetryAttempts: 3, maximumEventAgeInSeconds: 7200 },
          deadLetterConfig: { arn: deadLetterQueue.queueArn },
        },
      ],
    });
    rule.addDependency(this.stream);

    // 規則投遞失敗 → lake-dlq（既有告警）/ Failed deliveries go to the lake DLQ (existing alarm).
    deadLetterQueue.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowOrderEventsRuleDeadLetters',
        principals: [new iam.ServicePrincipal('events.amazonaws.com')],
        actions: ['sqs:SendMessage'],
        resources: [deadLetterQueue.queueArn],
        conditions: { ArnEquals: { 'aws:SourceArn': ruleArn } },
      }),
    );
  }
}
