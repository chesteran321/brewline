import { App, Stack, Tags, Validations } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpUrlIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { AwsSolutionsChecks } from 'cdk-nag';
import { ApiGuardrailsChecker } from '../lib/aspects/api-guardrails';
import { LambdaGuardrailsChecker } from '../lib/aspects/lambda-guardrails';
import { applyStandardTags, RequiredTagsChecker } from '../lib/aspects/required-tags';
import { ENVIRONMENTS, EnvName } from '../lib/config';
import { ApiStack } from '../lib/stacks/api-stack';

function buildApp(envName: EnvName) {
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const env = ENVIRONMENTS[envName];
  const stack = new ApiStack(app, `brewline-${envName}-api`, {
    envName,
    api: env.api,
    lambda: env.lambda,
    commitSha: 'abc1234',
    env: { account: env.account, region: env.region },
  });
  Tags.of(stack).add('module', 'ordering', { priority: 200 });
  applyStandardTags(app, { env: envName, module: 'platform' });
  RequiredTagsChecker.attach(app);
  LambdaGuardrailsChecker.attach(app);
  ApiGuardrailsChecker.attach(app);
  Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
  return { app, stack, template: Template.fromStack(stack) };
}

type Res = { Properties: Record<string, any>; DependsOn?: string[] };
const resources = (t: Template, type: string) => Object.entries(t.findResources(type)) as Array<[string, Res]>;

/** 找出附在某個 Lambda 角色上的所有 statement / All statements attached to a function's role. */
function statementsFor(t: Template, fnName: string): any[] {
  const fns = resources(t, 'AWS::Lambda::Function').filter(([, r]) => r.Properties.FunctionName === fnName);
  expect(fns).toHaveLength(1);
  const roleId = fns[0]![1].Properties.Role['Fn::GetAtt'][0];
  return resources(t, 'AWS::IAM::Policy')
    .filter(([, p]) => p.Properties.Roles.some((r: any) => r.Ref === roleId))
    .flatMap(([, p]) => p.Properties.PolicyDocument.Statement);
}

describe.each(['dev', 'prod'] as const)('ApiStack (%s)', (envName) => {
  const { app, stack, template } = buildApp(envName);
  const cfg = ENVIRONMENTS[envName];

  test('HTTP API with nine routes, all JWT + scope', () => {
    template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
    const routes = Object.fromEntries(resources(template, 'AWS::ApiGatewayV2::Route').map(([, r]) => [r.Properties.RouteKey, r.Properties]));
    expect(Object.keys(routes).sort()).toEqual([
      'GET /admin/orders', 'GET /admin/products/{id}/stock', 'GET /admin/tenants/{tenantId}/orders/{orderId}',
      'GET /orders', 'GET /orders/{id}', 'GET /products', 'GET /products/{id}',
      'PATCH /admin/tenants/{tenantId}/orders/{orderId}', 'POST /orders',
    ]);
    // staff 端點只接受 admin scope / Staff endpoints need the admin scope.
    for (const k of ['GET /admin/orders', 'GET /admin/tenants/{tenantId}/orders/{orderId}', 'PATCH /admin/tenants/{tenantId}/orders/{orderId}']) {
      expect(routes[k]).toMatchObject({ AuthorizationType: 'JWT', AuthorizationScopes: ['brewline/admin'] });
    }
    expect(routes['POST /orders']).toMatchObject({ AuthorizationType: 'JWT', AuthorizationScopes: ['brewline/orders.write'] });
    expect(routes['GET /orders']).toMatchObject({ AuthorizationType: 'JWT', AuthorizationScopes: ['brewline/orders.read'] });
    expect(routes['GET /orders/{id}']).toMatchObject({ AuthorizationType: 'JWT', AuthorizationScopes: ['brewline/orders.read'] });
    expect(routes['GET /products']).toMatchObject({ AuthorizationType: 'JWT', AuthorizationScopes: ['brewline/catalog.read'] });
    expect(routes['GET /products/{id}']).toMatchObject({ AuthorizationType: 'JWT', AuthorizationScopes: ['brewline/catalog.read'] });
    // 反向：admin 路由只接受 admin scope（cafe 只有 catalog.read）/ Negative: admin needs the admin scope.
    expect(routes['GET /admin/products/{id}/stock']).toMatchObject({ AuthorizationType: 'JWT', AuthorizationScopes: ['brewline/admin'] });
  });

  test('JWT authorizer reads issuer and audience from SSM; smoke client only in Dev', () => {
    const [[, a]] = resources(template, 'AWS::ApiGatewayV2::Authorizer') as [[string, Res]];
    expect(a.Properties.AuthorizerType).toBe('JWT');
    expect(a.Properties.JwtConfiguration.Audience).toHaveLength(cfg.api.smokeTest ? 2 : 1);
    const params = Object.keys(template.toJSON().Parameters);
    expect(params.some((p) => p.includes(`brewline${envName}authissuer`))).toBe(true);
    expect(params.some((p) => p.includes('smoketestclientid'))).toBe(cfg.api.smokeTest);
  });

  test('stage: $default, throttling, JSON access logs with retention', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      StageName: '$default',
      AutoDeploy: true,
      DefaultRouteSettings: { ThrottlingRateLimit: cfg.api.throttleRateLimit, ThrottlingBurstLimit: cfg.api.throttleBurstLimit },
      AccessLogSettings: { DestinationArn: Match.anyValue(), Format: Match.stringLikeRegexp('"status":"\\$context.status"') },
    });
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: `/aws/apigateway/brewline-${envName}-api`,
      RetentionInDays: cfg.lambda.logRetentionDays,
    });
    // POST /orders 另有更嚴的路由限流（D3），stage 依賴該路由 / Stricter route throttle; stage depends on the route.
    const [[, st]] = resources(template, 'AWS::ApiGatewayV2::Stage') as [[string, Res]];
    expect(st.Properties.RouteSettings).toEqual({
      'POST /orders': { ThrottlingRateLimit: cfg.api.orderThrottleRateLimit, ThrottlingBurstLimit: cfg.api.orderThrottleBurstLimit },
    });
    expect(cfg.api.orderThrottleRateLimit).toBeLessThan(cfg.api.throttleRateLimit);
    expect(st.DependsOn!.some((d) => d.startsWith('HttpApiPOSTorders'))).toBe(true);
    // 反向：access log 不可記錄 Authorization 標頭 / Negative: never log the Authorization header.
    const stageFormat = resources(template, 'AWS::ApiGatewayV2::Stage')[0]![1].Properties.AccessLogSettings.Format;
    expect(stageFormat).not.toMatch(/authorization|header/i);
  });

  test('no CORS configuration in A1', () => {
    const [[, api]] = resources(template, 'AWS::ApiGatewayV2::Api') as [[string, Res]];
    expect(api.Properties.CorsConfiguration).toBeUndefined();
  });

  test('read functions: least-privilege DynamoDB, KMS via DynamoDB only, Scan denied', () => {
    const expected: Record<string, string[]> = {
      'list-products': ['dynamodb:Query', 'dynamodb:BatchGetItem'],
      'get-product': ['dynamodb:Query'],
      'get-product-stock': ['dynamodb:GetItem'],
    };
    for (const [name, actions] of Object.entries(expected)) {
      const st = statementsFor(template, `brewline-${envName}-ordering-${name}`);
      const allowDdb = st.filter((s) => s.Effect === 'Allow' && [].concat(s.Action).some((a: string) => a.startsWith('dynamodb:')));
      expect(allowDdb.flatMap((s) => [].concat(s.Action)).sort()).toEqual([...actions].sort());
      // 每個 DynamoDB Allow 都有 LeadingKeys 條件 / Every DynamoDB allow is scoped by LeadingKeys.
      for (const s of allowDdb) {
        expect(JSON.stringify(s.Condition)).toContain('dynamodb:LeadingKeys');
        expect(JSON.stringify(s.Condition)).not.toContain('TENANT#');
      }
      // 反向：沒有任何寫入或 Scan 的 Allow / Negative: no write or Scan allows.
      const allActions = st.filter((s) => s.Effect === 'Allow').flatMap((s) => [].concat(s.Action));
      for (const bad of ['dynamodb:Scan', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:*', 'kms:*']) {
        expect(allActions).not.toContain(bad);
      }
      expect(st).toContainEqual(expect.objectContaining({ Sid: 'DenyScan', Effect: 'Deny', Action: 'dynamodb:Scan' }));
      expect(st).toContainEqual(
        expect.objectContaining({
          Action: 'kms:Decrypt',
          Condition: { StringEquals: { 'kms:ViaService': 'dynamodb.ap-east-2.amazonaws.com' } },
        }),
      );
    }
  });

  test('order functions: fixed orders-* role names, NO DynamoDB/KMS permissions, may only assume the tenant role', () => {
    for (const [name, suffix] of [['create-order', 'create'], ['list-orders', 'list'], ['get-order', 'get']] as const) {
      const fnName = `brewline-${envName}-ordering-${name}`;
      const [[, fn]] = resources(template, 'AWS::Lambda::Function').filter(([, r]) => r.Properties.FunctionName === fnName) as [[string, Res]];
      const roleId = fn.Properties.Role['Fn::GetAtt'][0];
      expect(template.toJSON().Resources[roleId].Properties.RoleName).toBe(`brewline-${envName}-orders-${suffix}`);
      expect(fn.Properties.Environment.Variables.TENANT_ROLE_ARN).toEqual({ 'Fn::GetAtt': [expect.stringContaining('TenantAccess'), 'Arn'] });
      const st = statementsFor(template, fnName);
      const actions = st.filter((s) => s.Effect === 'Allow').flatMap((s) => [].concat(s.Action));
      // 反向：函數本身碰不到資料表與金鑰 / Negative: the function itself cannot touch the table or the key.
      expect(actions.filter((a: string) => a.startsWith('dynamodb:') || a.startsWith('kms:'))).toEqual([]);
      const assume = st.find((s) => [].concat(s.Action).includes('sts:AssumeRole' as never));
      expect([].concat(assume.Action).sort()).toEqual(['sts:AssumeRole', 'sts:TagSession']);
      expect(JSON.stringify(assume.Resource)).toContain('TenantAccess');
    }
  });

  test('staff order functions (A3c): never orders-* roles; tenant keys, status index, stock attributes only', () => {
    for (const name of ['admin-list-orders', 'admin-get-order', 'admin-update-order']) {
      const fnName = `brewline-${envName}-ordering-${name}`;
      const [[, fn]] = resources(template, 'AWS::Lambda::Function').filter(([, r]) => r.Properties.FunctionName === fnName) as [[string, Res]];
      const roleId = fn.Properties.Role['Fn::GetAtt'][0];
      // 反向：角色名稱不是 orders-*（無法扮演租戶角色）/ Negative: cannot assume the tenant role.
      expect(template.toJSON().Resources[roleId].Properties.RoleName).toBeUndefined();
      const st = statementsFor(template, fnName);
      expect(st.flatMap((x) => [].concat(x.Action))).not.toContain('sts:AssumeRole');
      expect(st).toContainEqual(expect.objectContaining({ Sid: 'DenyScan', Effect: 'Deny' }));
    }
    const list = statementsFor(template, `brewline-${envName}-ordering-admin-list-orders`);
    expect(list.find((x) => x.Sid === 'QueryStatusIndex')).toMatchObject({
      Condition: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['STATUS#*'] } },
    });
    const upd = statementsFor(template, `brewline-${envName}-ordering-admin-update-order`);
    expect(upd.find((x) => x.Sid === 'TransitionTenantOrder')).toMatchObject({
      Action: ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
      Condition: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['TENANT#*'] } },
    });
    expect(upd.find((x) => x.Sid === 'AdjustStockOnly').Condition['ForAllValues:StringEquals']['dynamodb:Attributes']).toEqual([
      'pk', 'sk', 'available_kg', 'reserved_kg', 'version', 'updated_at',
    ]);
    // 反向：沒有 Put／Delete／Batch（建不了、刪不了訂單）/ Negative: cannot create or delete items.
    const acts = upd.filter((x) => x.Effect === 'Allow').flatMap((x) => [].concat(x.Action)) as string[];
    expect(acts.filter((a) => /dynamodb:(Put|Delete|Batch)/.test(a))).toEqual([]);
  });

  test('order tests (A2b-2): Dev only, orders-tests role, fixture access limited to exact test keys', () => {
    const fns = resources(template, 'AWS::Lambda::Function').filter(([, r]) => r.Properties.FunctionName === `brewline-${envName}-ordering-order-tests`);
    if (!cfg.api.orderTests) {
      expect(fns).toHaveLength(0);
      expect(template.toJSON().Outputs).not.toHaveProperty('OrderTestsFunctionName');
      return;
    }
    expect(fns).toHaveLength(1);
    const [[, fn]] = fns as [[string, Res]];
    expect(fn.Properties.Timeout).toBe(120);
    const roleId = fn.Properties.Role['Fn::GetAtt'][0];
    expect(template.toJSON().Resources[roleId].Properties.RoleName).toBe(`brewline-${envName}-orders-tests`);
    const st = statementsFor(template, `brewline-${envName}-ordering-order-tests`);
    expect(st.find((x) => x.Sid === 'ResetRaceProduct')).toMatchObject({
      Action: ['dynamodb:PutItem', 'dynamodb:GetItem'],
      Condition: { 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': ['PRODUCT#p-9001'] } },
    });
    expect(st.find((x) => x.Sid === 'CleanTestTenants')).toMatchObject({
      Action: ['dynamodb:Query', 'dynamodb:DeleteItem'],
      Condition: {
        'ForAllValues:StringEquals': {
          'dynamodb:LeadingKeys': ['TENANT#t_01CNCRTST000000000000000A1', 'TENANT#t_01CNCRTST000000000000000B1'],
        },
      },
    });
    expect(st).toContainEqual(expect.objectContaining({ Sid: 'DenyScan', Effect: 'Deny' }));
    // 反向：沒有其他 DynamoDB 允許（只有兩段夾具）/ Negative: no other DynamoDB allows.
    const ddbAllows = st.filter((x) => x.Effect === 'Allow' && [].concat(x.Action).some((a: string) => a.startsWith('dynamodb:')));
    expect(ddbAllows.map((x) => x.Sid).sort()).toEqual(['CleanTestTenants', 'ResetRaceProduct']);
    expect(st.find((x) => [].concat(x.Action).includes('sts:AssumeRole' as never))).toBeDefined();
  });

  test('seed: PutItem on PRODUCT# keys only, never updates STOCK by property', () => {
    const st = statementsFor(template, `brewline-${envName}-ordering-seed-catalog`);
    const ddb = st.filter((s) => s.Effect === 'Allow' && [].concat(s.Action).some((a: string) => a.startsWith('dynamodb:')));
    expect(ddb).toHaveLength(1);
    expect(ddb[0]).toMatchObject({ Action: 'dynamodb:PutItem', Condition: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['PRODUCT#*'] } } });
    template.hasResourceProperties('Custom::BrewlineCatalogSeed', {
      SeedHash: Match.stringLikeRegexp('^[0-9a-f]{64}$'),
      IncludeTestProducts: String(cfg.api.testProducts), // 只有 Dev 寫入 p-9xxx / test products only in Dev
    });
  });

  test(`smoke test ${cfg.api.smokeTest ? 'runs after routes, stage and seed (Dev)' : 'is absent (Prod)'}`, () => {
    const smoke = resources(template, 'Custom::BrewlineSmokeTest');
    expect(smoke).toHaveLength(cfg.api.smokeTest ? 1 : 0);
    const names = resources(template, 'AWS::Lambda::Function').map(([, r]) => r.Properties.FunctionName).filter(Boolean);
    expect(names.includes(`brewline-${envName}-ordering-smoke-a1`)).toBe(cfg.api.smokeTest);
    if (cfg.api.smokeTest) {
      const [, s] = smoke[0]!;
      expect(s.Properties).toMatchObject({ ProductId: 'p-0001', OrderProductId: 'p-9002', Commit: 'abc1234' });
      expect(s.DependsOn).toEqual(expect.arrayContaining(['CatalogSeed']));
      expect(s.DependsOn!.some((d) => d.startsWith('DefaultStage'))).toBe(true);
      expect(s.DependsOn!.filter((d) => /^HttpApi(GET|POST|PATCH)/.test(d) && !d.includes('Integration'))).toHaveLength(9);
      // 只能管理這個 pool 的使用者 / User management limited to this pool.
      const st = statementsFor(template, `brewline-${envName}-ordering-smoke-a1`);
      const cognito = st.find((x) => x.Sid === 'ManageThrowawayUsers');
      expect(cognito.Resource).toEqual({ Ref: expect.stringContaining('authuserpoolarn') });
      // 測試夾具的 DynamoDB 權限只限測試商品與固定測試租戶（完全比對）/ Fixture access: exact test keys only.
      expect(st.find((x) => x.Sid === 'ResetTestProductStock')).toMatchObject({
        Action: 'dynamodb:PutItem',
        Condition: { 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': ['PRODUCT#p-9002'] } },
      });
      expect(st.find((x) => x.Sid === 'CleanTestTenants')).toMatchObject({
        Action: ['dynamodb:Query', 'dynamodb:DeleteItem'],
        Condition: {
          'ForAllValues:StringEquals': {
            'dynamodb:LeadingKeys': ['TENANT#t_01SMKTEST000000000000000A1', 'TENANT#t_01SMKTEST000000000000000B1'],
          },
        },
      });
      expect(st).toContainEqual(expect.objectContaining({ Sid: 'DenyScan', Effect: 'Deny' }));
    }
  });

  test('all first-party Lambdas follow the standard; provider framework functions are explicitly exempt', () => {
    const fns = resources(template, 'AWS::Lambda::Function');
    const ours = fns.filter(([, r]) => String(r.Properties.FunctionName ?? '').startsWith(`brewline-${envName}-`));
    expect(ours).toHaveLength(10 + (cfg.api.smokeTest ? 1 : 0) + (cfg.api.orderTests ? 1 : 0));
    for (const [, r] of ours) {
      expect(r.Properties).toMatchObject({ Runtime: 'nodejs24.x', Architectures: ['arm64'], TracingConfig: { Mode: 'Active' } });
    }
    expect(fns.length - ours.length).toBe(cfg.api.smokeTest ? 2 : 1); // provider framework
  });

  test('no CloudFormation exports', () => {
    const outputs = template.toJSON().Outputs as Record<string, { Export?: unknown }>;
    expect(Object.values(outputs).every((o) => o.Export === undefined)).toBe(true);
  });

  test('no guardrail or tag errors', () => {
    expect(Annotations.fromStack(stack).findError('*', Match.anyValue())).toHaveLength(0);
  });

  test('passes cdk-nag (only the documented acknowledgments)', () => {
    expect(() => app.synth()).not.toThrow();
  });
});

describe('ApiGuardrailsChecker', () => {
  function bare() {
    const app = new App();
    const stack = new Stack(app, 'Bare', { env: { account: '111111111111', region: 'ap-east-2' } });
    ApiGuardrailsChecker.attach(app);
    const api = new apigwv2.HttpApi(stack, 'Api', { createDefaultStage: false });
    return { stack, api };
  }
  const errors = (stack: Stack, pattern: string) =>
    Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp(pattern));
  const integration = () => new HttpUrlIntegration('I', 'https://example.com');
  const jwt = () => new HttpJwtAuthorizer('J', 'https://issuer.example.com', { jwtAudience: ['a'] });

  // 反向 / Negative
  test('errors on a route without an authorizer', () => {
    const { stack, api } = bare();
    api.addRoutes({ path: '/open', methods: [apigwv2.HttpMethod.GET], integration: integration() });
    expect(errors(stack, 'must use the JWT authorizer')).toHaveLength(1);
  });

  test('errors on a JWT route without scopes ("signed in" is not authorization)', () => {
    const { stack, api } = bare();
    api.addRoutes({ path: '/any-user', methods: [apigwv2.HttpMethod.GET], integration: integration(), authorizer: jwt() });
    expect(errors(stack, 'at least one OAuth scope')).toHaveLength(1);
  });

  test('errors on a stage without access logs or throttling', () => {
    const { stack, api } = bare();
    new apigwv2.HttpStage(stack, 'S', { httpApi: api, stageName: '$default' });
    expect(errors(stack, 'access logging')).toHaveLength(1);
    expect(errors(stack, 'default throttling')).toHaveLength(1);
  });

  test('accepts a JWT route with a scope', () => {
    const { stack, api } = bare();
    api.addRoutes({
      path: '/ok',
      methods: [apigwv2.HttpMethod.GET],
      integration: integration(),
      authorizer: jwt(),
      authorizationScopes: ['brewline/catalog.read'],
    });
    expect(errors(stack, 'ApiGuardrails')).toHaveLength(0);
  });
});
