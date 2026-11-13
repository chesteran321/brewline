import { Duration, Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { EnvName } from '../config';

export interface TenantAccessRoleProps {
  readonly envName: EnvName;
  /** DynamoDB core 表 ARN（SSM token）/ Core table ARN (SSM token). */
  readonly tableArn: string;
  /** 資料層 CMK ARN（SSM token）/ Data-layer CMK ARN (SSM token). */
  readonly keyArn: string;
}

/**
 * 租戶存取角色（ADR-024，docs/03 §5，ADR-010）。
 * Tenant access role.
 *
 * 訂單 Lambda 從**已驗證的 JWT** 取出 `tenant_id`，以 `sts:AssumeRole` 帶上 session tag `tenant_id`
 * 換成這個角色的臨時憑證。權限政策用 `${aws:PrincipalTag/tenant_id}`，所以憑證只能碰
 * `TENANT#<自己的 tenant_id>`。就算程式有 bug，IAM 也會拒絕跨租戶讀寫。
 * Order Lambdas take `tenant_id` from the verified JWT and assume this role with a `tenant_id` session tag.
 * The policy uses `${aws:PrincipalTag/tenant_id}`, so the credentials only reach `TENANT#<own id>`;
 * IAM denies cross-tenant access even if application code is buggy.
 *
 * 誰能扮演 / Who may assume it:
 *   只有名稱為 `brewline-<env>-orders-*` 的角色（A2b 的訂單函數），而且必須帶一個、且只帶一個
 *   符合 `t_` + 26 字元格式的 `tenant_id` 標籤。
 *   Only roles named `brewline-<env>-orders-*`, and only with exactly one `tenant_id` tag of the
 *   form "t_" + 26 characters.
 */
export class TenantAccessRole extends Construct {
  public readonly role: iam.Role;

  /** 允許扮演此角色的函數角色名稱前綴 / Role-name prefix of functions allowed to assume it. */
  public static callerRolePrefix(envName: EnvName): string {
    return `brewline-${envName}-orders-`;
  }

  public static roleName(envName: EnvName): string {
    return `brewline-${envName}-tenant-access`;
  }

  constructor(scope: Construct, id: string, props: TenantAccessRoleProps) {
    super(scope, id);
    const { account, region } = Stack.of(this);
    const callerArn = `arn:aws:iam::${account}:role/${TenantAccessRole.callerRolePrefix(props.envName)}*`;

    // tenant_id = "t_" + 26 字元（ULID）。IAM 沒有正規表示式，用 26 個 "?" 精確限制長度。
    // tenant_id = "t_" + 26 chars. IAM has no regex; 26 "?" wildcards pin the exact length.
    const tenantTagPattern = `t_${'?'.repeat(26)}`;
    const trustConditions = {
      ArnLike: { 'aws:PrincipalArn': callerArn },
      StringLike: { 'aws:RequestTag/tenant_id': tenantTagPattern },
      // 只允許 tenant_id 這一個標籤，避免呼叫端夾帶其他 PrincipalTag
      // Only the tenant_id tag may be set, so callers cannot smuggle other principal tags.
      'ForAllValues:StringEquals': { 'aws:TagKeys': ['tenant_id'] },
    };

    this.role = new iam.Role(this, 'Role', {
      roleName: TenantAccessRole.roleName(props.envName),
      description: 'Tenant-scoped DynamoDB access; assumed by order Lambdas with a tenant_id session tag (ADR-024)',
      // 同帳號信任＋條件；呼叫端的身分政策也必須允許 sts:AssumeRole（A2b 加上）
      // Same-account trust with conditions; the caller's identity policy must also allow sts:AssumeRole (A2b).
      assumedBy: new iam.AccountPrincipal(account).withConditions(trustConditions),
      maxSessionDuration: Duration.hours(1),
    });
    // session tag 需要 sts:TagSession，同樣的條件 / Session tags need sts:TagSession with the same conditions.
    this.role.assumeRolePolicy!.addStatements(
      new iam.PolicyStatement({
        actions: ['sts:TagSession'],
        principals: [new iam.AccountPrincipal(account)],
        conditions: trustConditions,
      }),
    );

    const ownTenant = '${aws:PrincipalTag/tenant_id}'; // IAM 政策變數，不是 JS 範本 / IAM policy variable
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'OwnTenantItems',
        // TransactWriteItems 沒有獨立的 IAM 動作，依每個項目的 Put／Update／ConditionCheck 授權
        // TransactWriteItems has no IAM action of its own; each item is authorized by its own action.
        actions: ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:PutItem', 'dynamodb:ConditionCheckItem'],
        resources: [props.tableArn],
        // 完全比對：v0.1 的 `TENANT#${tag}*` 會讓 t_1 也符合 TENANT#t_12…
        // Exact match: v0.1's trailing `*` would let t_1 match TENANT#t_12…
        conditions: { 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': [`TENANT#${ownTenant}`] } },
      }),
    );
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadProducts',
        actions: ['dynamodb:GetItem', 'dynamodb:BatchGetItem'],
        resources: [props.tableArn],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['PRODUCT#*'] } },
      }),
    );
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReserveStockOnly',
        actions: ['dynamodb:UpdateItem'],
        resources: [props.tableArn],
        conditions: {
          'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['PRODUCT#*'] },
          // 只能動庫存欄位（鍵也要列出）→ 改不了價格 / Stock attributes only (keys included) → prices are untouchable.
          'ForAllValues:StringEquals': {
            'dynamodb:Attributes': ['pk', 'sk', 'available_kg', 'reserved_kg', 'version', 'updated_at'],
          },
          // 不能用 ALL_NEW／ALL_OLD 讀回整個項目 / No reading the whole item back via ReturnValues.
          StringEqualsIfExists: { 'dynamodb:ReturnValues': ['NONE', 'UPDATED_NEW', 'UPDATED_OLD'] },
        },
      }),
    );
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'DenyScan',
        effect: iam.Effect.DENY,
        actions: ['dynamodb:Scan'],
        resources: [props.tableArn, `${props.tableArn}/index/*`],
      }),
    );
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'KeyViaDynamoDB',
        actions: ['kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKey'],
        resources: [props.keyArn],
        conditions: { StringEquals: { 'kms:ViaService': `dynamodb.${region}.amazonaws.com` } },
      }),
    );
  }

  /** 讓函數可以扮演此角色（函數角色名稱必須符合前綴）/ Let a function assume this role. */
  public grantAssume(grantee: iam.IRole): void {
    grantee.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole', 'sts:TagSession'],
        resources: [this.role.roleArn],
      }),
    );
  }
}
