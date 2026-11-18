import { App, Tags, Validations } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { LambdaGuardrailsChecker } from '../lib/aspects/lambda-guardrails';
import { applyStandardTags, RequiredTagsChecker } from '../lib/aspects/required-tags';
import { ENVIRONMENTS, EnvName } from '../lib/config';
import { AuthStack } from '../lib/stacks/auth-stack';

/** 與 bin/app.ts 相同的組裝方式；測試不打包 Lambda 以加快速度 / Same wiring as bin/app.ts, without bundling. */
function buildApp(envName: EnvName) {
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const env = ENVIRONMENTS[envName];
  const stack = new AuthStack(app, `brewline-${envName}-auth`, {
    envName,
    auth: env.auth,
    lambda: env.lambda,
    env: { account: env.account, region: env.region },
  });
  Tags.of(stack).add('module', 'identity', { priority: 200 });
  applyStandardTags(app, { env: envName, module: 'platform' });
  RequiredTagsChecker.attach(app);
  LambdaGuardrailsChecker.attach(app);
  Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
  return { app, stack, template: Template.fromStack(stack) };
}

const clientsOf = (t: Template) =>
  Object.values(t.findResources('AWS::Cognito::UserPoolClient')) as Array<{ Properties: Record<string, any> }>;

describe.each(['dev', 'prod'] as const)('AuthStack (%s)', (envName) => {
  const { app, stack, template } = buildApp(envName);
  const auth = ENVIRONMENTS[envName].auth;

  test('user pool: Essentials, admin-only sign-up, TOTP-only optional MFA, strong passwords', () => {
    template.resourceCountIs('AWS::Cognito::UserPool', 1);
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolName: `brewline-${envName}-users`,
      UserPoolTier: 'ESSENTIALS',
      AdminCreateUserConfig: Match.objectLike({ AllowAdminCreateUserOnly: true }),
      MfaConfiguration: 'OPTIONAL',
      EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
      UsernameAttributes: ['email'],
      Policies: {
        PasswordPolicy: Match.objectLike({
          MinimumLength: 12,
          RequireLowercase: true,
          RequireUppercase: true,
          RequireNumbers: true,
          RequireSymbols: true,
          PasswordHistorySize: 5,
        }),
      },
      DeletionProtection: auth.deletionProtection ? 'ACTIVE' : 'INACTIVE',
      UserPoolTags: Match.objectLike({ 'data-class': 'pii', module: 'identity' }),
    });
    template.hasResource('AWS::Cognito::UserPool', { DeletionPolicy: auth.retainOnDelete ? 'Retain' : 'Delete' });
  });

  test('custom:tenant_id exists and is mutable (admin-only via client write attributes)', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      Schema: Match.arrayWith([Match.objectLike({ Name: 'tenant_id', AttributeDataType: 'String', Mutable: true })]),
    });
  });

  // 反向：任何 app client 都不能寫 tenant_id / Negative: no app client may write tenant_id.
  test('no app client can write custom:tenant_id', () => {
    for (const c of clientsOf(template)) {
      expect(c.Properties.WriteAttributes).toBeDefined();
      expect(c.Properties.WriteAttributes).not.toContain('custom:tenant_id');
      expect(c.Properties.ReadAttributes).toContain('custom:tenant_id');
    }
  });

  test('web client: SRP + refresh only, no OAuth, revocation on, no user-existence leaks', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ClientName: 'web',
      ExplicitAuthFlows: ['ALLOW_USER_SRP_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
      GenerateSecret: false,
      AllowedOAuthFlowsUserPoolClient: false,
      EnableTokenRevocation: true,
      PreventUserExistenceErrors: 'ENABLED',
      AccessTokenValidity: 15,
      IdTokenValidity: 15,
      RefreshTokenValidity: 7 * 24 * 60,
    });
  });

  test(`smoke-test client ${auth.smokeTestClient ? 'exists (Dev)' : 'is absent (Prod)'}`, () => {
    const names = clientsOf(template).map((c) => c.Properties.ClientName);
    expect(names.sort()).toEqual(auth.smokeTestClient ? ['simulator', 'smoke-test', 'web'] : ['simulator', 'web']);
    const adminFlow = clientsOf(template).filter((c) =>
      (c.Properties.ExplicitAuthFlows as string[]).includes('ALLOW_ADMIN_USER_PASSWORD_AUTH'),
    );
    // simulator（兩個環境）＋ smoke-test（只有 Dev）/ simulator (both envs) + smoke-test (Dev only).
    expect(adminFlow.map((c) => c.Properties.ClientName).sort()).toEqual(auth.smokeTestClient ? ['simulator', 'smoke-test'] : ['simulator']);
    // 任何 client 都不允許 USER_PASSWORD_AUTH（密碼明文經過網路）/ No client allows plain USER_PASSWORD_AUTH.
    for (const c of clientsOf(template)) {
      expect(c.Properties.ExplicitAuthFlows).not.toContain('ALLOW_USER_PASSWORD_AUTH');
    }
  });

  // ADR-030 D2：模擬器 client / Simulator client.
  test('simulator client: admin password auth + refresh only, no secret, no OAuth, 15-minute tokens', () => {
    const [sim] = clientsOf(template).filter((c) => c.Properties.ClientName === 'simulator');
    expect(sim).toBeDefined();
    expect((sim!.Properties.ExplicitAuthFlows as string[]).sort()).toEqual(['ALLOW_ADMIN_USER_PASSWORD_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH']);
    expect(sim!.Properties).toMatchObject({
      GenerateSecret: false,
      AllowedOAuthFlowsUserPoolClient: false,
      PreventUserExistenceErrors: 'ENABLED',
      EnableTokenRevocation: true,
      AccessTokenValidity: 15,
      IdTokenValidity: 15,
    });
    // 反向：不能寫 custom:tenant_id、不允許 SRP 以外的使用者端流程 / Negative: cannot write the tenant, no user-side flows.
    expect(sim!.Properties.WriteAttributes).not.toContain('custom:tenant_id');
    expect(sim!.Properties.ExplicitAuthFlows).not.toContain('ALLOW_USER_SRP_AUTH');
  });

  test('pre token trigger reads only the simulator client id parameter (no env var cycle)', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: `brewline-${envName}-identity-pre-token`,
      Environment: { Variables: Match.objectLike({ SIMULATOR_CLIENT_ID_PARAM: `/brewline/${envName}/auth/simulator-client-id` }) },
    });
    const st = Object.values(template.findResources('AWS::IAM::Policy')).flatMap((p: any) => p.Properties.PolicyDocument.Statement);
    const ssmSt = st.filter((s: any) => [].concat(s.Action).some((a: string) => a.startsWith('ssm:')));
    expect(ssmSt).toHaveLength(1);
    expect(ssmSt[0]).toMatchObject({ Sid: 'ReadSimulatorClientId', Action: 'ssm:GetParameter' });
    expect(JSON.stringify(ssmSt[0].Resource)).toContain(`:parameter/brewline/${envName}/auth/simulator-client-id`);
    expect(JSON.stringify(ssmSt[0].Resource)).not.toContain('*');
  });

  test('groups cafe, staff, simulator, simulator-roastery', () => {
    const groups = Object.values(template.findResources('AWS::Cognito::UserPoolGroup')).map(
      (g: any) => g.Properties.GroupName,
    );
    expect(groups.sort()).toEqual(['cafe', 'simulator', 'simulator-roastery', 'staff']);
  });

  test('pre token generation trigger uses event version V2_0 and only the pool may invoke it', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      LambdaConfig: { PreTokenGenerationConfig: { LambdaVersion: 'V2_0', LambdaArn: Match.anyValue() } },
    });
    template.hasResourceProperties('AWS::Lambda::Permission', {
      Principal: 'cognito-idp.amazonaws.com',
      SourceArn: { 'Fn::GetAtt': [Match.stringLikeRegexp('^UserPool'), 'Arn'] },
    });
  });

  test('pre token Lambda follows the BrewLine standard', () => {
    const l = ENVIRONMENTS[envName].lambda;
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: `brewline-${envName}-identity-pre-token`,
      Runtime: 'nodejs24.x',
      Architectures: ['arm64'],
      TracingConfig: { Mode: 'Active' },
      ReservedConcurrentExecutions: l.reservedConcurrency.preTokenGeneration,
      LoggingConfig: Match.objectLike({ LogFormat: 'JSON' }),
    });
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: `/aws/lambda/brewline-${envName}-identity-pre-token`,
      RetentionInDays: l.logRetentionDays,
    });
    // 不用 AWS 託管的 AWSLambdaBasicExecutionRole / No AWS managed execution policy.
    for (const r of Object.values(template.findResources('AWS::IAM::Role')) as any[]) {
      expect(r.Properties.ManagedPolicyArns).toBeUndefined();
    }
  });

  test('publishes IDs to SSM and uses no CloudFormation exports', () => {
    const names = ['user-pool-id', 'user-pool-arn', 'web-client-id', 'issuer', 'simulator-client-id'];
    if (auth.smokeTestClient) names.push('smoke-test-client-id');
    template.resourceCountIs('AWS::SSM::Parameter', names.length);
    for (const name of names) {
      template.hasResourceProperties('AWS::SSM::Parameter', { Name: `/brewline/${envName}/auth/${name}`, Tier: 'Standard' });
    }
    const outputs = template.toJSON().Outputs as Record<string, { Export?: unknown }>;
    expect(Object.values(outputs).every((o) => o.Export === undefined)).toBe(true);
  });

  test('no tag or Lambda guardrail errors', () => {
    expect(Annotations.fromStack(stack).findError('*', Match.anyValue())).toHaveLength(0);
  });

  test('passes cdk-nag (only the documented acknowledgments)', () => {
    expect(() => app.synth()).not.toThrow();
  });
});
