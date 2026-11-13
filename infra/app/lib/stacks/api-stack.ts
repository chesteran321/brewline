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
import { TenantAccessRole } from '../constructs/tenant-access-role';
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

/**
 * 訂貨 API（A1：商品唯讀）。HTTP API ＋ Cognito JWT authorizer，以 scope 授權（ADR-021、ADR-022）。
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

    // --- 4) HTTP API ---
    this.httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: `brewline-${envName}-api`,
      description: 'BrewLine ordering API (A1: read-only catalog)',
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

    const routes: Array<[string, BrewlineFunction, string]> = [
      ['/products', listProducts, SCOPES.catalogRead],
      ['/products/{id}', getProduct, SCOPES.catalogRead],
      ['/admin/products/{id}/stock', getStock, SCOPES.admin],
    ];
    const routeConstructs: Construct[] = [];
    for (const [routePath, f, scope] of routes) {
      routeConstructs.push(
        ...this.httpApi.addRoutes({
          path: routePath,
          methods: [apigwv2.HttpMethod.GET],
          integration: new HttpLambdaIntegration(`${f.node.id}Integration`, f.function),
          authorizer,
          authorizationScopes: [scope],
        }),
      );
    }

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
        // 種子檔變更時才觸發 Update / Update only when the seed file changes.
        SeedHash: createHash('sha256').update(seedFile).digest('hex'),
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
        description: 'Dev-only A1 smoke test: throwaway users call the real API on every deploy',
        reservedConcurrency: props.lambda.reservedConcurrency.customResource,
        timeout: Duration.seconds(120),
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
      const smoke = new CustomResource(this, 'SmokeTestRun', {
        serviceToken: this.provider('SmokeProvider', smokeFn).serviceToken,
        resourceType: 'Custom::BrewlineSmokeTest',
        properties: {
          ApiUrl: this.httpApi.apiEndpoint,
          UserPoolId: param(`${authPrefix}/user-pool-id`),
          ClientId: smokeClientId,
          ProductId: SMOKE_PRODUCT_ID,
          Commit: props.commitSha, // 每次部署都不同 → 每次都執行 / changes every deploy → always runs
        },
      });
      // 路由、stage、種子都就緒後才測 / Run only after routes, stage and seed exist.
      smoke.node.addDependency(stage, seed, ...routeConstructs);
      new CfnOutput(this, 'SmokeTestSummary', { value: smoke.getAttString('Summary') });
    }

    new CfnOutput(this, 'ApiUrl', { value: this.httpApi.apiEndpoint });
    new CfnOutput(this, 'TenantAccessRoleArn', { value: this.tenantAccess.role.roleArn });
    new CfnOutput(this, 'ApiId', { value: this.httpApi.apiId });
    new CfnOutput(this, 'FunctionNames', {
      value: [listProducts, getProduct, getStock].map((f) => f.function.functionName).join(','),
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
