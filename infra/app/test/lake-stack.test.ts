import { App } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { ENVIRONMENTS } from '../lib/config';
import { ORDER_EVENTS_INPUT_TEMPLATE } from '../lib/constructs/order-events-firehose';
import { ATHENA_ENGINE, LAKE_DATABASES, LAKE_PARAMETERS, LakeStack, ORDER_EVENTS_TABLE, SMOKE_TABLE } from '../lib/stacks/lake-stack';

const make = (envName: 'dev' | 'prod') => {
  const app = new App();
  const e = ENVIRONMENTS[envName];
  return new LakeStack(app, `brewline-${envName}-lake`, {
    envName,
    lake: e.lake,
    env: { account: e.account, region: e.region },
  });
};
type Stmt = { Sid?: string; Effect: string; Action: string | string[]; Resource: unknown; Condition?: Record<string, Record<string, unknown>> };
type Rule = { Id: string; Prefix?: string; ExpirationInDays?: number; Transitions?: Array<{ StorageClass: string; TransitionInDays: number }>; NoncurrentVersionExpiration?: { NoncurrentDays: number }; AbortIncompleteMultipartUpload?: { DaysAfterInitiation: number } };

describe.each(['dev', 'prod'] as const)('LakeStack (%s)', (envName) => {
  const stack = make(envName);
  const t = Template.fromStack(stack);
  const e = ENVIRONMENTS[envName];
  const bucketByName = (prefix: string) =>
    Object.entries(t.findResources('AWS::S3::Bucket')).find(([, r]) => r.Properties.BucketName === `brewline-${envName}-${prefix}-${e.account}`)!;
  const [lakeId, lakeBucket] = bucketByName('lake');
  const [resultsId, resultsBucket] = bucketByName('athena-results');
  const policyOf = (bucketId: string) =>
    Object.values(t.findResources('AWS::S3::BucketPolicy')).find((p) => p.Properties.Bucket.Ref === bucketId)!.Properties.PolicyDocument.Statement as Stmt[];
  const tableNamed = (name: string) =>
    Object.values(t.findResources('AWS::Glue::Table')).filter((r) => r.Properties.TableInput.Name === name);
  const smokeTables = () => tableNamed(SMOKE_TABLE);
  const rules = (b: { [key: string]: any }): Rule[] => b.Properties.LifecycleConfiguration.Rules;

  test('both buckets: SSE-KMS with the data CMK (SSM) + Bucket Key, block public access, owner-enforced, data-class internal', () => {
    for (const b of [lakeBucket, resultsBucket]) {
      expect(b.Properties).toMatchObject({
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            { BucketKeyEnabled: true, ServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms', KMSMasterKeyID: { Ref: expect.stringContaining('datakmskeyarn') } } },
          ],
        },
        PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
        OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
      });
      expect(b.Properties.Tags).toEqual(expect.arrayContaining([{ Key: 'data-class', Value: 'internal' }]));
      expect(b.DeletionPolicy).toBe(e.lake.retainOnDelete ? 'Retain' : 'Delete');
    }
  });

  test('both buckets: TLS-only and TLS ≥ 1.2 in the bucket policy; no public Allow', () => {
    for (const id of [lakeId, resultsId]) {
      const st = policyOf(id);
      expect(st.some((s) => s.Effect === 'Deny' && s.Condition?.Bool?.['aws:SecureTransport'] === 'false')).toBe(true);
      expect(st.some((s) => s.Effect === 'Deny' && s.Condition?.NumericLessThan?.['s3:TlsVersion'] === 1.2)).toBe(true);
      expect(st.filter((s) => s.Effect === 'Allow')).toEqual([]);
    }
  });

  test('lake versioned, results not versioned', () => {
    expect(lakeBucket.Properties.VersioningConfiguration).toEqual({ Status: 'Enabled' });
    expect(resultsBucket.Properties.VersioningConfiguration).toBeUndefined();
  });

  test('lake lifecycle per prefix (docs/12 §3)', () => {
    const r = Object.fromEntries(rules(lakeBucket).map((x) => [x.Id, x]));
    expect(r.raw).toMatchObject({ Prefix: 'raw/', ExpirationInDays: e.lake.rawExpirationDays });
    if (envName === 'prod') {
      expect(r.raw!.Transitions).toEqual([{ StorageClass: 'GLACIER_IR', TransitionInDays: 90 }]);
      expect(r.raw!.ExpirationInDays).toBe(730);
    } else {
      expect(r.raw!.Transitions).toBeUndefined(); // Dev：不轉層 / no tiering
      expect(r.raw!.ExpirationInDays).toBe(30);
    }
    expect(r.curated).toMatchObject({ Prefix: 'curated/', ExpirationInDays: 730 });
    expect(r.analytics).toMatchObject({ Prefix: 'analytics/', ExpirationInDays: 730 });
    expect(r.quarantine).toMatchObject({ Prefix: 'quarantine/', ExpirationInDays: 90 });
    // 所有前綴（沒有 Prefix）/ All prefixes.
    expect(r['noncurrent-and-multipart']).toMatchObject({ NoncurrentVersionExpiration: { NoncurrentDays: 30 }, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 } });
    expect(r['noncurrent-and-multipart']!.Prefix).toBeUndefined();
  });

  test('results lifecycle: everything expires after 7 days, multipart aborted after 1', () => {
    expect(rules(resultsBucket)).toEqual([expect.objectContaining({ ExpirationInDays: 7, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } })]);
    expect(rules(resultsBucket)[0]!.Prefix).toBeUndefined();
  });

  test('lake policy: DenyWrongKmsKey and DenyNonKmsSse apply only when the header is present', () => {
    const st = policyOf(lakeId);
    const wrongKey = st.find((s) => s.Sid === 'DenyWrongKmsKey')!;
    expect(wrongKey).toMatchObject({ Effect: 'Deny', Action: 's3:PutObject' });
    expect(wrongKey.Condition!.Null).toEqual({ 's3:x-amz-server-side-encryption-aws-kms-key-id': 'false' });
    expect(wrongKey.Condition!.StringNotEquals!['s3:x-amz-server-side-encryption-aws-kms-key-id']).toEqual({ Ref: expect.stringContaining('datakmskeyarn') });
    const nonKms = st.find((s) => s.Sid === 'DenyNonKmsSse')!;
    expect(nonKms).toMatchObject({ Effect: 'Deny', Action: 's3:PutObject' });
    expect(nonKms.Condition).toEqual({
      Null: { 's3:x-amz-server-side-encryption': 'false' },
      StringNotEquals: { 's3:x-amz-server-side-encryption': 'aws:kms' },
    });
    // 反向：不能用 *IfExists（標頭不存在時會變成 true → 擋掉所有沒帶標頭的上傳）
    // Negative: no *IfExists operator (it is true when the header is missing and would deny every default-encrypted upload).
    expect(JSON.stringify(st)).not.toMatch(/IfExists/);
    // 結果 bucket 沒有這兩條（Athena 依 workgroup 設定帶 CMK）/ Not on the results bucket.
    expect(policyOf(resultsId).map((s) => s.Sid)).not.toContain('DenyWrongKmsKey');
  });

  test('three Glue databases with lake locations', () => {
    t.resourceCountIs('AWS::Glue::Database', 3);
    for (const [prefix, name] of [['raw/', LAKE_DATABASES.raw], ['curated/', LAKE_DATABASES.curated], ['analytics/', LAKE_DATABASES.analytics]] as const) {
      t.hasResourceProperties('AWS::Glue::Database', {
        CatalogId: e.account,
        DatabaseInput: Match.objectLike({ Name: name, LocationUri: { 'Fn::Join': ['', ['s3://', { Ref: lakeId }, `/${prefix}`]] } }),
      });
    }
    // 不開帳號層級的目錄加密、不用 crawler、不用 Lake Formation（D4、ADR-032）/ Negative.
    for (const type of ['AWS::Glue::DataCatalogEncryptionSettings', 'AWS::Glue::Crawler', 'AWS::LakeFormation::DataLakeSettings']) {
      t.resourceCountIs(type, 0);
    }
  });

  test(`smoke table only in Dev (${envName})`, () => {
    // 期望值寫死環境，不讀 config：Prod 誤開 smokeTable 時這裡要失敗 / Hard-coded so a Prod config slip fails here.
    expect(e.lake.smokeTable).toBe(envName === 'dev');
    if (envName === 'prod') {
      expect(smokeTables()).toEqual([]);
      return;
    }
    expect(smokeTables()).toHaveLength(1);
    const table = smokeTables()[0]!;
    expect(table.DependsOn).toEqual([expect.stringContaining('GlueDbRaw')]);
    expect(table.Properties).toMatchObject({
      DatabaseName: LAKE_DATABASES.raw,
      TableInput: {
        Name: SMOKE_TABLE,
        TableType: 'EXTERNAL_TABLE',
        PartitionKeys: [{ Name: 'dt', Type: 'string' }],
        StorageDescriptor: {
          Columns: [{ Name: 'id', Type: 'string' }, { Name: 'value', Type: 'int' }, { Name: 'note', Type: 'string' }],
          SerdeInfo: { SerializationLibrary: 'org.openx.data.jsonserde.JsonSerDe' },
        },
      },
    });
    const params = table.Properties.TableInput.Parameters;
    expect(params).toMatchObject({
      'projection.enabled': 'true',
      'projection.dt.type': 'date',
      'projection.dt.format': 'yyyy-MM-dd',
      'projection.dt.range': '2026-11-01,NOW',
      synthetic: 'true',
      source_id: 'SMOKE',
    });
    expect(params['storage.location.template']).toEqual({ 'Fn::Join': ['', ['s3://', { Ref: lakeId }, '/raw/_smoke/dt=${dt}/']] });
  });

  test('workgroup: enforced, scan cutoff from config, SSE-KMS results, engine v3', () => {
    t.hasResourceProperties('AWS::Athena::WorkGroup', {
      Name: `brewline-${envName}-analytics`,
      State: 'ENABLED',
      RecursiveDeleteOption: envName === 'dev',
      WorkGroupConfiguration: {
        EnforceWorkGroupConfiguration: true,
        BytesScannedCutoffPerQuery: envName === 'dev' ? 104_857_600 : 1_073_741_824,
        EngineVersion: { SelectedEngineVersion: ATHENA_ENGINE },
        PublishCloudWatchMetricsEnabled: true,
        ResultConfiguration: {
          OutputLocation: { 'Fn::Join': ['', ['s3://', { Ref: resultsId }, '/athena/']] },
          EncryptionConfiguration: { EncryptionOption: 'SSE_KMS', KmsKey: { Ref: Match.stringLikeRegexp('datakmskeyarn') } },
          ExpectedBucketOwner: e.account,
        },
      },
    });
  });

  test('lake DLQ: SSE-SQS, TLS only, 14 days; one alarm wired to the ops topic (ALARM + OK)', () => {
    t.hasResourceProperties('AWS::SQS::Queue', { QueueName: `brewline-${envName}-lake-dlq`, SqsManagedSseEnabled: true, MessageRetentionPeriod: 1_209_600 });
    const qp = Object.values(t.findResources('AWS::SQS::QueuePolicy'))[0]!.Properties.PolicyDocument.Statement as Stmt[];
    expect(qp.some((s) => s.Effect === 'Deny' && s.Condition?.Bool?.['aws:SecureTransport'] === 'false')).toBe(true);
    t.resourceCountIs('AWS::CloudWatch::Alarm', 1);
    t.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: `brewline-${envName}-lake-dlq-not-empty`,
      MetricName: 'ApproximateNumberOfMessagesVisible',
      Threshold: 1,
      EvaluationPeriods: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      TreatMissingData: 'notBreaching',
      AlarmActions: [{ Ref: Match.stringLikeRegexp('opsalertstopicarn') }],
      OKActions: [{ Ref: Match.stringLikeRegexp('opsalertstopicarn') }],
    });
  });

  test('eleven SSM parameters under /brewline/<env>/lake/ with matching outputs (P2a 9 + P2a-2 2)', () => {
    t.resourceCountIs('AWS::SSM::Parameter', 11);
    for (const [name, outputId] of Object.entries(LAKE_PARAMETERS)) {
      t.hasResourceProperties('AWS::SSM::Parameter', { Name: `/brewline/${envName}/lake/${name}`, Type: 'String', Tier: 'Standard' });
      expect(t.findOutputs(outputId)).not.toEqual({});
    }
    t.hasOutput('WorkgroupName', { Value: `brewline-${envName}-analytics` });
  });

  test('no Lambda at all (no autoDeleteObjects / custom resources) and no synth errors', () => {
    t.resourceCountIs('AWS::Lambda::Function', 0);
    expect(Object.keys(t.findResources('Custom::S3AutoDeleteObjects'))).toEqual([]);
    expect(Annotations.fromStack(stack).findError('*', Match.anyValue())).toEqual([]);
  });

  // ---------------- P2a-2：訂單事件 → Firehose → raw/events/ ----------------
  const streamOf = () => Object.values(t.findResources('AWS::KinesisFirehose::DeliveryStream'))[0]!;
  const firehosePolicy = () =>
    Object.values(t.findResources('AWS::IAM::Policy')).find((p) =>
      (p.Properties.PolicyDocument.Statement as Stmt[]).some((x) => x.Sid === 'WriteOrderEventPrefixes'),
    )!.Properties.PolicyDocument.Statement as Stmt[];
  const ruleOf = () => Object.values(t.findResources('AWS::Events::Rule'))[0]!;
  const streamArn = { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, `:firehose:ap-east-2:${e.account}:deliverystream/brewline-${envName}-order-events`]] };

  test('P2a-2 Firehose: DirectPut, AWS-owned stream key, raw/events/ prefixes, GZIP, 5 MiB/300 s, CMK for objects, error logs, no processing', () => {
    t.resourceCountIs('AWS::KinesisFirehose::DeliveryStream', 1);
    const p = streamOf().Properties;
    expect(p).toMatchObject({
      DeliveryStreamName: `brewline-${envName}-order-events`,
      DeliveryStreamType: 'DirectPut',
      DeliveryStreamEncryptionConfigurationInput: { KeyType: 'AWS_OWNED_CMK' },
    });
    const d = p.ExtendedS3DestinationConfiguration;
    expect(d).toMatchObject({
      BucketARN: { 'Fn::GetAtt': [lakeId, 'Arn'] },
      Prefix: 'raw/events/dt=!{timestamp:yyyy-MM-dd}/',
      ErrorOutputPrefix: 'raw/events-errors/!{firehose:error-output-type}/dt=!{timestamp:yyyy-MM-dd}/',
      CompressionFormat: 'GZIP',
      BufferingHints: { SizeInMBs: 5, IntervalInSeconds: 300 },
      EncryptionConfiguration: { KMSEncryptionConfig: { AWSKMSKeyARN: { Ref: expect.stringContaining('datakmskeyarn') } } },
      CloudWatchLoggingOptions: { Enabled: true },
    });
    // 反向：沒有資料處理（E1-A 由規則產生換行）/ Negative: no processing configuration.
    expect(d.ProcessingConfiguration).toBeUndefined();
    expect(d.DynamicPartitioningConfiguration).toBeUndefined();
    t.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: `/aws/kinesisfirehose/brewline-${envName}-order-events`,
      RetentionInDays: envName === 'dev' ? 7 : 30,
    });
  });

  test('P2a-2 Firehose role: trust firehose with SourceAccount/SourceArn; writes only two prefixes; KMS via S3 with the bucket ARN as context', () => {
    t.hasResourceProperties('AWS::IAM::Role', {
      RoleName: `brewline-${envName}-order-events-firehose`,
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Principal: { Service: 'firehose.amazonaws.com' },
            Condition: {
              StringEquals: { 'aws:SourceAccount': { Ref: 'AWS::AccountId' } },
              ArnEquals: { 'aws:SourceArn': streamArn },
            },
          }),
        ],
      },
    });
    const st = firehosePolicy();
    const write = st.find((x) => x.Sid === 'WriteOrderEventPrefixes')!;
    expect([write.Action].flat().sort()).toEqual(['s3:AbortMultipartUpload', 's3:PutObject']);
    expect(write.Resource).toHaveLength(2);
    expect(write.Resource).toEqual(
      expect.arrayContaining([
        { 'Fn::Join': ['', [{ 'Fn::GetAtt': [lakeId, 'Arn'] }, '/raw/events-errors/*']] },
        { 'Fn::Join': ['', [{ 'Fn::GetAtt': [lakeId, 'Arn'] }, '/raw/events/*']] },
      ]),
    );
    const kmsSt = st.find((x) => x.Sid === 'DataKeyViaS3ForLakeBucket')!;
    expect([kmsSt.Action].flat().sort()).toEqual(['kms:Decrypt', 'kms:GenerateDataKey']);
    // Bucket Key：加密內容是 bucket ARN（不是物件 ARN）/ Bucket Key: the context is the bucket ARN.
    expect(kmsSt.Condition!.StringEquals!['kms:EncryptionContext:aws:s3:arn']).toEqual({ 'Fn::GetAtt': [lakeId, 'Arn'] });
    expect(kmsSt.Condition!.StringEquals!['kms:ViaService']).toBeDefined();
    // 反向：不能讀、不能刪、沒有 Resource "*" / Negative: no read, no delete, no wildcard resource.
    const actions = st.flatMap((x) => [x.Action].flat());
    expect(actions).not.toEqual(expect.arrayContaining(['s3:GetObject']));
    expect(actions).not.toEqual(expect.arrayContaining(['s3:DeleteObject']));
    expect(st.filter((x) => x.Resource === '*')).toEqual([]);
  });

  test('P2a-2 rule: only OrderCreated/OrderStatusChanged; input transformer emits one JSON line; DLQ = lake-dlq; retries 3 / 2 h', () => {
    t.resourceCountIs('AWS::Events::Rule', 1);
    const r = ruleOf().Properties;
    expect(r).toMatchObject({
      Name: `brewline-${envName}-lake-order-events`,
      State: 'ENABLED',
      EventBusName: { Ref: expect.stringContaining('eventsbusname') },
      EventPattern: { source: ['brewline.ordering'], 'detail-type': ['OrderCreated', 'OrderStatusChanged'] },
    });
    expect(r.Targets).toHaveLength(1);
    const target = r.Targets[0];
    expect(target.Arn).toEqual(streamArn);
    expect(target.DeadLetterConfig).toEqual({ Arn: { 'Fn::GetAtt': [expect.stringContaining('LakeDlq'), 'Arn'] } });
    expect(target.RetryPolicy).toEqual({ MaximumRetryAttempts: 3, MaximumEventAgeInSeconds: 7200 });
    expect(target.InputTransformer.InputPathsMap).toEqual({ id: '$.id', detail_type: '$.detail-type', source: '$.source', time: '$.time', detail: '$.detail' });
    expect(target.InputTransformer.InputTemplate).toBe(ORDER_EVENTS_INPUT_TEMPLATE);
    expect(target.InputTransformer.InputTemplate.endsWith('}\n')).toBe(true);
    // 反向：不用 <aws.events.event…>（文件規定只能當欄位值）/ Negative: no reserved full-event variable.
    expect(target.InputTransformer.InputTemplate).not.toMatch(/aws\.events\.event/);
    // 規則投遞失敗可以寫進 lake-dlq（限定這條規則）/ The DLQ accepts dead letters from this rule only.
    const qp = Object.values(t.findResources('AWS::SQS::QueuePolicy'))[0]!.Properties.PolicyDocument.Statement as Stmt[];
    const dl = qp.find((x) => x.Sid === 'AllowOrderEventsRuleDeadLetters')!;
    expect(dl).toMatchObject({ Effect: 'Allow', Action: 'sqs:SendMessage' });
    expect(JSON.stringify(dl.Condition)).toContain(`/brewline-${envName}-lake-order-events`);
    // 規則角色只能寫這個 stream / The rule role can only put into this stream.
    const rulePolicy = Object.values(t.findResources('AWS::IAM::Policy')).find((p) =>
      (p.Properties.PolicyDocument.Statement as Stmt[]).some((x) => x.Sid === 'PutIntoOrderEventsStream'),
    )!.Properties.PolicyDocument.Statement as Stmt[];
    expect(rulePolicy).toEqual([
      expect.objectContaining({ Action: expect.arrayContaining(['firehose:PutRecord', 'firehose:PutRecordBatch']), Resource: target.Arn }),
    ]);
  });

  test('P2a-2 Glue table order_events in both envs: JSON lines, projection from 2026-11-20, malformed JSON fails', () => {
    const tables = tableNamed(ORDER_EVENTS_TABLE);
    expect(tables).toHaveLength(1);
    const ti = tables[0]!.Properties.TableInput;
    expect(tables[0]!.Properties.DatabaseName).toBe(LAKE_DATABASES.raw);
    expect(ti.StorageDescriptor.Columns.map((c: { Name: string }) => c.Name)).toEqual(['id', 'detail_type', 'source', 'time', 'detail']);
    expect(ti.StorageDescriptor.Columns[4].Type).toMatch(/^struct<event_id:string,.*synthetic:boolean,items:array<struct<product_id:string,qty_kg:double>>>$/);
    expect(ti.StorageDescriptor.SerdeInfo).toEqual({
      SerializationLibrary: 'org.openx.data.jsonserde.JsonSerDe',
      Parameters: { 'ignore.malformed.json': 'false' },
    });
    expect(ti.Parameters).toMatchObject({
      'projection.enabled': 'true',
      'projection.dt.type': 'date',
      'projection.dt.range': '2026-11-20,NOW',
      synthetic: 'mixed',
      ingested_by: 'firehose',
    });
    expect(ti.Parameters['storage.location.template']).toEqual({ 'Fn::Join': ['', ['s3://', { Ref: lakeId }, '/raw/events/dt=${dt}/']] });
  });
});
