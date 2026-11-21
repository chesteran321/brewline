import { App, Tags, Validations } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { EDGE_ATTRIBUTES } from '../../../services/shipment/src/edge-attributes';
import { LambdaGuardrailsChecker } from '../lib/aspects/lambda-guardrails';
import { applyStandardTags, RequiredTagsChecker } from '../lib/aspects/required-tags';
import { ENVIRONMENTS, EnvName } from '../lib/config';
import { POSITIONS_PREFIX, ShipmentStack } from '../lib/stacks/shipment-stack';

function build(envName: EnvName) {
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const env = ENVIRONMENTS[envName];
  const stack = new ShipmentStack(app, `brewline-${envName}-shipment`, {
    envName, lambda: env.lambda, env: { account: env.account, region: env.region },
  });
  Tags.of(stack).add('module', 'shipment', { priority: 200 });
  applyStandardTags(app, { env: envName, module: 'platform' });
  RequiredTagsChecker.attach(app);
  LambdaGuardrailsChecker.attach(app);
  Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
  return { app, stack, t: Template.fromStack(stack) };
}
type Stmt = { Sid?: string; Effect: string; Action: string | string[]; Resource: unknown; Condition?: Record<string, Record<string, unknown>> };
const statements = (t: Template): Stmt[] =>
  Object.values(t.findResources('AWS::IAM::Policy')).flatMap((p) => p.Properties.PolicyDocument.Statement as Stmt[]);
const sid = (t: Template, id: string) => statements(t).find((s) => s.Sid === id)!;
const acts = (t: Template) => statements(t).flatMap((s) => ([] as string[]).concat(s.Action));

describe.each(['dev', 'prod'] as const)('ShipmentStack (%s)', (envName) => {
  const { app, stack, t } = build(envName);

  test('detector: standard function, concurrency 1, env from SSM, async retries 2 → shipment-dlq', () => {
    t.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: `brewline-${envName}-shipment-voyage-detector`,
      Runtime: 'nodejs24.x',
      Architectures: ['arm64'],
      ReservedConcurrentExecutions: 1,
      Timeout: 60,
      Environment: { Variables: Match.objectLike({ TABLE_NAME: { Ref: Match.stringLikeRegexp('tablename') }, LAKE_BUCKET: { Ref: Match.stringLikeRegexp('lakebucketname') } }) },
    });
    t.hasResourceProperties('AWS::Lambda::EventInvokeConfig', {
      MaximumRetryAttempts: 2,
      MaximumEventAgeInSeconds: 6 * 3600,
      DestinationConfig: { OnFailure: { Destination: { 'Fn::GetAtt': [Match.stringLikeRegexp('^Dlq'), 'Arn'] } } },
    });
  });

  test('rule on the DEFAULT bus: aws.s3 Object Created, lake bucket, raw/positions/ prefix; retries 3 / 2 h, DLQ', () => {
    const rules = Object.values(t.findResources('AWS::Events::Rule'));
    expect(rules).toHaveLength(1);
    const r = rules[0]!.Properties;
    expect(r.Name).toBe(`brewline-${envName}-shipment-positions`);
    expect(r.EventBusName).toBeUndefined(); // 預設 bus / default bus (S3 events only go there)
    expect(r.EventPattern.source).toEqual(['aws.s3']);
    expect(r.EventPattern['detail-type']).toEqual(['Object Created']);
    expect(JSON.stringify(r.EventPattern.detail.bucket.name)).toContain('lakebucketname');
    expect(r.EventPattern.detail.object.key).toEqual([{ prefix: POSITIONS_PREFIX }]);
    expect(r.Targets).toHaveLength(1);
    expect(r.Targets[0]).toMatchObject({
      RetryPolicy: { MaximumRetryAttempts: 3, MaximumEventAgeInSeconds: 7200 },
      DeadLetterConfig: { Arn: { 'Fn::GetAtt': [expect.stringMatching(/^Dlq/), 'Arn'] } },
    });
  });

  test('detector IAM: read raw/positions/ only; KMS via S3 (bucket context) and via DynamoDB; Query VESSEL#; SHIP# read/write; edges status-only; Scan denied', () => {
    expect(sid(t, 'ReadPositions')).toMatchObject({ Action: 's3:GetObject' });
    expect(JSON.stringify(sid(t, 'ReadPositions').Resource)).toContain(`/${POSITIONS_PREFIX}*`);
    expect(sid(t, 'DecryptPositionsViaS3').Condition!.StringEquals).toMatchObject({ 'kms:ViaService': 's3.ap-east-2.amazonaws.com' });
    expect(JSON.stringify(sid(t, 'DecryptPositionsViaS3').Condition)).toContain('lakebucketarn');
    expect(sid(t, 'QueryVesselEdges').Condition).toEqual({ 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['VESSEL#*'] } });
    expect(sid(t, 'ReadWriteShipment').Condition).toEqual({ 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['SHIP#*'] } });
    const edge = sid(t, 'UpdateEdgeStatusOnly');
    expect(edge.Action).toBe('dynamodb:UpdateItem');
    expect(edge.Condition).toEqual({
      'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['LOT#*', 'VESSEL#*'] },
      'ForAllValues:StringEquals': { 'dynamodb:Attributes': ['pk', 'sk', 'status'] },
    });
    // 邊的 status 是 edge 屬性之一（P2b-1 的白名單）/ status is one of the P2b-1 edge attributes.
    expect(EDGE_ATTRIBUTES).toContain('status');
    expect(sid(t, 'DenyScan')).toMatchObject({ Effect: 'Deny', Action: 'dynamodb:Scan' });
    const a = acts(t);
    for (const x of ['dynamodb:DeleteItem', 'dynamodb:BatchWriteItem', 's3:PutObject', 's3:DeleteObject', 'events:PutEvents', 'sts:AssumeRole']) expect(a).not.toContain(x);
    expect(statements(t).filter((s) => s.Effect === 'Allow' && [].concat(s.Action as never).includes('dynamodb:Scan' as never))).toEqual([]);
  });

  test('DLQ (SSE-SQS, TLS, 14 days) and one alarm wired to the ops topic (ALARM + OK)', () => {
    t.hasResourceProperties('AWS::SQS::Queue', { QueueName: `brewline-${envName}-shipment-dlq`, SqsManagedSseEnabled: true, MessageRetentionPeriod: 14 * 86400 });
    expect(JSON.stringify(t.findResources('AWS::SQS::QueuePolicy'))).toContain('aws:SecureTransport');
    const alarms = Object.values(t.findResources('AWS::CloudWatch::Alarm')).map((x) => x.Properties);
    expect(alarms.map((x) => x.AlarmName)).toEqual([`brewline-${envName}-shipment-dlq-not-empty`]);
    expect(alarms[0]).toMatchObject({ Threshold: 1, MetricName: 'ApproximateNumberOfMessagesVisible' });
    expect(alarms[0]!.AlarmActions).toHaveLength(1);
    expect(alarms[0]!.OKActions).toHaveLength(1);
  });

  test('Glue table brewline_raw.positions: JSON lines, projection source × dt from 2026-11-21, malformed JSON fails, synthetic mixed', () => {
    t.hasResourceProperties('AWS::Glue::Table', {
      DatabaseName: 'brewline_raw',
      TableInput: Match.objectLike({
        Name: 'positions',
        PartitionKeys: [{ Name: 'source', Type: 'string' }, { Name: 'dt', Type: 'string' }],
        Parameters: Match.objectLike({
          'projection.enabled': 'true',
          'projection.source.type': 'enum',
          'projection.source.values': 'sim,ais',
          'projection.dt.range': '2026-11-21,NOW',
          synthetic: 'mixed',
        }),
        StorageDescriptor: Match.objectLike({
          SerdeInfo: { SerializationLibrary: 'org.openx.data.jsonserde.JsonSerDe', Parameters: { 'ignore.malformed.json': 'false' } },
        }),
      }),
    });
  });

  test('three SSM parameters under /brewline/<env>/shipment/ and no CloudFormation exports', () => {
    const names = Object.values(t.findResources('AWS::SSM::Parameter')).map((p) => p.Properties.Name).sort();
    expect(names).toEqual(['detector-function-name', 'dlq-arn', 'dlq-url'].map((n) => `/brewline/${envName}/shipment/${n}`));
    const outputs = t.toJSON().Outputs as Record<string, { Export?: unknown }>;
    expect(Object.values(outputs).every((o) => o.Export === undefined)).toBe(true);
  });

  test('passes cdk-nag, tags and Lambda guardrails', () => {
    app.synth();
    expect(Annotations.fromStack(stack).findError('*', Match.anyValue())).toHaveLength(0);
  });
});
