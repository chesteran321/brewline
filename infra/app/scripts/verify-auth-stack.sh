#!/usr/bin/env bash
# 部署後驗證身分層（Cognito + pre token 觸發器）：查詢 AWS 實際狀態，並做不需要憑證的反向測試。
# Post-deploy verification of the identity layer: real AWS state plus credential-free negative tests.
#
# 用法 Usage: scripts/verify-auth-stack.sh <dev|prod> <outputs.json>
# 需要唯讀權限（CI 以 CDK lookup role 執行，它有 ReadOnlyAccess）。
# Needs read-only access (CI runs it as the CDK lookup role, which has ReadOnlyAccess).
set -euo pipefail

env_name="${1:?usage: verify-auth-stack.sh <dev|prod> <outputs.json>}"
outputs="${2:?usage: verify-auth-stack.sh <dev|prod> <outputs.json>}"
region="${AWS_REGION:-ap-east-2}"
stack="brewline-${env_name}-auth"

case "$env_name" in
  dev)  want_deletion_protection=INACTIVE; want_termination_protection=false; want_smoke_client=true;  want_retention=7;  want_concurrency=5 ;;
  prod) want_deletion_protection=ACTIVE;   want_termination_protection=true;  want_smoke_client=false; want_retention=30; want_concurrency=10 ;;
  *) echo "unknown env: $env_name" >&2; exit 2 ;;
esac

pool_id=$(jq -r --arg s "$stack" '.[$s].UserPoolId' "$outputs")
web_client=$(jq -r --arg s "$stack" '.[$s].WebClientId' "$outputs")
fn_name=$(jq -r --arg s "$stack" '.[$s].PreTokenFunctionName' "$outputs")
fail=0

check() { # check <label> <actual> <expected>
  if [[ "$2" == "$3" ]]; then
    echo "✅ $1 = $2"
  else
    echo "❌ $1 = $2 (expected $3)"
    fail=1
  fi
}

# 取得 AWS 錯誤代碼（例如 NotAuthorizedException）；成功時回傳 "OK" / Extract the AWS error code, or "OK".
error_code() {
  local out
  if out=$("$@" 2>&1); then echo "OK"; else grep -oE 'An error occurred \([A-Za-z]+\)' <<<"$out" | head -1 | tr -d '()' | awk '{print $4}'; fi
}

aws sts get-caller-identity --query Arn --output text

# --- User pool ---
pool=$(aws cognito-idp describe-user-pool --user-pool-id "$pool_id" --region "$region" --output json)
check "Feature plan"                 "$(jq -r '.UserPool.UserPoolTier' <<<"$pool")" "ESSENTIALS"
check "Admin-only user creation"     "$(jq -r '.UserPool.AdminCreateUserConfig.AllowAdminCreateUserOnly' <<<"$pool")" "true"
check "MFA configuration"            "$(jq -r '.UserPool.MfaConfiguration' <<<"$pool")" "OPTIONAL"
check "Password min length"          "$(jq -r '.UserPool.Policies.PasswordPolicy.MinimumLength' <<<"$pool")" "12"
check "Password history size"        "$(jq -r '.UserPool.Policies.PasswordPolicy.PasswordHistorySize' <<<"$pool")" "5"
check "Deletion protection"          "$(jq -r '.UserPool.DeletionProtection' <<<"$pool")" "$want_deletion_protection"
check "Pre token trigger version"    "$(jq -r '.UserPool.LambdaConfig.PreTokenGenerationConfig.LambdaVersion' <<<"$pool")" "V2_0"
# 沒有 SNS 角色 → 不可能寄 SMS（成本與 SMS 釣魚風險）/ No SNS role → SMS cannot be used at all.
check "No SMS configuration"         "$(jq -r 'if .UserPool.SmsConfiguration then "configured" else "none" end' <<<"$pool")" "none"
check "custom:tenant_id mutable"     "$(jq -r '.UserPool.SchemaAttributes[] | select(.Name == "custom:tenant_id") | .Mutable' <<<"$pool")" "true"

mfa=$(aws cognito-idp get-user-pool-mfa-config --user-pool-id "$pool_id" --region "$region" --output json)
check "TOTP enabled"                 "$(jq -r '.SoftwareTokenMfaConfiguration.Enabled' <<<"$mfa")" "true"

check "Groups" "$(aws cognito-idp list-groups --user-pool-id "$pool_id" --region "$region" \
  --query 'sort(Groups[].GroupName)' --output json | jq -c .)" '["cafe","simulator","staff"]'

# --- App clients ---
web=$(aws cognito-idp describe-user-pool-client --user-pool-id "$pool_id" --client-id "$web_client" --region "$region" --output json)
check "Web client auth flows"        "$(jq -c '.UserPoolClient.ExplicitAuthFlows | sort' <<<"$web")" '["ALLOW_REFRESH_TOKEN_AUTH","ALLOW_USER_SRP_AUTH"]'
check "Web client cannot write tenant_id" \
  "$(jq -r '.UserPoolClient.WriteAttributes | index("custom:tenant_id") == null' <<<"$web")" "true"
check "Web client token revocation"  "$(jq -r '.UserPoolClient.EnableTokenRevocation' <<<"$web")" "true"
# 15 分鐘（A2）：縮短撤銷帳號後仍可呼叫 API 的時間（RSK-015）/ 15 minutes shrinks the post-revocation window.
check "Web client access token validity" "$(jq -r '"\(.UserPoolClient.AccessTokenValidity) \(.UserPoolClient.TokenValidityUnits.AccessToken)"' <<<"$web")" "15 minutes"
check "Web client ID token validity"     "$(jq -r '"\(.UserPoolClient.IdTokenValidity) \(.UserPoolClient.TokenValidityUnits.IdToken)"' <<<"$web")" "15 minutes"

has_smoke=$(aws cognito-idp list-user-pool-clients --user-pool-id "$pool_id" --region "$region" \
  --query "length(UserPoolClients[?ClientName=='smoke-test'])" --output text)
check "Smoke-test client present" "$([[ "$has_smoke" == "1" ]] && echo true || echo false)" "$want_smoke_client"

# --- Pre token Lambda ---
cfg=$(aws lambda get-function-configuration --function-name "$fn_name" --region "$region" --output json)
check "Lambda runtime"               "$(jq -r '.Runtime' <<<"$cfg")" "nodejs24.x"
check "Lambda architecture"          "$(jq -c '.Architectures' <<<"$cfg")" '["arm64"]'
check "Lambda tracing"               "$(jq -r '.TracingConfig.Mode' <<<"$cfg")" "Active"
check "Lambda reserved concurrency"  "$(aws lambda get-function-concurrency --function-name "$fn_name" --region "$region" \
  --query ReservedConcurrentExecutions --output text)" "$want_concurrency"
check "Log retention (days)"         "$(aws logs describe-log-groups --log-group-name-prefix "/aws/lambda/${fn_name}" --region "$region" \
  --query 'logGroups[0].retentionInDays' --output text)" "$want_retention"

# --- SSM 與 stack / SSM and stack ---
check "SSM web-client-id" "$(aws ssm get-parameter --name "/brewline/${env_name}/auth/web-client-id" --region "$region" \
  --query Parameter.Value --output text)" "$web_client"
check "Stack termination protection" "$(aws cloudformation describe-stacks --stack-name "$stack" --region "$region" \
  --query 'Stacks[0].EnableTerminationProtection' --output text | tr '[:upper:]' '[:lower:]')" "$want_termination_protection"

# --- 反向測試：不帶 AWS 憑證呼叫公開的 Cognito API（不會建立任何資料）---
# --- Negative tests: unauthenticated public Cognito APIs (create nothing) ---
probe_user="verify-probe@example.com"   # 保留網域 / reserved domain (RFC 2606)
probe_pass="Never-Used-Probe-12345!"
check "Self sign-up rejected" "$(error_code aws cognito-idp sign-up --no-sign-request --region "$region" \
  --client-id "$web_client" --username "$probe_user" --password "$probe_pass")" "NotAuthorizedException"
check "USER_PASSWORD_AUTH rejected on web client" "$(error_code aws cognito-idp initiate-auth --no-sign-request --region "$region" \
  --client-id "$web_client" --auth-flow USER_PASSWORD_AUTH --auth-parameters "USERNAME=${probe_user},PASSWORD=${probe_pass}")" \
  "InvalidParameterException"

# --- 偵測性控制：已啟用的 staff 帳號都必須設定 TOTP（ADR-022）---
# --- Detective control: every confirmed staff user must have TOTP ---
staff=$(aws cognito-idp list-users-in-group --user-pool-id "$pool_id" --group-name staff --region "$region" \
  --query 'Users[].[Username,UserStatus]' --output text)
if [[ -z "$staff" ]]; then
  echo "ℹ️  Staff MFA: no staff users yet"
else
  while read -r user status; do
    [[ -z "$user" ]] && continue
    if ! got=$(aws cognito-idp admin-get-user --user-pool-id "$pool_id" --username "$user" --region "$region" \
          --query 'UserMFASettingList' --output json 2>&1); then
      echo "⚠️  Staff MFA: cannot read MFA settings with this identity (skipped)"
      break
    fi
    if jq -e 'index("SOFTWARE_TOKEN_MFA") != null' <<<"$got" >/dev/null; then
      echo "✅ Staff MFA: ${user:0:8}… TOTP"
    elif [[ "$status" == "FORCE_CHANGE_PASSWORD" ]]; then
      echo "⚠️  Staff MFA: ${user:0:8}… not set up yet (first sign-in pending)"
    else
      echo "❌ Staff MFA: ${user:0:8}… ($status) has no TOTP"
      fail=1
    fi
  done <<<"$staff"
fi

exit "$fail"
