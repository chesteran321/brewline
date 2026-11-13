import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { CfnOutput, CustomResource, Duration, RemovalPolicy, Stack, StackProps, Validations } from 'aws-cdk-lib';
import { AccessLogFormat } from 'aws-cdk-lib/aws-apigateway';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { SCOPES } from '../../../../services/identity/src/scopes';
import { LambdaGuardrailsChecker } from '../aspects/lambda-guardrails';
import { ApiSettings, EnvName, LambdaSettings } from '../config';
import { BrewlineFunction, SERVICES_ROOT } from '../constructs/brewline-function';
import { OrderTimeoutWorkflow } from '../constructs/order-timeout-workflow';
import { TenantAccessRole } from '../constructs/tenant-access-role';
import { EventsStack } from './events-stack';
import { AuthStack } from './auth-stack';
import { DataStack } from './data-stack';

export interface ApiStackProps extends StackProps {
  readonly envName: EnvName;
  readonly api: ApiSettings;
  readonly lambda: LambdaSettings;
  /** Commit SHA：讓 smoke test 每次部署都執行 / Makes the smoke test run on every deploy. */
  readonly commitSha: string;
}

/** Smoke test 使用的商品（必須存在於 seed/products.json）/ Product used by the smoke test. */
const SMOKE_PRODUCT_ID = 'p-0001';
/** Smoke test 下單用的 Dev 測試商品（seed/test-products.json）/ Dev test product the smoke test orders. */
const SMOKE_ORDER_PRODUCT_ID = 'p-9002';
/** Smoke test 的固定測試租戶（services/ordering/src/custom-resources/smoke-test.ts）/ Fixed smoke-test tenants. */
const SMOKE_TENANTS = ['t_01SMKTEST000000000000000A1', 't_01SMKTEST000000000000000B1'];
/** 訂單測試（A2b-2）的商品與租戶（services/ordering/src/order-tests/run.ts）/ Order-test fixtures. */
const ORDER_TEST_PRODUCT_ID = 'p-9001';
const ORDER_TEST_TENANTS = ['t_01CNCRTST000000000000000A1', 't_01CNCRTST000000000000000B1'];

/**
 * 訂貨 API（A1：商品唯讀；A2：訂單，ADR-025）。HTTP API ＋ Cognito JWT authorizer，以 scope 授權（ADR-021、ADR-022）。
 * Ordering API (A1: read-only catalog). HTTP API with a Cognito JWT authorizer and scope-based authorization.
 *
 * 不掛 WAF（ADR-020）：錢包阻斷防護靠 JWT（未登入在 Gateway 擋下）、stage 限流、Lambda 保留併發、
 * DynamoDB 最大吞吐量與 Budget Actions。
 * No WAF (ADR-020): Denial-of-Wallet protection comes from JWT, stage throttling, reserved concurrency,
 * DynamoDB max throughput and Budget Actions.
 *
 * 共用資料層與身分層一律由 SSM 取得（部署時解析），不用 CloudFormation Export。
 * Data and identity layers are read from SSM at deploy time, never via CloudFormation exports.
 */
export class ApiStack extends Stack {
  public readonly httpApi: apigwv2.HttpApi;
  public readonly orderTimeout: OrderTimeoutWorkflow;
  public readonly tenantAccess: TenantAccessRole;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    const { envName } = props;

    // --- 1) 從 SSM 取得共用資源 / Shared resources from SSM ---
    const param = (name: string) => ssm.StringParameter.valueForStringParameter(this, name);
    const dataPrefix = DataStack.parameterPrefix(envName);
    const authPrefix = AuthStack.parameterPrefix(envName);
    const tableName = param(`${dataPrefix}/table-name`);
    const tableArn = param(`${dataPrefix}/table-arn`);
    const keyArn = param(`${dataPrefix}/kms-key-arn`);
    const issuer = param(`${authPrefix}/issuer`);
    const webClientId = param(`${authPrefix}/web-client-id`);
    const smokeClientId = props.api.smokeTest ? param(`${authPrefix}/smoke-test-client-id`) : undefined;
    const gsi1Arn = `${tableArn}/index/${DataStack.GSI1.indexName}`;

    // --- 2) IAM 片段 / IAM building blocks ---
    // ⚠️ ForAllValues 遇到「沒有 LeadingKeys」（例如 Scan）會判定為 true → 絕不授予 Scan，並明確 Deny。
    // ForAllValues is true when the key set is empty (e.g. Scan) → never grant Scan, and deny it explicitly.
    const productKeysOnly = { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['PRODUCT#*'] } };
    const catalogIndexOnly = { 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': ['CATALOG'] } };
    const denyScan = new iam.PolicyStatement({
      sid: 'DenyScan',
      effect: iam.Effect.DENY,
      actions: ['dynamodb:Scan'],
      resources: [tableArn, `${tableArn}/index/*`],
    });
    // 只能經由 DynamoDB 使用金鑰 / The key is usable only through DynamoDB.
    const kmsViaDynamo = (actions: string[]) =>
      new iam.PolicyStatement({
        actions,
        resources: [keyArn],
        conditions: { StringEquals: { 'kms:ViaService': `dynamodb.${this.region}.amazonaws.com` } },
      });
    const tableEnv = { TABLE_NAME: tableName, GSI1_NAME: DataStack.GSI1.indexName };

    // 租戶存取角色（A2a，ADR-024）：A2b 的訂單函數以 session tag 扮演，只能碰自己的 TENANT#。
    // Tenant access role: A2b order functions assume it with a session tag and reach only their own TENANT#.
    this.tenantAccess = new TenantAccessRole(this, 'TenantAccess', { envName, tableArn, keyArn });

    const fn = (fid: string, name: string, entry: string, description: string, statements: iam.PolicyStatement[]) => {
      const f = new BrewlineFunction(this, fid, {
        envName,
        lambda: props.lambda,
        module: 'ordering',
        name,
        entry,
        description,
        reservedConcurrency: props.lambda.reservedConcurrency.api,
        environment: { ...tableEnv, POWERTOOLS_SERVICE_NAME: `ordering-${name}`, POWERTOOLS_TRACER_CAPTURE_RESPONSE: 'false' },
      });
      for (const s of [...statements, denyScan, kmsViaDynamo(['kms:Decrypt'])]) f.role.addToPolicy(s);
      return f;
    };

    // --- 3) Lambda（每個路由一個函數、一個角色，SEC-013）/ One function and role per route ---
    const listProducts = fn('ListProducts', 'list-products', 'ordering/src/handlers/list-products.ts',
      'GET /products: active catalog with stock status', [
        new iam.PolicyStatement({ sid: 'QueryCatalogIndex', actions: ['dynamodb:Query'], resources: [gsi1Arn], conditions: catalogIndexOnly }),
        new iam.PolicyStatement({ sid: 'BatchGetStock', actions: ['dynamodb:BatchGetItem'], resources: [tableArn], conditions: productKeysOnly }),
      ]);
    const getProduct = fn('GetProduct', 'get-product', 'ordering/src/handlers/get-product.ts',
      'GET /products/{id}: product detail with stock status', [
        new iam.PolicyStatement({ sid: 'QueryProduct', actions: ['dynamodb:Query'], resources: [tableArn], conditions: productKeysOnly }),
      ]);
    const getStock = fn('GetProductStock', 'get-product-stock', 'ordering/src/handlers/get-product-stock.ts',
      'GET /admin/products/{id}/stock: stock detail for staff', [
        new iam.PolicyStatement({ sid: 'GetStock', actions: ['dynamodb:GetItem'], resources: [tableArn], conditions: productKeysOnly }),
      ]);

    // --- 3b) 訂單函數（A2，ADR-024／025）/ Order functions ---
    // 角色名稱必須是 brewline-<env>-orders-*（租戶角色的信任政策）。函數角色本身**沒有任何 DynamoDB／KMS 權限**，
    // 只能扮演租戶角色取得 TENANT#<自己> 範圍的憑證。
    // Role names must match brewline-<env>-orders-* (the tenant role's trust policy). The function roles have NO
    // DynamoDB/KMS permissions; they can only assume the tenant role for TENANT#<own>-scoped credentials.
    const orderFn = (fid: string, name: string, roleSuffix: string, description: string) => {
      const f = new BrewlineFunction(this, fid, {
        envName,
        lambda: props.lambda,
        module: 'ordering',
        name,
        entry: `ordering/src/handlers/${name}.ts`,
        description,
        reservedConcurrency: props.lambda.reservedConcurrency.api,
        roleName: `${TenantAccessRole.callerRolePrefix(envName)}${roleSuffix}`,
        environment: {
          TABLE_NAME: tableName,
          TENANT_ROLE_ARN: this.tenantAccess.role.roleArn,
          POWERTOOLS_SERVICE_NAME: `ordering-${name}`,
          POWERTOOLS_TRACER_CAPTURE_RESPONSE: 'false',
        },
      });
      this.tenantAccess.grantAssume(f.role);
      return f;
    };
    const createOrder = orderFn('CreateOrder', 'create-order', 'create',
      'POST /orders: idempotent order, reserves stock in one transaction (tenant-scoped credentials)');
    const listOrders = orderFn('ListOrders', 'list-orders', 'list', "GET /orders: own tenant's orders, newest first");
    const getOrder = orderFn('GetOrder', 'get-order', 'get', "GET /orders/{id}: own tenant's order");

    // --- 3c) staff 訂單函數（A3c，ADR-027）/ Staff order functions ---
    // 跨租戶，但**不扮演租戶角色**（角色名稱由 CloudFormation 產生，不符合 orders-*，信任政策不接受）。
    // Cross-tenant, but they never assume the tenant role (generated role names do not match orders-*).
    const tenantKeys = { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['TENANT#*'] } };
    const statusIndexOnly = { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['STATUS#*'] } };
    const adminList = fn('AdminListOrders', 'admin-list-orders', 'ordering/src/handlers/admin-list-orders.ts',
      'GET /admin/orders?status=: all tenants, by status (GSI1)', [
        new iam.PolicyStatement({ sid: 'QueryStatusIndex', actions: ['dynamodb:Query'], resources: [gsi1Arn], conditions: statusIndexOnly }),
      ]);
    const adminGet = fn('AdminGetOrder', 'admin-get-order', 'ordering/src/handlers/admin-get-order.ts',
      'GET /admin/tenants/{tenantId}/orders/{orderId}: order detail with history', [
        new iam.PolicyStatement({ sid: 'GetTenantOrder', actions: ['dynamodb:GetItem'], resources: [tableArn], conditions: tenantKeys }),
      ]);
    const adminUpdate = fn('AdminUpdateOrder', 'admin-update-order', 'ordering/src/handlers/admin-update-order.ts',
      'PATCH /admin/tenants/{tenantId}/orders/{orderId}: status transition + stock in one transaction', [
        new iam.PolicyStatement({
          sid: 'TransitionTenantOrder',
          actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
          resources: [tableArn],
          conditions: tenantKeys,
        }),
        // 商品只能動庫存欄位（與租戶角色相同）→ 改不了價格 / Stock attributes only, like the tenant role.
        new iam.PolicyStatement({
          sid: 'AdjustStockOnly',
          actions: ['dynamodb:UpdateItem'],
          resources: [tableArn],
          conditions: {
            ...productKeysOnly,
            'ForAllValues:StringEquals': {
              'dynamodb:Attributes': ['pk', 'sk', 'available_kg', 'reserved_kg', 'version', 'updated_at'],
            },
            StringEqualsIfExists: { 'dynamodb:ReturnValues': ['NONE', 'UPDATED_NEW', 'UPDATED_OLD'] },
          },
        }),
        kmsViaDynamo(['kms:Encrypt', 'kms:GenerateDataKey']),
      ]);

    // --- 4) HTTP API ---
    this.httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: `brewline-${envName}-api`,
      description: 'BrewLine ordering API (catalog + orders)',
      createDefaultStage: false,
      // A1 沒有前端 → 不開 CORS；之後經 CloudFront 同網域也不需要 / No CORS in A1.
    });

    const accessLogs = new logs.LogGroup(this, 'AccessLogs', {
      logGroupName: `/aws/apigateway/brewline-${envName}-api`,
      retention: props.lambda.logRetentionDays as logs.RetentionDays,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const stage = new apigwv2.HttpStage(this, 'DefaultStage', {
      httpApi: this.httpApi,
      stageName: '$default',
      autoDeploy: true,
      throttle: { rateLimit: props.api.throttleRateLimit, burstLimit: props.api.throttleBurstLimit },
      accessLogSettings: {
        destination: new apigwv2.LogGroupLogDestination(accessLogs),
        // 不記錄 token 或 query string（可能含個資）/ Never log tokens or query strings.
        format: AccessLogFormat.custom(
          JSON.stringify({
            requestId: '$context.requestId',
            time: '$context.requestTime',
            ip: '$context.identity.sourceIp',
            method: '$context.httpMethod',
            route: '$context.routeKey',
            status: '$context.status',
            latencyMs: '$context.responseLatency',
            integrationStatus: '$context.integrationStatus',
            authError: '$context.authorizer.error',
            sub: '$context.authorizer.claims.sub',
          }),
        ),
      },
    });

    // access token 帶 client_id（不是 aud）；JWT authorizer 比對 aud 或 client_id 是否在清單內。
    // Access tokens carry client_id (not aud); the authorizer accepts either claim from this list.
    const authorizer = new HttpJwtAuthorizer('CognitoJwt', issuer, {
      authorizerName: 'cognito-jwt',
      jwtAudience: smokeClientId ? [webClientId, smokeClientId] : [webClientId],
      identitySource: ['$request.header.Authorization'],
    });

    const routes: Array<[apigwv2.HttpMethod, string, BrewlineFunction, string]> = [
      [apigwv2.HttpMethod.GET, '/products', listProducts, SCOPES.catalogRead],
      [apigwv2.HttpMethod.GET, '/products/{id}', getProduct, SCOPES.catalogRead],
      [apigwv2.HttpMethod.GET, '/admin/products/{id}/stock', getStock, SCOPES.admin],
      [apigwv2.HttpMethod.POST, '/orders', createOrder, SCOPES.ordersWrite],
      [apigwv2.HttpMethod.GET, '/orders', listOrders, SCOPES.ordersRead],
      [apigwv2.HttpMethod.GET, '/orders/{id}', getOrder, SCOPES.ordersRead],
      [apigwv2.HttpMethod.GET, '/admin/orders', adminList, SCOPES.admin],
      [apigwv2.HttpMethod.GET, '/admin/tenants/{tenantId}/orders/{orderId}', adminGet, SCOPES.admin],
      [apigwv2.HttpMethod.PATCH, '/admin/tenants/{tenantId}/orders/{orderId}', adminUpdate, SCOPES.admin],
    ];
    const routeConstructs: Construct[] = [];
    for (const [method, routePath, f, scope] of routes) {
      routeConstructs.push(
        ...this.httpApi.addRoutes({
          path: routePath,
          methods: [method],
          integration: new HttpLambdaIntegration(`${f.node.id}Integration`, f.function),
          authorizer,
          authorizationScopes: [scope],
        }),
      );
    }

    // POST /orders 的路由限流（比 stage 預設更嚴；A2 決策 D3）。route key 必須已存在 → stage 依賴路由。
    // Route-level throttle for POST /orders (stricter than the stage default). The route must exist first.
    const cfnStage = stage.node.defaultChild as apigwv2.CfnStage;
    // RouteSettings 是 Json 型別：CDK 不會轉換鍵名 → 必須直接用 CloudFormation 的 PascalCase。
    // RouteSettings is typed as Json, so CDK passes keys through as-is: use CloudFormation's PascalCase.
    cfnStage.routeSettings = {
      'POST /orders': {
        ThrottlingRateLimit: props.api.orderThrottleRateLimit,
        ThrottlingBurstLimit: props.api.orderThrottleBurstLimit,
      },
    };
    stage.node.addDependency(...routeConstructs);

    // --- 5) 商品目錄種子 / Catalog seed ---
    const seedFn = new BrewlineFunction(this, 'SeedCatalog', {
      envName,
      lambda: props.lambda,
      module: 'ordering',
      name: 'seed-catalog',
      entry: 'ordering/src/custom-resources/seed-catalog.ts',
      description: 'Deploy-time catalog seed: upsert META, create STOCK only if absent',
      reservedConcurrency: props.lambda.reservedConcurrency.customResource,
      timeout: Duration.seconds(60),
      environment: { POWERTOOLS_SERVICE_NAME: 'ordering-seed-catalog' },
    });
    seedFn.role.addToPolicy(
      new iam.PolicyStatement({ sid: 'PutCatalogItems', actions: ['dynamodb:PutItem'], resources: [tableArn], conditions: productKeysOnly }),
    );
    seedFn.role.addToPolicy(denyScan);
    seedFn.role.addToPolicy(kmsViaDynamo(['kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKey']));
    const seedFile = readFileSync(path.join(SERVICES_ROOT, 'ordering', 'seed', 'products.json'));
    const seed = new CustomResource(this, 'CatalogSeed', {
      serviceToken: this.provider('SeedProvider', seedFn).serviceToken,
      resourceType: 'Custom::BrewlineCatalogSeed',
      properties: {
        TableName: tableName,
        // Dev 才寫入隱藏的測試商品 p-9xxx（ADR-025）/ Hidden p-9xxx test products in Dev only.
        IncludeTestProducts: String(props.api.testProducts),
        // 種子檔變更時才觸發 Update / Update only when the seed file changes.
        SeedHash: createHash('sha256')
          .update(seedFile)
          .update(props.api.testProducts ? readFileSync(path.join(SERVICES_ROOT, 'ordering', 'seed', 'test-products.json')) : '')
          .digest('hex'),
      },
    });
    new CfnOutput(this, 'SeededProducts', { value: seed.getAttString('Products') });

    // --- 6) Dev smoke test ---
    if (props.api.smokeTest && smokeClientId) {
      const userPoolArn = param(`${authPrefix}/user-pool-arn`);
      const smokeFn = new BrewlineFunction(this, 'SmokeTest', {
        envName,
        lambda: props.lambda,
        module: 'ordering',
        name: 'smoke-a1',
        entry: 'ordering/src/custom-resources/smoke-test.ts',
        description: 'Dev-only smoke test: throwaway users call the real API on every deploy',
        reservedConcurrency: props.lambda.reservedConcurrency.customResource,
        timeout: Duration.seconds(180),
        environment: { POWERTOOLS_SERVICE_NAME: 'ordering-smoke-a1' },
      });
      smokeFn.role.addToPolicy(
        new iam.PolicyStatement({
          sid: 'ManageThrowawayUsers',
          actions: [
            'cognito-idp:AdminCreateUser',
            'cognito-idp:AdminSetUserPassword',
            'cognito-idp:AdminAddUserToGroup',
            'cognito-idp:AdminInitiateAuth',
            'cognito-idp:AdminDeleteUser',
            'cognito-idp:ListUsers',
          ],
          resources: [userPoolArn],
        }),
      );
      // 測試夾具：重設 Dev 測試商品庫存、刪除固定測試租戶的項目（key 完全比對，不能碰其他資料）
      // Fixture: reset the Dev test product's stock and delete the fixed test tenants' items (exact keys only).
      smokeFn.role.addToPolicy(
        new iam.PolicyStatement({
          sid: 'ResetTestProductStock',
          actions: ['dynamodb:PutItem'],
          resources: [tableArn],
          conditions: { 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': [`PRODUCT#${SMOKE_ORDER_PRODUCT_ID}`] } },
        }),
      );
      smokeFn.role.addToPolicy(
        new iam.PolicyStatement({
          sid: 'CleanTestTenants',
          actions: ['dynamodb:Query', 'dynamodb:DeleteItem'],
          resources: [tableArn],
          conditions: { 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': SMOKE_TENANTS.map((t) => `TENANT#${t}`) } },
        }),
      );
      smokeFn.role.addToPolicy(denyScan);
      smokeFn.role.addToPolicy(kmsViaDynamo(['kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKey']));
      const smoke = new CustomResource(this, 'SmokeTestRun', {
        serviceToken: this.provider('SmokeProvider', smokeFn).serviceToken,
        resourceType: 'Custom::BrewlineSmokeTest',
        properties: {
          ApiUrl: this.httpApi.apiEndpoint,
          UserPoolId: param(`${authPrefix}/user-pool-id`),
          ClientId: smokeClientId,
          ProductId: SMOKE_PRODUCT_ID,
          OrderProductId: SMOKE_ORDER_PRODUCT_ID,
          TableName: tableName,
          Commit: props.commitSha, // 每次部署都不同 → 每次都執行 / changes every deploy → always runs
        },
      });
      // 路由、stage、種子都就緒後才測 / Run only after routes, stage and seed exist.
      smoke.node.addDependency(stage, seed, ...routeConstructs);
      new CfnOutput(this, 'SmokeTestSummary', { value: smoke.getAttString('Summary') });
    }

    // --- 6b) 未確認訂單的逾時取消（A3d，ADR-028）/ Unconfirmed-order timeout ---
    this.orderTimeout = new OrderTimeoutWorkflow(this, 'OrderTimeout', {
      envName,
      lambda: props.lambda,
      tableName,
      tableArn,
      keyArn,
      gsi1Name: DataStack.GSI1.indexName,
      busName: param(`${EventsStack.parameterPrefix(envName)}/bus-name`),
      timeoutSeconds: props.api.orderTimeoutSeconds,
    });
    // smoke test 下的單要能啟動工作流 → 先建好規則與狀態機 / Smoke-test orders must reach the workflow.
    this.node.tryFindChild('SmokeTestRun')?.node.addDependency(this.orderTimeout);
    new CfnOutput(this, 'OrderLifecycleStateMachineArn', { value: this.orderTimeout.stateMachine.stateMachineArn });
    new CfnOutput(this, 'OrderTimeoutDlqUrl', { value: this.orderTimeout.dlq.queueUrl });

    // --- 7) Dev 訂單測試（手動觸發，A2b-2）/ Dev order tests (manual) ---
    if (props.api.orderTests) {
      if (!props.api.testProducts) throw new Error('api.orderTests requires api.testProducts');
      // 角色名稱符合 brewline-<env>-orders-* → 可以扮演租戶角色（真實憑證的 IAM 探測需要）
      // The role name matches brewline-<env>-orders-*, so it can assume the tenant role for the IAM probe.
      const testFn = new BrewlineFunction(this, 'OrderTests', {
        envName,
        lambda: props.lambda,
        module: 'ordering',
        name: 'order-tests',
        entry: 'ordering/src/order-tests/run.ts',
        description: 'Dev-only, manual: idempotency storm, stock race (no overselling), IAM probe with tenant credentials',
        reservedConcurrency: 1,
        memorySize: 512,
        timeout: Duration.minutes(2),
        roleName: `${TenantAccessRole.callerRolePrefix(envName)}tests`,
        environment: {
          TABLE_NAME: tableName,
          TENANT_ROLE_ARN: this.tenantAccess.role.roleArn,
          POWERTOOLS_SERVICE_NAME: 'ordering-order-tests',
          ORDER_TIMEOUT_SECONDS: String(props.api.orderTimeoutSeconds),
        },
      });
      this.tenantAccess.grantAssume(testFn.role);
      // 夾具權限：只限測試商品 p-9001 與兩個固定測試租戶（完全比對）
      // Fixture permissions: the p-9001 test product and two fixed test tenants only (exact keys).
      testFn.role.addToPolicy(
        new iam.PolicyStatement({
          sid: 'ResetRaceProduct',
          actions: ['dynamodb:PutItem', 'dynamodb:GetItem', 'dynamodb:UpdateItem'],
          resources: [tableArn],
          conditions: { 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': [`PRODUCT#${ORDER_TEST_PRODUCT_ID}`] } },
        }),
      );
      testFn.role.addToPolicy(
        new iam.PolicyStatement({
          sid: 'CleanTestTenants',
          // GetItem／UpdateItem：逾時測試以 staff 邏輯確認測試訂單（A3d）/ The timeout test confirms a test order.
          actions: ['dynamodb:Query', 'dynamodb:DeleteItem', 'dynamodb:GetItem', 'dynamodb:UpdateItem'],
          resources: [tableArn],
          conditions: { 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': ORDER_TEST_TENANTS.map((t) => `TENANT#${t}`) } },
        }),
      );
      testFn.role.addToPolicy(denyScan);
      testFn.role.addToPolicy(kmsViaDynamo(['kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKey']));
      new CfnOutput(this, 'OrderTestsFunctionName', { value: testFn.function.functionName });
    }

    new CfnOutput(this, 'ApiUrl', { value: this.httpApi.apiEndpoint });
    new CfnOutput(this, 'TenantAccessRoleArn', { value: this.tenantAccess.role.roleArn });
    new CfnOutput(this, 'ApiId', { value: this.httpApi.apiId });
    new CfnOutput(this, 'FunctionNames', {
      value: [listProducts, getProduct, getStock, createOrder, listOrders, getOrder, adminList, adminGet, adminUpdate]
        .map((f) => f.function.functionName)
        .join(','),
    });
  }

  /**
   * CDK Provider framework（處理 CloudFormation 回應、逾時與重試）。框架函數由 CDK 產生，
   * 我們提供自己的角色（日誌權限限定 log group，不用 AWS 託管政策）並明確豁免 Lambda 標準檢查。
   * CDK Provider framework (handles CloudFormation responses, timeouts and retries). We supply its role
   * (log permissions scoped to its log group, no AWS managed policy) and exempt it from the Lambda standard.
   */
  private provider(pid: string, onEvent: BrewlineFunction): cr.Provider {
    const logGroup = new logs.LogGroup(this, `${pid}Logs`, {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const role = new iam.Role(this, `${pid}Role`, {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: `CDK provider framework role for ${onEvent.function.node.path}`,
    });
    role.addToPolicy(
      new iam.PolicyStatement({ actions: ['logs:CreateLogStream', 'logs:PutLogEvents'], resources: [logGroup.logGroupArn] }),
    );
    const provider = new cr.Provider(this, pid, {
      onEventHandler: onEvent.function,
      frameworkOnEventRole: role,
      logGroup,
    });
    LambdaGuardrailsChecker.exempt(
      provider,
      'CDK provider framework function: runtime/architecture are chosen by CDK; it runs only during deployments.',
    );
    Validations.of(role).acknowledge({
      id: `AwsSolutions-IAM5[Resource::<${Stack.of(this).getLogicalId(onEvent.function.node.defaultChild as never)}.Arn>:*]`,
      reason: 'grantInvoke adds "<function ARN>:*" so the framework can invoke any version/alias of its own handler only.',
    });
    return provider;
  }
}
