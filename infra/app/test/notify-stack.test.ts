import { App, Tags, Validations } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { applyStandardTags, RequiredTagsChecker } from '../lib/aspects/required-tags';
import { LambdaGuardrailsChecker } from '../lib/aspects/lambda-guardrails';
import { ENVIRONMENTS, EnvName, MailSettings } from '../lib/config';
import { DMARC_POLICY, NotifyStack } from '../lib/stacks/notify-stack';

function build(envName: EnvName, mail?: Partial<MailSettings>) {
  const env = ENVIRONMENTS[envName];
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new NotifyStack(app, `brewline-${envName}-notify`, {
    envName,
    lambda: env.lambda,
    mail: { ...env.mail, ...mail },
    env: { account: env.account, region: env.region },
  });
  Tags.of(stack).add('module', 'notifications', { priority: 200 });
  applyStandardTags(app, { env: envName, module: 'platform' });
  RequiredTagsChecker.attach(app);
  LambdaGuardrailsChecker.attach(app);
  Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
  return { app, stack, template: Template.fromStack(stack) };
}

type Res = { Properties: Record<string, any> };
const resources = (t: Template, type: string) => Object.values(t.findResources(type)) as Res[];

describe.each(['dev', 'prod'] as const)('NotifyStack (%s)', (envName) => {
  const env = ENVIRONMENTS[envName];
  const { app, stack, template } = build(envName);

  test('domain identity: Easy DKIM 2048, MAIL FROM subdomain (reject on MX failure), configuration set', () => {
    template.hasResourceProperties('AWS::SES::EmailIdentity', {
      EmailIdentity: env.mail.domain,
      DkimSigningAttributes: { NextSigningKeyLength: 'RSA_2048_BIT' },
      MailFromAttributes: { MailFromDomain: `mail.${env.mail.domain}`, BehaviorOnMxFailure: 'REJECT_MESSAGE' },
      ConfigurationSetAttributes: { ConfigurationSetName: Match.anyValue() },
    });
  });

  test('DNS: 3 DKIM CNAMEs, MAIL FROM MX + SPF, DMARC (quarantine, strict DKIM, relaxed SPF)', () => {
    const records = resources(template, 'AWS::Route53::RecordSet');
    expect(records.filter((r) => r.Properties.Type === 'CNAME')).toHaveLength(3);
    expect(records.find((r) => r.Properties.Type === 'MX')!.Properties.Name).toBe(`mail.${env.mail.domain}.`);
    const txt = records.filter((r) => r.Properties.Type === 'TXT');
    expect(txt.map((r) => r.Properties.Name).sort()).toEqual([`_dmarc.${env.mail.domain}.`, `mail.${env.mail.domain}.`]);
    const dmarc = txt.find((r) => r.Properties.Name.startsWith('_dmarc'))!;
    expect(dmarc.Properties.ResourceRecords).toEqual([`"${DMARC_POLICY}"`]);
    expect(DMARC_POLICY).toBe('v=DMARC1; p=quarantine; adkim=s; aspf=r');
  });

  test('configuration set: TLS required, suppression, bounce/complaint/reject → ops topic', () => {
    template.hasResourceProperties('AWS::SES::ConfigurationSet', {
      Name: `brewline-${envName}-mail`,
      DeliveryOptions: { TlsPolicy: 'REQUIRE' },
      SuppressionOptions: { SuppressedReasons: ['BOUNCE', 'COMPLAINT'] },
    });
    const [dest] = resources(template, 'AWS::SES::ConfigurationSetEventDestination');
    expect(dest!.Properties.EventDestination.MatchingEventTypes.sort()).toEqual(['bounce', 'complaint', 'deliveryDelay', 'reject', 'renderingFailure']);
    expect(JSON.stringify(dest!.Properties.EventDestination.SnsDestination.TopicARN)).toContain('alertstopicarn');
    // 反向：不追蹤開信、點擊（不需要、也是個資）/ Negative: no open/click tracking.
    expect(dest!.Properties.EventDestination.MatchingEventTypes).not.toContain('open');
  });

  test('notifier: orders-notify role (may assume the tenant role), no direct DynamoDB/KMS, SES pinned to the From address', () => {
    const [fn] = resources(template, 'AWS::Lambda::Function').filter((f) => f.Properties.FunctionName === `brewline-${envName}-notifications-order-notifier`);
    expect(fn!.Properties.Environment.Variables).toMatchObject({
      FROM_ADDRESS: `orders@${env.mail.domain}`,
      FROM_NAME: 'BrewLine (Demo)',
      CONFIGURATION_SET: { Ref: expect.stringMatching(/^ConfigurationSet/) },
      TENANT_ROLE_ARN: `arn:aws:iam::${env.account}:role/brewline-${envName}-tenant-access`,
    });
    expect(fn!.Properties.ReservedConcurrentExecutions).toBe(1);
    template.hasResourceProperties('AWS::IAM::Role', { RoleName: `brewline-${envName}-orders-notify` });
    const st = resources(template, 'AWS::IAM::Policy').flatMap((p) => p.Properties.PolicyDocument.Statement);
    const actions = st.filter((s: any) => s.Effect === 'Allow').flatMap((s: any) => [].concat(s.Action));
    expect(actions.filter((a: string) => a.startsWith('dynamodb:') || a.startsWith('kms:'))).toEqual([]);
    const send = st.find((s: any) => s.Sid === 'SendOrderMail');
    expect(send.Action).toBe('ses:SendEmail');
    expect(send.Condition).toEqual({ StringEquals: { 'ses:FromAddress': `orders@${env.mail.domain}` } });
    const assume = st.find((s: any) => s.Sid === 'AssumeTenantRole');
    expect(assume.Resource).toBe(`arn:aws:iam::${env.account}:role/brewline-${envName}-tenant-access`);
  });

  test('rules: OrderCreated, and OrderStatusChanged only to CONFIRMED/SHIPPED/CANCELLED; DLQ + async retries', () => {
    const rules = resources(template, 'AWS::Events::Rule');
    const patterns = Object.fromEntries(rules.map((r) => [r.Properties.Name, r.Properties.EventPattern]));
    expect(patterns[`brewline-${envName}-mail-order-created`]).toEqual({ source: ['brewline.ordering'], 'detail-type': ['OrderCreated'] });
    expect(patterns[`brewline-${envName}-mail-order-status`]).toEqual({
      source: ['brewline.ordering'],
      'detail-type': ['OrderStatusChanged'],
      detail: { status: ['CONFIRMED', 'SHIPPED', 'CANCELLED'] },
    });
    for (const r of rules) expect(r.Properties.Targets[0].DeadLetterConfig.Arn).toBeDefined();
    template.hasResourceProperties('AWS::Lambda::EventInvokeConfig', {
      MaximumRetryAttempts: 2,
      DestinationConfig: { OnFailure: { Destination: Match.anyValue() } },
    });
    template.hasResourceProperties('AWS::SQS::Queue', { QueueName: `brewline-${envName}-notify-dlq`, SqsManagedSseEnabled: true });
  });

  test('DLQ alarm notifies the ops topic (ALARM and OK)', () => {
    const [alarm] = resources(template, 'AWS::CloudWatch::Alarm');
    expect(alarm!.Properties.AlarmName).toBe(`brewline-${envName}-notify-dlq-not-empty`);
    expect(alarm!.Properties.AlarmActions).toHaveLength(1);
    expect(alarm!.Properties.OKActions).toHaveLength(1);
  });

  test('cdk-nag and guardrails pass', () => {
    app.synth();
    expect(Annotations.fromStack(stack).findError('*', Match.anyValue())).toEqual([]);
  });
});

describe('hosted zones and delegation', () => {
  test('Dev creates its subdomain zone (retained) and outputs the name servers', () => {
    const { template } = build('dev');
    template.hasResource('AWS::Route53::HostedZone', { DeletionPolicy: 'Retain', Properties: { Name: 'dev.brewline-demo.click.' } });
    template.hasOutput('MailZoneNameServers', Match.anyValue());
  });

  test('Prod imports the registered zone and creates no zone', () => {
    const { template } = build('prod');
    template.resourceCountIs('AWS::Route53::HostedZone', 0);
    const records = resources(template, 'AWS::Route53::RecordSet');
    expect(records.every((r) => r.Properties.HostedZoneId === 'Z039360620HRFCTYO5R5J')).toBe(true);
  });

  test('Prod delegation: no NS record while name servers are empty; one when filled', () => {
    expect(resources(build('prod').template, 'AWS::Route53::RecordSet').filter((r) => r.Properties.Type === 'NS')).toHaveLength(0);
    const ns = ['ns-1.awsdns-01.com', 'ns-2.awsdns-02.net', 'ns-3.awsdns-03.org', 'ns-4.awsdns-04.co.uk'];
    const { template } = build('prod', { delegations: [{ subdomain: 'dev', nameServers: ns }] });
    const [rec] = resources(template, 'AWS::Route53::RecordSet').filter((r) => r.Properties.Type === 'NS');
    expect(rec!.Properties).toMatchObject({ Name: 'dev.brewline-demo.click.', ResourceRecords: ns });
  });

  // 反向：名稱伺服器數量不對 → synth 失敗 / Negative: a wrong number of name servers fails synth.
  test('a delegation with other than 4 name servers fails', () => {
    expect(() => build('prod', { delegations: [{ subdomain: 'dev', nameServers: ['ns-1.awsdns-01.com'] }] })).toThrow(/4 name servers/);
  });
});
