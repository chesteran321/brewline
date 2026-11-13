import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps, Tags, Validations } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { GROUPS, Group } from '../../../../services/identity/src/scopes';
import { AuthSettings, DATA_CLASS_TAG, EnvName, LambdaSettings } from '../config';
import { BrewlineFunction } from '../constructs/brewline-function';

export interface AuthStackProps extends StackProps {
  readonly envName: EnvName;
  readonly auth: AuthSettings;
  readonly lambda: LambdaSettings;
}

/** 群組說明與優先序（數字小者優先）/ Group descriptions and precedence (lower wins). */
const GROUP_SETTINGS: Record<Group, { precedence: number; description: string }> = {
  staff: { precedence: 10, description: 'BrewLine internal staff: all tenants, /admin/* endpoints' },
  simulator: { precedence: 20, description: 'Simulator accounts acting as fictional cafés (ADR-011)' },
  cafe: { precedence: 30, description: 'Café (tenant) users; must carry custom:tenant_id' },
};

/**
 * 身分層：Cognito user pool（Essentials）＋ pre token generation 觸發器（V2）（ADR-022、docs/09 §1.3）。
 * Identity layer: Cognito user pool (Essentials) plus a V2 pre token generation trigger.
 *
 * 與 API stack 分開的原因：user pool 有狀態（使用者帳號無法從程式碼重建），
 * 需要保留與終止保護；API 是無狀態的，可以隨時重建。
 * Kept apart from the API stack because the pool is stateful (users cannot be recreated from code)
 * and needs retention and termination protection, while the API is stateless.
 *
 * 其他 stack 由 SSM `/brewline/<env>/auth/*` 取得 ID，不用 CloudFormation Export。
 * Consumers read IDs from SSM, not CloudFormation exports.
 */
export class AuthStack extends Stack {
  public readonly userPool: cognito.UserPool;
  public readonly webClient: cognito.UserPoolClient;
  public readonly smokeTestClient?: cognito.UserPoolClient;

  public static parameterPrefix(envName: EnvName): string {
    return `/brewline/${envName}/auth`;
  }

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);
    const { envName, auth } = props;

    // 1) Pre token generation：群組 → scope、custom:tenant_id → access token 的 tenant_id。
    //    Groups → scopes; custom:tenant_id → the access token's tenant_id claim.
    const preToken = new BrewlineFunction(this, 'PreTokenGeneration', {
      envName,
      lambda: props.lambda,
      module: 'identity',
      name: 'pre-token',
      entry: 'identity/src/pre-token-generation.ts',
      description: 'Cognito pre token generation (V2): groups to scopes, tenant_id claim',
      reservedConcurrency: props.lambda.reservedConcurrency.preTokenGeneration,
      // 每次登入或 refresh 都會同步呼叫，必須快 / Invoked synchronously on every sign-in and refresh.
      timeout: Duration.seconds(5),
      memorySize: 256,
      environment: { POWERTOOLS_SERVICE_NAME: 'identity-pre-token' },
    });

    // 2) User pool
    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `brewline-${envName}-users`,
      // Essentials：access token 客製化（pre token V2）需要；10,000 MAU 內免費（與 Lite 相同）。
      // Essentials is required for access-token customization; free up to 10,000 MAU like Lite.
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      // 不開放自助註冊：帳號由內部人員建立並核准（ORD-F-001），註冊端點的攻擊面因此消失（ADR-020）。
      // No self sign-up: staff create and approve accounts, which removes the sign-up attack surface.
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      signInCaseSensitive: false,
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      customAttributes: {
        // ⚠️ 自訂屬性建立後不能刪除或改名、限制也不能改。值的格式由 pre token 觸發器檢查（t_<ULID>）。
        // mutable：管理員可修正；使用者不能改，因為 app client 的 writeAttributes 不包含它。
        // Custom attributes can never be removed, renamed or re-constrained. Format is checked by the trigger.
        // Mutable so admins can fix it; users cannot, because no app client may write it.
        tenant_id: new cognito.StringAttribute({ minLen: 1, maxLen: 64, mutable: true }),
      },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
        tempPasswordValidity: Duration.days(3),
        // Essentials 功能：禁止重複使用最近 5 組密碼 / Essentials feature: block reuse of the last 5 passwords.
        passwordHistorySize: 5,
      },
      // MFA 是整個 pool 的設定，無法只對 staff 強制 → OPTIONAL＋只開 TOTP；staff 是否啟用由部署後驗證偵測（ADR-022）。
      // MFA is pool-wide (cannot be forced per group) → OPTIONAL, TOTP only; staff enrolment is checked after deploy.
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { sms: false, otp: true, email: false },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      email: cognito.UserPoolEmail.withCognito(),
      userInvitation: {
        emailSubject: 'BrewLine account invitation / BrewLine 帳號邀請',
        emailBody:
          'Your BrewLine username is {username} and temporary password is {####}. ' +
          '您的 BrewLine 帳號為 {username}，暫時密碼為 {####}。',
      },
      deletionProtection: auth.deletionProtection,
      removalPolicy: auth.retainOnDelete ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    this.userPool.addTrigger(
      cognito.UserPoolOperation.PRE_TOKEN_GENERATION_CONFIG,
      preToken.function,
      cognito.LambdaVersion.V2_0,
    );
    // User pool 存 Email → 最高分級 / The pool stores email addresses.
    Tags.of(this.userPool).add(DATA_CLASS_TAG, 'pii');

    Validations.of(this.userPool).acknowledge({
      id: 'AwsSolutions-COG2',
      reason:
        'Cognito MFA is pool-wide and cannot be required for the staff group only; MFA is OPTIONAL with TOTP, ' +
        'and staff enrolment is verified after deploy (ADR-022, RSK-015).',
    });
    Validations.of(this.userPool).acknowledge({
      id: 'AwsSolutions-COG8',
      reason:
        'Plus feature plan (threat protection) has no free tier (USD 0.02/MAU); Essentials is free up to ' +
        '10,000 MAU and covers access-token customization. Mitigated by no self sign-up, a strong password ' +
        'policy and API throttling. Revisit if the platform gets real users (ADR-020, ADR-022).',
    });

    // 3) 群組 / Groups
    for (const name of GROUPS) {
      this.userPool.addGroup(`Group-${name}`, {
        groupName: name,
        description: GROUP_SETTINGS[name].description,
        precedence: GROUP_SETTINGS[name].precedence,
      });
    }

    // 4) App clients
    const readAttributes = new cognito.ClientAttributes()
      .withStandardAttributes({ email: true, emailVerified: true })
      .withCustomAttributes('tenant_id');
    // 不包含 custom:tenant_id → 使用者無法用自己的 access token 修改租戶 / Users cannot change their tenant.
    const writeAttributes = new cognito.ClientAttributes().withStandardAttributes({ email: true });
    const tokenSettings = {
      generateSecret: false,
      disableOAuth: true, // A1 不用 managed login／hosted UI / no hosted UI in A1
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
      accessTokenValidity: Duration.minutes(60),
      idTokenValidity: Duration.minutes(60),
      refreshTokenValidity: Duration.days(7),
      authSessionValidity: Duration.minutes(3),
      readAttributes,
      writeAttributes,
    };

    this.webClient = this.userPool.addClient('WebClient', {
      userPoolClientName: 'web',
      // 只允許 SRP（密碼不經過網路）＋ refresh / SRP only (the password never crosses the wire) plus refresh.
      authFlows: { userSrp: true },
      ...tokenSettings,
    });

    if (auth.smokeTestClient) {
      // Dev 專用：ADMIN_USER_PASSWORD_AUTH 只能用 IAM 身分呼叫（AdminInitiateAuth），網路上的匿名者用不了。
      // Dev only: ADMIN_USER_PASSWORD_AUTH needs IAM credentials (AdminInitiateAuth); anonymous callers cannot use it.
      this.smokeTestClient = this.userPool.addClient('SmokeTestClient', {
        userPoolClientName: 'smoke-test',
        authFlows: { adminUserPassword: true },
        ...tokenSettings,
      });
    }

    // 5) SSM 參數 / SSM parameters
    const prefix = AuthStack.parameterPrefix(envName);
    const params: Array<[string, string, string]> = [
      ['UserPoolIdParam', 'user-pool-id', this.userPool.userPoolId],
      ['UserPoolArnParam', 'user-pool-arn', this.userPool.userPoolArn],
      ['WebClientIdParam', 'web-client-id', this.webClient.userPoolClientId],
      ['IssuerParam', 'issuer', this.userPool.userPoolProviderUrl],
    ];
    if (this.smokeTestClient) {
      params.push(['SmokeTestClientIdParam', 'smoke-test-client-id', this.smokeTestClient.userPoolClientId]);
    }
    for (const [pid, name, value] of params) {
      new ssm.StringParameter(this, pid, {
        parameterName: `${prefix}/${name}`,
        stringValue: value,
        tier: ssm.ParameterTier.STANDARD,
        description: `BrewLine ${envName} identity layer: ${name}`,
      });
    }

    // 部署後驗證用（不含任何秘密）/ For post-deploy verification (no secrets).
    new CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new CfnOutput(this, 'WebClientId', { value: this.webClient.userPoolClientId });
    new CfnOutput(this, 'PreTokenFunctionName', { value: preToken.function.functionName });
    if (this.smokeTestClient) {
      new CfnOutput(this, 'SmokeTestClientId', { value: this.smokeTestClient.userPoolClientId });
    }
  }
}
