import * as path from 'node:path';
import { Duration, RemovalPolicy, Validations } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { EnvName, LambdaSettings } from '../config';

/** Lambda 程式碼所在的 package（repo 根目錄的 services/）/ Package holding the Lambda code. */
export const SERVICES_ROOT = path.join(__dirname, '..', '..', '..', '..', 'services');

export interface BrewlineFunctionProps {
  readonly envName: EnvName;
  readonly lambda: LambdaSettings;
  /** 模組名，用於函數名稱 / Module name, used in the function name (e.g. "identity"). */
  readonly module: string;
  /** 函數短名 / Short name → brewline-<env>-<module>-<name>. */
  readonly name: string;
  /** 相對 services/ 的進入點 / Entry point relative to services/ (e.g. "identity/src/pre-token-generation.ts"). */
  readonly entry: string;
  readonly description: string;
  readonly reservedConcurrency: number;
  /** 預設 256 MB（docs/09 §2.2）/ Default 256 MB. */
  readonly memorySize?: number;
  /** 預設 10 秒（API 函數）/ Default 10 s (API functions). */
  readonly timeout?: Duration;
  readonly environment?: Record<string, string>;
  /**
   * 固定的 IAM 角色名稱（例如訂單函數必須是 brewline-<env>-orders-*，ADR-024）；預設由 CloudFormation 產生。
   * Fixed role name (order functions must be brewline-<env>-orders-*); CloudFormation generates one by default.
   */
  readonly roleName?: string;
}

/**
 * BrewLine 的 Lambda 標準（docs/09 §2.2、ADR-023）。所有自己寫的函數都用這個 construct 建立，
 * `LambdaGuardrailsChecker` 會在 synth 時檢查結果。
 * The BrewLine Lambda standard; every first-party function is built with this construct and
 * `LambdaGuardrailsChecker` verifies the result at synth time.
 *
 * - Node.js 24、arm64、X-Ray Active、JSON 日誌 / Node.js 24, arm64, X-Ray active, JSON logs
 * - 專屬 IAM 角色（SEC-013），日誌權限只限自己的 log group，不用 AWSLambdaBasicExecutionRole
 *   Dedicated role; log permissions scoped to its own log group (no AWSLambdaBasicExecutionRole)
 * - 自建 log group 並設定保留期（COST-007）/ Explicit log group with retention
 * - esbuild 本機打包成 ESM，AWS SDK 一起打包以鎖定版本（runtime 內建 SDK 的版本依區域而異）
 *   Local esbuild ESM bundle; the AWS SDK is bundled to pin its version
 */
export class BrewlineFunction extends Construct {
  public readonly function: NodejsFunction;
  public readonly role: iam.Role;
  public readonly logGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: BrewlineFunctionProps) {
    super(scope, id);

    const functionName = `brewline-${props.envName}-${props.module}-${props.name}`;

    this.logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: `/aws/lambda/${functionName}`,
      retention: props.lambda.logRetentionDays as logs.RetentionDays,
      // 日誌不是要長期保存的資料；刪除 stack 時一併刪除 / Logs are not records; delete with the stack.
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.role = new iam.Role(this, 'Role', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: `Execution role for ${functionName}`,
      roleName: props.roleName,
    });
    // 只能寫自己的 log group / Write only to its own log group.
    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [this.logGroup.logGroupArn],
      }),
    );

    this.function = new NodejsFunction(this, 'Function', {
      functionName,
      description: props.description,
      entry: path.join(SERVICES_ROOT, props.entry),
      handler: 'handler',
      projectRoot: SERVICES_ROOT,
      depsLockFilePath: path.join(SERVICES_ROOT, 'package-lock.json'),
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: props.memorySize ?? 256,
      timeout: props.timeout ?? Duration.seconds(10),
      reservedConcurrentExecutions: props.reservedConcurrency,
      tracing: lambda.Tracing.ACTIVE,
      role: this.role,
      logGroup: this.logGroup,
      loggingFormat: lambda.LoggingFormat.JSON,
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
        POWERTOOLS_LOG_LEVEL: 'INFO',
        ...props.environment,
      },
      bundling: {
        format: OutputFormat.ESM,
        target: 'node24',
        minify: true,
        sourceMap: true,
        sourcesContent: false,
        mainFields: ['module', 'main'],
        // 部分相依套件仍是 CommonJS，ESM bundle 需要 require / Some deps are CommonJS; give the ESM bundle a require().
        banner: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
        externalModules: [],
      },
    });

    // X-Ray 的 PutTraceSegments／PutTelemetryRecords 不支援資源層級權限，CDK 只能給 Resource "*"。
    // X-Ray write actions do not support resource-level permissions, so CDK grants Resource "*".
    Validations.of(this.role).acknowledge({
      id: 'AwsSolutions-IAM5[Resource::*]',
      reason:
        'X-Ray xray:PutTraceSegments / xray:PutTelemetryRecords do not support resource-level permissions (added by Tracing.ACTIVE).',
    });
  }
}
