import { App, Stack, Tags, Validations } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { AwsSolutionsChecks } from 'cdk-nag';
import { applyStandardTags, RequiredTagsChecker } from '../lib/aspects/required-tags';
import { ENVIRONMENTS } from '../lib/config';
import { EventsStack } from '../lib/stacks/events-stack';
import { OpsStack, notifyAlarms } from '../lib/stacks/ops-stack';

describe.each(['dev', 'prod'] as const)('OpsStack (%s)', (envName) => {
  const env = ENVIRONMENTS[envName];
  const app = new App();
  const stack = new OpsStack(app, `brewline-${envName}-ops`, { envName, env: { account: env.account, region: env.region } });
  Tags.of(stack).add('module', 'ops', { priority: 200 });
  applyStandardTags(app, { env: envName, module: 'platform' });
  RequiredTagsChecker.attach(app);
  Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
  const template = Template.fromStack(stack);

  test('topic encrypted with the account CMK from SSM; ARN published to SSM', () => {
    template.hasResourceProperties('AWS::SNS::Topic', {
      TopicName: `brewline-${envName}-ops-alerts`,
      KmsMasterKeyId: { Ref: Match.stringLikeRegexp('kmskeyarn') },
    });
    template.hasResourceProperties('AWS::SNS::TopicPolicy', Match.anyValue());
    template.hasResourceProperties('AWS::SSM::Parameter', { Name: `/brewline/${envName}/ops/alerts-topic-arn` });
  });

  test('topic policy: TLS only; only CloudWatch and EventBridge of this account may publish', () => {
    const [policy] = Object.values(template.findResources('AWS::SNS::TopicPolicy')) as Array<{ Properties: { PolicyDocument: { Statement: any[] } } }>;
    const st = policy!.Properties.PolicyDocument.Statement;
    expect(st).toContainEqual(expect.objectContaining({ Effect: 'Deny', Condition: { Bool: { 'aws:SecureTransport': 'false' } } }));
    const allow = st.find((s) => s.Sid === 'AllowAlarmsAndRulesToPublish');
    expect(allow.Principal.Service.sort()).toEqual(['cloudwatch.amazonaws.com', 'events.amazonaws.com']);
    expect(allow.Action).toBe('sns:Publish');
    expect(allow.Condition).toEqual({ StringEquals: { 'aws:SourceAccount': env.account } });
    // 反向：沒有 Principal "*" 的 Allow、沒有訂閱（Email 不進 IaC）/ Negative: no public allow, no subscriptions in IaC.
    expect(st.filter((s) => s.Effect === 'Allow' && s.Principal === '*')).toEqual([]);
    template.resourceCountIs('AWS::SNS::Subscription', 0);
  });

  test('topic policy: SES events only from this account and brewline-<env>-* configuration sets (A4d)', () => {
    const [policy] = Object.values(template.findResources('AWS::SNS::TopicPolicy')) as Array<{ Properties: { PolicyDocument: { Statement: any[] } } }>;
    const ses = policy!.Properties.PolicyDocument.Statement.find((s: any) => s.Sid === 'AllowSesEventsToPublish');
    expect(ses.Principal).toEqual({ Service: 'ses.amazonaws.com' });
    expect(ses.Action).toBe('sns:Publish');
    expect(ses.Condition).toEqual({
      StringEquals: { 'aws:SourceAccount': env.account },
      ArnLike: { 'aws:SourceArn': `arn:aws:ses:ap-east-2:${env.account}:configuration-set/brewline-${envName}-*` },
    });
  });

  test('passes cdk-nag and required tags', () => {
    app.synth();
    expect(Annotations.fromStack(stack).findError('*', Match.anyValue())).toHaveLength(0);
  });
});

describe('notifyAlarms', () => {
  test('attaches ALARM and OK actions to every alarm in scope', () => {
    const stack = new Stack(new App(), 'S', { env: { account: '111111111111', region: 'ap-east-2' } });
    for (const id of ['A', 'B']) {
      new cloudwatch.Alarm(stack, id, {
        metric: new cloudwatch.Metric({ namespace: 'X', metricName: 'Y' }),
        threshold: 1,
        evaluationPeriods: 1,
      });
    }
    expect(notifyAlarms(stack, 'dev')).toBe(2);
    const alarms = Object.values(Template.fromStack(stack).findResources('AWS::CloudWatch::Alarm')) as Array<{ Properties: any }>;
    for (const a of alarms) {
      expect(a.Properties.AlarmActions).toEqual([{ Ref: expect.stringContaining('opsalertstopicarn') }]);
      expect(a.Properties.OKActions).toEqual(a.Properties.AlarmActions);
    }
  });
});

describe.each(['dev', 'prod'] as const)('EventsStack alerts wiring (%s)', (envName) => {
  const env = ENVIRONMENTS[envName];
  const stack = new EventsStack(new App({ context: { 'aws:cdk:bundling-stacks': [] } }), `brewline-${envName}-events`, {
    envName,
    lambda: env.lambda,
    env: { account: env.account, region: env.region },
  });
  const template = Template.fromStack(stack);
  test('every alarm notifies the ops topic', () => {
    const alarms = Object.values(template.findResources('AWS::CloudWatch::Alarm')) as Array<{ Properties: any }>;
    expect(alarms).toHaveLength(3);
    expect(alarms.every((a) => a.Properties.AlarmActions?.length === 1 && a.Properties.OKActions?.length === 1)).toBe(true);
  });
  test('StockLow rule → ops topic with a readable message and the rule DLQ', () => {
    const rules = Object.values(template.findResources('AWS::Events::Rule')) as Array<{ Properties: any }>;
    const rule = rules.find((r) => r.Properties.Name === `brewline-${envName}-stock-low`)!.Properties;
    expect(rule.EventPattern).toEqual({ source: ['brewline.ordering'], 'detail-type': ['StockLow'] });
    expect(rule.Targets[0].Arn).toEqual({ Ref: expect.stringContaining('opsalertstopicarn') });
    expect(rule.Targets[0].InputTransformer.InputTemplate).toContain('Stock low');
    expect(rule.Targets[0].DeadLetterConfig.Arn).toEqual({ 'Fn::GetAtt': [expect.stringContaining('RuleDlq'), 'Arn'] });
  });
});
