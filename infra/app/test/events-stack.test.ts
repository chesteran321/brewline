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
    allowTestPublisher: env.api.orderTests,
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
      { eventName: ['MODIFY'], dynamodb: { NewImage: { entity: { S: ['RoastBatch'] } } } },
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

  test('bus policy (RSK-017): Deny PutEvents to everyone except known publishers', () => {
    const policies = resources(template, 'AWS::Events::EventBusPolicy');
    expect(policies).toHaveLength(1);
    const [[, p]] = policies as [[string, Res]];
    expect(p.Properties.EventBusName).toEqual({ Ref: expect.stringMatching(/^Bus/) });
    const st = p.Properties.Statement;
    expect(st).toMatchObject({ Effect: 'Deny', Principal: { AWS: '*' }, Action: 'events:PutEvents' });
    expect(st.Resource).toEqual({ 'Fn::GetAtt': [expect.stringMatching(/^Bus/), 'Arn'] });
    expect(Object.keys(st.Condition)).toEqual(['ArnNotLike']);
    const allowed = JSON.stringify(st.Condition.ArnNotLike['aws:PrincipalArn']);
    // 正向：發布函數（本 stack 的角色）、補貨執行角色、SSO Admin / Positive: publisher, replenish run role, SSO Admin.
    expect(allowed).toContain('StreamPublisherRole');
    expect(allowed).toContain(`:iam::${cfg.account}:role/brewline-${envName}-orders-replenish"`);
    expect(allowed).toContain(`:iam::${cfg.account}:role/aws-reserved/sso.amazonaws.com/*/AWSReservedSSO_Admin_*"`);
    // Dev 才有訂單測試函數 / Only Dev has the order-test publisher.
    expect(allowed.includes(`role/brewline-${envName}-orders-tests"`)).toBe(cfg.api.orderTests);
    // 反向：沒有放行整個帳號或整個 orders-* 前綴、沒有 Developer
    // Negative: no account-wide or orders-* wildcard, no Developer.
    expect(allowed).not.toContain('orders-*');
    expect(allowed).not.toContain('Developer');
    expect(allowed).not.toMatch(/:role\/\*"/);
    // 沒有任何 Allow（同帳號由身分政策決定，也不開放跨帳號）/ No Allow: identity policies decide, no cross-account.
    expect(JSON.stringify(policies)).not.toContain('"Allow"');
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

  test('three alarms, all notifying the ops topic (A4b)', () => {
    const alarms = resources(template, 'AWS::CloudWatch::Alarm').map(([, a]) => a.Properties);
    expect(alarms.map((a) => a.AlarmName).sort()).toEqual([
      `brewline-${envName}-events-rule-dlq-not-empty`,
      `brewline-${envName}-events-stream-dlq-not-empty`,
      `brewline-${envName}-events-stream-iterator-age`,
    ]);
    expect(alarms.every((a) => a.AlarmActions?.length === 1 && a.OKActions?.length === 1 && a.TreatMissingData === 'notBreaching')).toBe(true);
    expect(alarms.find((a) => a.MetricName === 'IteratorAge')).toMatchObject({ Statistic: 'Maximum', Threshold: 300000 });
  });

  test('passes cdk-nag, tags and Lambda guardrails', () => {
    app.synth();
    expect(Annotations.fromStack(stack).findError('*', Match.anyValue())).toHaveLength(0);
  });
});
