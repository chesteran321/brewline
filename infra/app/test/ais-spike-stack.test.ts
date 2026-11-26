import { App, Tags, Validations } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { LambdaGuardrailsChecker } from '../lib/aspects/lambda-guardrails';
import { applyStandardTags, RequiredTagsChecker } from '../lib/aspects/required-tags';
import { AisSpikeSettings, ENVIRONMENTS } from '../lib/config';
import {
  AIS_KEY_PARAM,
  AIS_POSITIONS_PREFIX,
  AIS_SCHEDULE_EXPRESSION,
  AIS_STATIC_PREFIX,
  AisSpikeStack,
} from '../lib/stacks/ais-spike-stack';

const dev = ENVIRONMENTS.dev;
const spike = dev.aisSpike!;

function build(settings: AisSpikeSettings = spike, envName: 'dev' | 'prod' = 'dev') {
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const env = ENVIRONMENTS[envName];
  const stack = new AisSpikeStack(app, `brewline-${envName}-ais-spike`, {
    envName, lambda: env.lambda, spike: settings, env: { account: env.account, region: env.region },
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
const samplerStatements = (t: Template): Stmt[] => {
  const policies = Object.values(t.findResources('AWS::IAM::Policy')).filter((p) => JSON.stringify(p.Properties.Roles).includes('SamplerRole'));
  return policies.flatMap((p) => p.Properties.PolicyDocument.Statement as Stmt[]);
};
/** 測試 app 沒有 cdk.json 的 context → partition 是 token；展開成 aws 再比對 / Flatten Fn::Join with AWS::Partition. */
const flat = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(flat);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (JSON.stringify(o) === JSON.stringify({ Ref: 'AWS::Partition' })) return 'aws';
    if ('Fn::Join' in o) {
      const [sep, parts] = o['Fn::Join'] as [string, unknown[]];
      const f = parts.map(flat);
      return f.every((x) => typeof x === 'string') ? f.join(sep) : { 'Fn::Join': [sep, f] };
    }
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, flat(x)]));
  }
  return v;
};
const acts = (s: Stmt[]) => s.flatMap((x) => ([] as string[]).concat(x.Action));

describe('AisSpikeStack (Dev only)', () => {
  const { app, stack, t } = build();

  test('config: Dev has a 7-day window in UTC; Prod has none (F1)', () => {
    expect(ENVIRONMENTS.prod.aisSpike).toBeUndefined();
    expect(spike.startDate).toMatch(/Z$/);
    expect(Date.parse(spike.endDate) - Date.parse(spike.startDate)).toBe(7 * 86_400_000);
    expect(spike.collectSeconds).toBe(120);
  });

  test('sampler: standard function, 256 MB, 150 s, concurrency 1, env holds the parameter NAME only', () => {
    t.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'brewline-dev-ais-spike-sampler',
      Runtime: 'nodejs24.x',
      Architectures: ['arm64'],
      MemorySize: 256,
      Timeout: 150,
      ReservedConcurrentExecutions: 1,
      TracingConfig: { Mode: 'Active' },
      Environment: {
        Variables: Match.objectLike({ AIS_KEY_PARAM: AIS_KEY_PARAM('dev'), COLLECT_SECONDS: '120', LAKE_BUCKET: { Ref: Match.stringLikeRegexp('lakebucketname') } }),
      },
    });
    const vars = Object.values(t.findResources('AWS::Lambda::Function'))[0]!.Properties.Environment.Variables as Record<string, unknown>;
    expect(Object.keys(vars).some((k) => /KEY$|SECRET|TOKEN/.test(k) && k !== 'AIS_KEY_PARAM')).toBe(false);
  });

  test('F7: no async retries; failures → shipment-dlq (from SSM); no new alarm', () => {
    t.hasResourceProperties('AWS::Lambda::EventInvokeConfig', {
      MaximumRetryAttempts: 0,
      DestinationConfig: { OnFailure: { Destination: { Ref: Match.stringLikeRegexp('shipmentdlqarn') } } },
    });
    t.resourceCountIs('AWS::CloudWatch::Alarm', 0);
    t.resourceCountIs('AWS::SQS::Queue', 0);
  });

  test('sampler IAM: one parameter, KMS only via SSM for that parameter and via S3 for the lake, PutObject only on two prefixes', () => {
    const s = flat(samplerStatements(t)) as Stmt[];
    const sid = (id: string) => s.find((x) => x.Sid === id)!;
    expect(sid('ReadApiKeyParameter').Resource).toBe('arn:aws:ssm:ap-east-2:610935435571:parameter/brewline/dev/ais/api-key');
    expect(sid('DecryptApiKeyViaSsm').Condition).toEqual({
      StringEquals: { 'kms:ViaService': 'ssm.ap-east-2.amazonaws.com', 'kms:EncryptionContext:PARAMETER_ARN': 'arn:aws:ssm:ap-east-2:610935435571:parameter/brewline/dev/ais/api-key' },
    });
    const put = JSON.stringify(sid('WriteAisObjects').Resource);
    expect(put).toContain(`/${AIS_POSITIONS_PREFIX}*`);
    expect(put).toContain(`/${AIS_STATIC_PREFIX}*`);
    expect(put).not.toContain('source=sim');
    expect(sid('EncryptAisObjectsViaS3').Condition!.StringEquals!['kms:ViaService']).toBe('s3.ap-east-2.amazonaws.com');
    expect(JSON.stringify(sid('EncryptAisObjectsViaS3').Condition)).toContain('lakebucketarn'); // bucket ARN (Bucket Key)
  });

  test('negative IAM: no DynamoDB, no S3 Get/Delete/List, no PutEvents, no wildcard SSM, no direct KMS', () => {
    const a = acts(samplerStatements(t));
    expect(a.filter((x) => x.startsWith('dynamodb:'))).toEqual([]);
    expect(a.filter((x) => /^s3:(Get|Delete|List)/.test(x))).toEqual([]);
    expect(a).not.toContain('events:PutEvents');
    expect(a).not.toContain('ssm:GetParameters');
    expect(a).not.toContain('ssm:GetParametersByPath');
    for (const st of samplerStatements(t).filter((x) => acts([x]).some((y) => y.startsWith('kms:')))) {
      expect(st.Condition?.StringEquals?.['kms:ViaService']).toBeDefined();
    }
    expect(a.filter((x) => x.endsWith('*') && x !== 'xray:*')).toEqual([]);
  });

  test('schedule: own group, :10/:40 Asia/Taipei, StartDate/EndDate from config, no retries, DLQ = shipment-dlq', () => {
    t.hasResourceProperties('AWS::Scheduler::ScheduleGroup', { Name: 'brewline-dev-ais-spike' });
    t.hasResourceProperties('AWS::Scheduler::Schedule', {
      Name: 'brewline-dev-ais-spike-sampler',
      GroupName: 'brewline-dev-ais-spike',
      ScheduleExpression: AIS_SCHEDULE_EXPRESSION,
      ScheduleExpressionTimezone: 'Asia/Taipei',
      StartDate: spike.startDate,
      EndDate: spike.endDate,
      FlexibleTimeWindow: { Mode: 'OFF' },
      State: 'ENABLED',
      Target: Match.objectLike({ RetryPolicy: { MaximumRetryAttempts: 0 }, DeadLetterConfig: { Arn: { Ref: Match.stringLikeRegexp('shipmentdlqarn') } } }),
    });
    expect(AIS_SCHEDULE_EXPRESSION).toBe('cron(10,40 * * * ? *)'); // 避開 :05、:20、:50 / clear of the simulator
  });

  test('scheduler role: trusted only for this schedule GROUP, may only invoke the sampler and send to the DLQ', () => {
    const roles = Object.values(t.findResources('AWS::IAM::Role', { Properties: { RoleName: 'brewline-dev-ais-spike-scheduler' } }));
    expect(roles).toHaveLength(1);
    expect(flat(roles[0]!.Properties.AssumeRolePolicyDocument)).toMatchObject({
        Statement: [
          {
            Principal: { Service: 'scheduler.amazonaws.com' },
            Condition: { StringEquals: { 'aws:SourceAccount': '610935435571', 'aws:SourceArn': 'arn:aws:scheduler:ap-east-2:610935435571:schedule-group/brewline-dev-ais-spike' } },
          },
        ],
    });
    const sched = Object.values(t.findResources('AWS::IAM::Policy')).filter((p) => JSON.stringify(p.Properties.Roles).includes('SchedulerRole'));
    const a = acts(sched.flatMap((p) => p.Properties.PolicyDocument.Statement as Stmt[]));
    expect(a.sort()).toEqual(['lambda:InvokeFunction', 'sqs:GetQueueAttributes', 'sqs:GetQueueUrl', 'sqs:SendMessage']);
  });

  test('Glue table brewline_raw.ais_static: JSON SerDe, malformed fails, dt projection from the start date', () => {
    t.hasResourceProperties('AWS::Glue::Table', {
      DatabaseName: 'brewline_raw',
      TableInput: Match.objectLike({
        Name: 'ais_static',
        PartitionKeys: [{ Name: 'dt', Type: 'string' }],
        Parameters: Match.objectLike({ 'projection.enabled': 'true', 'projection.dt.range': `${spike.startDate.slice(0, 10)},NOW`, synthetic: 'false' }),
        StorageDescriptor: Match.objectLike({ SerdeInfo: { SerializationLibrary: 'org.openx.data.jsonserde.JsonSerDe', Parameters: { 'ignore.malformed.json': 'false' } } }),
      }),
    });
  });

  test('no custom resources, no extra Lambda functions', () => {
    expect(Object.values(t.toJSON().Resources as Record<string, { Type: string }>).filter((r) => r.Type.startsWith('Custom::') || r.Type === 'AWS::CloudFormation::CustomResource')).toEqual([]);
    t.resourceCountIs('AWS::Lambda::Function', 1);
    expect(statements(t).length).toBeGreaterThan(0);
  });

  test('cdk-nag and guardrails: no errors', () => {
    app.synth();
    expect(Annotations.fromStack(stack).findError('*', Match.anyValue())).toEqual([]);
  });
});

describe('AisSpikeStack guards', () => {
  test.each([
    ['Prod', () => build(spike, 'prod'), 'Dev-only'],
    ['more than 7 days', () => build({ ...spike, endDate: '2026-12-04T16:00:01Z' }), 'at most 7 days'],
    ['end before start', () => build({ ...spike, endDate: spike.startDate }), 'at most 7 days'],
    ['not UTC', () => build({ ...spike, startDate: '2026-11-27T00:00:00+08:00' }), 'UTC ISO'],
    ['collect longer than D9', () => build({ ...spike, collectSeconds: 150 }), '30–120'],
  ])('rejects %s', (_name, f, msg) => {
    expect(f).toThrow(msg);
  });
});
