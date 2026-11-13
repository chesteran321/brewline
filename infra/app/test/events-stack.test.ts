import { App, Tags, Validations } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { LambdaGuardrailsChecker } from '../lib/aspects/lambda-guardrails';
import { applyStandardTags, RequiredTagsChecker } from '../lib/aspects/required-tags';
import { ENVIRONMENTS, EnvName } from '../lib/config';
import { EventsStack } from '../lib/stacks/events-stack';

function buildApp(envName: EnvName) {
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const env = ENVIRONMENTS[envName];
  const stack = new EventsStack(app, `brewline-${envName}-events`, {
    envName,
    lambda: env.lambda,
    env: { account: env.account, region: env.region },
  });
  Tags.of(stack).add('module', 'events', { priority: 200 });
  applyStandardTags(app, { env: envName, module: 'platform' });
  RequiredTagsChecker.attach(app);
  LambdaGuardrailsChecker.attach(app);
  Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
  return { app, stack, template: Template.fromStack(stack) };
}

type Res = { Properties: Record<string, any>; DependsOn?: string[] };
const resources = (t: Template, type: string) => Object.entries(t.findResources(type)) as Array<[string, Res]>;

describe.each(['dev', 'prod'] as const)('EventsStack (%s)', (envName) => {
  const { app, stack, template } = buildApp(envName);
  const cfg = ENVIRONMENTS[envName];

  test('custom bus brewline-<env> published to SSM (no exports)', () => {
    template.hasResourceProperties('AWS::Events::EventBus', { Name: `brewline-${envName}` });
    for (const n of ['bus-name', 'bus-arn']) {
      template.hasResourceProperties('AWS::SSM::Parameter', { Name: `/brewline/${envName}/events/${n}` });
    }
    const outputs = template.toJSON().Outputs as Record<string, { Export?: unknown }>;
    expect(Object.values(outputs).every((o) => o.Export === undefined)).toBe(true);
  });

  test('stream mapping: SSM stream ARN, LATEST, filters, partial failures, retries, DLQ', () => {
    const [[, m]] = resources(template, 'AWS::Lambda::EventSourceMapping') as [[string, Res]];
    expect(m.Properties).toMatchObject({
      EventSourceArn: { Ref: expect.stringContaining('tablestreamarn') },
      StartingPosition: 'LATEST',
      FunctionResponseTypes: ['ReportBatchItemFailures'],
      BisectBatchOnFunctionError: true,
      MaximumRetryAttempts: 3,
      MaximumRecordAgeInSeconds: 3600,
      DestinationConfig: { OnFailure: { Destination: { 'Fn::GetAtt': [expect.stringContaining('StreamDlq'), 'Arn'] } } },
    });
    const patterns = m.Properties.FilterCriteria.Filters.map((f: { Pattern: string }) => JSON.parse(f.Pattern));
    expect(patterns).toEqual([
      { dynamodb: { NewImage: { entity: { S: ['Order'] } } } },
      { eventName: ['MODIFY'], dynamodb: { Keys: { sk: { S: ['STOCK'] } } } },
    ]);
    // 政策先建立，對應才建立 / The policy exists before the mapping.
    expect(m.DependsOn!.some((d) => d.includes('DefaultPolicy'))).toBe(true);
  });

  test('publisher: least privilege (stream read, KMS via DynamoDB, PutEvents on this bus, DLQ send)', () => {
    const st = resources(template, 'AWS::IAM::Policy').flatMap(([, p]) => p.Properties.PolicyDocument.Statement);
    expect(st.find((s) => s.Sid === 'DecryptStream')).toMatchObject({
      Action: 'kms:Decrypt',
      Condition: { StringEquals: { 'kms:ViaService': 'dynamodb.ap-east-2.amazonaws.com' } },
    });
    expect(st.find((s) => s.Action === 'events:PutEvents').Resource).toEqual({ 'Fn::GetAtt': [expect.stringContaining('Bus'), 'Arn'] });
    // 反向：沒有任何資料表讀寫權限 / Negative: no table item access at all.
    const actions = st.flatMap((s) => [].concat(s.Action)) as string[];
    expect(actions.filter((a) => /^dynamodb:(Get|Put|Update|Delete|Query|Scan|Batch)/.test(a) && a !== 'dynamodb:GetRecords' && a !== 'dynamodb:GetShardIterator')).toEqual([]);
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: `brewline-${envName}-events-stream-publisher`,
      ReservedConcurrentExecutions: cfg.lambda.reservedConcurrency.streamPublisher,
      Environment: { Variables: Match.objectLike({ EVENT_BUS_NAME: { Ref: Match.stringLikeRegexp('^Bus') } }) },
    });
  });

  test('audit rule: brewline.* → log group, native resource policy scoped to the rule, rule DLQ', () => {
    const [[, rule]] = resources(template, 'AWS::Events::Rule') as [[string, Res]];
    expect(rule.Properties.EventPattern).toEqual({ source: [{ prefix: 'brewline.' }] });
    expect(rule.Properties.Targets[0]).toMatchObject({
      DeadLetterConfig: { Arn: { 'Fn::GetAtt': [expect.stringContaining('RuleDlq'), 'Arn'] } },
      RetryPolicy: { MaximumRetryAttempts: 3 },
    });
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: `/aws/events/brewline-${envName}`,
      RetentionInDays: cfg.lambda.logRetentionDays,
    });
    template.resourceCountIs('AWS::Logs::ResourcePolicy', 1);
    expect(JSON.stringify(template.findResources('AWS::Logs::ResourcePolicy'))).toContain('aws:SourceArn');
    // 反向：沒有 CDK 的 AwsCustomResource Lambda（只有發布函數一個）/ Negative: no AwsCustomResource Lambda.
    template.resourceCountIs('AWS::Lambda::Function', 1);
  });

  test('DLQs: SSE-SQS, TLS only, 14 days; rule DLQ writable only by the audit rule', () => {
    for (const [, q] of resources(template, 'AWS::SQS::Queue')) {
      expect(q.Properties).toMatchObject({ SqsManagedSseEnabled: true, MessageRetentionPeriod: 14 * 24 * 3600 });
    }
    const policies = JSON.stringify(template.findResources('AWS::SQS::QueuePolicy'));
    expect(policies).toContain('aws:SecureTransport');
    expect(policies).toContain('AllowAuditRuleDlq');
  });

  test('three alarms without actions yet (A3 decision D7)', () => {
    const alarms = resources(template, 'AWS::CloudWatch::Alarm').map(([, a]) => a.Properties);
    expect(alarms.map((a) => a.AlarmName).sort()).toEqual([
      `brewline-${envName}-events-rule-dlq-not-empty`,
      `brewline-${envName}-events-stream-dlq-not-empty`,
      `brewline-${envName}-events-stream-iterator-age`,
    ]);
    expect(alarms.every((a) => a.AlarmActions === undefined && a.TreatMissingData === 'notBreaching')).toBe(true);
    expect(alarms.find((a) => a.MetricName === 'IteratorAge')).toMatchObject({ Statistic: 'Maximum', Threshold: 300000 });
  });

  test('passes cdk-nag, tags and Lambda guardrails', () => {
    app.synth();
    expect(Annotations.fromStack(stack).findError('*', Match.anyValue())).toHaveLength(0);
  });
});
