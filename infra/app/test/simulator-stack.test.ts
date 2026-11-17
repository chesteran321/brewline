import { App, Tags, Validations } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { LambdaGuardrailsChecker } from '../lib/aspects/lambda-guardrails';
import { applyStandardTags, RequiredTagsChecker } from '../lib/aspects/required-tags';
import { ENVIRONMENTS, EnvName } from '../lib/config';
import { SimulatorStack } from '../lib/stacks/simulator-stack';

function build(envName: EnvName) {
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const env = ENVIRONMENTS[envName];
  const stack = new SimulatorStack(app, `brewline-${envName}-simulator`, {
    envName, lambda: env.lambda, simulator: env.simulator, commitSha: 'abc1234',
    env: { account: env.account, region: env.region },
  });
  Tags.of(stack).add('module', 'simulator', { priority: 200 });
  applyStandardTags(app, { env: envName, module: 'platform' });
  RequiredTagsChecker.attach(app);
  LambdaGuardrailsChecker.attach(app);
  Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
  return { app, stack, template: Template.fromStack(stack) };
}

type Res = { Properties: Record<string, any>; DependsOn?: string[] };
const resources = (t: Template, type: string) => Object.values(t.findResources(type)) as Res[];
const roleStatements = (t: Template, roleLogicalPrefix: string) =>
  Object.entries(t.findResources('AWS::IAM::Policy'))
    .filter(([, p]: [string, any]) => JSON.stringify(p.Properties.Roles).includes(roleLogicalPrefix))
    .flatMap(([, p]: [string, any]) => p.Properties.PolicyDocument.Statement as any[]);
const actionsOf = (st: any[]) => st.flatMap((s) => [].concat(s.Action)) as string[];

describe.each(['dev', 'prod'] as const)('SimulatorStack (%s)', (envName) => {
  const { app, stack, template } = build(envName);
  const cfg = ENVIRONMENTS[envName];
  const prefix = `/brewline/${envName}/simulator`;

  test('schedule: hourly 08:05-19:05 Asia/Taipei, own group, no retries, DLQ (D8)', () => {
    template.hasResourceProperties('AWS::Scheduler::ScheduleGroup', { Name: `brewline-${envName}-simulator` });
    template.hasResourceProperties('AWS::Scheduler::Schedule', {
      Name: `brewline-${envName}-simulator-tick`,
      GroupName: `brewline-${envName}-simulator`,
      ScheduleExpression: 'cron(5 8-19 * * ? *)',
      ScheduleExpressionTimezone: 'Asia/Taipei',
      FlexibleTimeWindow: { Mode: 'OFF' },
      State: 'ENABLED',
      Target: Match.objectLike({
        RetryPolicy: { MaximumRetryAttempts: 0 },
        DeadLetterConfig: { Arn: { 'Fn::GetAtt': [Match.stringLikeRegexp('^Dlq'), 'Arn'] } },
        Input: '{"source":"schedule"}',
      }),
    });
  });

  test('scheduler role: trusted only for this schedule GROUP (§10.15 lesson), invokes only the run function', () => {
    const [role] = resources(template, 'AWS::IAM::Role').filter((r) => r.Properties.RoleName === `brewline-${envName}-simulator-scheduler`);
    const trust = JSON.stringify(role!.Properties.AssumeRolePolicyDocument);
    expect(trust).toContain('scheduler.amazonaws.com');
    expect(trust).toContain(`:schedule-group/brewline-${envName}-simulator`);
    expect(trust).not.toContain(':schedule/');
    expect(trust).toContain('aws:SourceAccount');
    const st = roleStatements(template, 'SchedulerRole');
    expect(actionsOf(st).sort()).toEqual(['lambda:InvokeFunction', 'sqs:GetQueueAttributes', 'sqs:GetQueueUrl', 'sqs:SendMessage'].sort());
  });

  test('run role: sign-in and read 3 parameters only; cannot manage accounts, write parameters or touch data (D3)', () => {
    const st = roleStatements(template, 'RunRole');
    const acts = actionsOf(st);
    expect(acts).toContain('cognito-idp:AdminInitiateAuth');
    for (const a of ['cognito-idp:AdminCreateUser', 'cognito-idp:AdminSetUserPassword', 'cognito-idp:AdminAddUserToGroup', 'ssm:PutParameter', 'kms:Encrypt']) {
      expect(acts).not.toContain(a);
    }
    expect(acts.filter((a) => a.startsWith('dynamodb:') || a.startsWith('events:') || a.startsWith('sts:'))).toEqual([]);
    const read = st.find((s) => s.Sid === 'ReadSimulatorParameters');
    const resText = JSON.stringify(read.Resource);
    for (const n of ['state', 'config', 'credentials']) expect(resText).toContain(`:parameter${prefix}/${n}`);
    expect(resText).not.toContain('*');
    // KMS：只能經由 SSM、只能解這個參數 / KMS only via SSM and only for this parameter.
    expect(st.find((s) => s.Sid === 'CredentialsParameterKey')).toMatchObject({
      Action: 'kms:Decrypt',
      Condition: { StringEquals: { 'kms:ViaService': 'ssm.ap-east-2.amazonaws.com', 'kms:EncryptionContext:PARAMETER_ARN': expect.anything() } },
    });
    expect(JSON.stringify(st.find((s) => s.Sid === 'CredentialsParameterKey').Condition)).toContain(`:parameter${prefix}/credentials`);
  });

  test('provisioner: Cognito admin on this pool, state + credentials parameters only, key pinned to the credentials ARN', () => {
    const st = roleStatements(template, 'ProvisionRole');
    expect(st.find((s) => s.Sid === 'ManageSimulatorAccounts').Resource).toEqual({ Ref: expect.stringContaining('authuserpoolarn') });
    const params = JSON.stringify(st.find((s) => s.Sid === 'SimulatorParameters').Resource);
    expect(params).toContain(`${prefix}/credentials`);
    expect(params).toContain(`${prefix}/state`);
    expect(params).not.toContain(`${prefix}/config`);
    expect(JSON.stringify(st.find((s) => s.Sid === 'CredentialsParameterKey').Condition)).toContain(`${prefix}/credentials`);
    expect(actionsOf(st).filter((a) => a.startsWith('dynamodb:'))).toEqual([]);
  });

  test('accounts custom resource: pool size, seed, retention per env; re-checked on every deploy', () => {
    const [cr] = resources(template, 'Custom::BrewlineSimulatorAccounts');
    expect(cr!.Properties).toMatchObject({
      PoolSize: String(cfg.simulator.poolSize),
      Seed: cfg.simulator.seed,
      RetainOnDelete: String(cfg.simulator.retainOnDelete),
      CredentialsParam: `${prefix}/credentials`,
      StateParam: `${prefix}/state`,
      Commit: 'abc1234',
    });
    expect(cfg.simulator.retainOnDelete).toBe(envName === 'prod');
  });

  test('config parameter is managed by CDK; state and credentials are NOT (create-once switch, secret)', () => {
    const ps = resources(template, 'AWS::SSM::Parameter');
    expect(ps.map((p) => p.Properties.Name)).toEqual([`${prefix}/config`]);
    const value = JSON.parse(ps[0]!.Properties.Value);
    expect(value).toMatchObject({
      poolSize: cfg.simulator.poolSize, ordersPerDay: cfg.simulator.ordersPerDay, seed: cfg.simulator.seed,
      activationStartMonth: '2026-11',
    });
    expect(value).not.toHaveProperty('retainOnDelete');
  });

  test('run function: standard settings, env from SSM, async retries 0 → DLQ', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: `brewline-${envName}-simulator-run`,
      ReservedConcurrentExecutions: 1,
      Timeout: 120,
      Environment: {
        Variables: Match.objectLike({
          STATE_PARAM: `${prefix}/state`,
          API_ENDPOINT: { Ref: Match.stringLikeRegexp('apiendpoint') },
          SIMULATOR_CLIENT_ID: { Ref: Match.stringLikeRegexp('simulatorclientid') },
        }),
      },
    });
    template.hasResourceProperties('AWS::Lambda::EventInvokeConfig', {
      MaximumRetryAttempts: 0,
      DestinationConfig: { OnFailure: { Destination: { 'Fn::GetAtt': [Match.stringLikeRegexp('^Dlq'), 'Arn'] } } },
    });
  });

  test('two alarms, both notifying the ops topic (D9; ≤ 10 per account)', () => {
    const alarms = resources(template, 'AWS::CloudWatch::Alarm').map((a) => a.Properties);
    expect(alarms.map((a) => a.AlarmName).sort()).toEqual([`brewline-${envName}-simulator-dlq-not-empty`, `brewline-${envName}-simulator-run-errors`]);
    expect(alarms.every((a) => a.AlarmActions?.length === 1 && a.OKActions?.length === 1)).toBe(true);
  });

  test('DLQ: SSE-SQS, TLS only', () => {
    template.hasResourceProperties('AWS::SQS::Queue', { QueueName: `brewline-${envName}-simulator-dlq`, SqsManagedSseEnabled: true });
    expect(JSON.stringify(template.findResources('AWS::SQS::QueuePolicy'))).toContain('aws:SecureTransport');
  });

  test('no CloudFormation exports; passes cdk-nag, tags and Lambda guardrails', () => {
    const outputs = template.toJSON().Outputs as Record<string, { Export?: unknown }>;
    expect(Object.values(outputs).every((o) => o.Export === undefined)).toBe(true);
    app.synth();
    expect(Annotations.fromStack(stack).findError('*', Match.anyValue())).toHaveLength(0);
  });
});
