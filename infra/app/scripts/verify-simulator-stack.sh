#!/usr/bin/env bash
# 部署後驗證模擬器（S1b，ADR-030）：帳號、開關、設定、密碼參數、排程、執行角色（政策模擬）、告警、DLQ。
# Post-deploy verification of the simulator: accounts, kill switch, config, credentials parameter, schedule,
# run role (policy simulation), alarms and DLQ.
#
# 用法 Usage: scripts/verify-simulator-stack.sh <dev|prod> <outputs.json>
# 需要唯讀權限（CI 以 CDK lookup role 執行）。唯讀角色讀不到 Lambda 環境變數的值，也不能解密 SecureString
# （status §10.14 #8）→ 驗證控管本身（IAM、參數類型與金鑰），不驗證秘密內容。
# Read-only (CI runs it as the CDK lookup role), which can read neither env var values nor SecureStrings,
# so this checks the controls (IAM, parameter type and key), never the secret itself.
set -euo pipefail

env_name="${1:?usage: verify-simulator-stack.sh <dev|prod> <outputs.json>}"
outputs="${2:?usage: verify-simulator-stack.sh <dev|prod> <outputs.json>}"
region="${AWS_REGION:-ap-east-2}"
stack="brewline-${env_name}-simulator"
case "$env_name" in
  dev)  want_termination_protection=false; want_pool=40; want_orders=2-6 ;;
  prod) want_termination_protection=true;  want_pool=40; want_orders=5-40 ;;
  *) echo "unknown env: $env_name" >&2; exit 2 ;;
esac

out() { jq -r --arg s "$stack" --arg k "$1" '.[$s][$k] // empty' "$outputs"; }
fail=0
check() { if [[ "$2" == "$3" ]]; then echo "✅ $1 = $2"; else echo "❌ $1 = $2 (expected $3)"; fail=1; fi; }

aws sts get-caller-identity --query Arn --output text
account=$(aws sts get-caller-identity --query Account --output text)
prefix="/brewline/${env_name}/simulator"
ssm_arn() { echo "arn:aws:ssm:${region}:${account}:parameter$1"; }
pool_id=$(aws ssm get-parameter --name "/brewline/${env_name}/auth/user-pool-id" --region "$region" --query Parameter.Value --output text)
pool_arn=$(aws ssm get-parameter --name "/brewline/${env_name}/auth/user-pool-arn" --region "$region" --query Parameter.Value --output text)
key_arn=$(aws ssm get-parameter --name "/brewline/${env_name}/data/kms-key-arn" --region "$region" --query Parameter.Value --output text)
table_arn=$(aws ssm get-parameter --name "/brewline/${env_name}/data/table-arn" --region "$region" --query Parameter.Value --output text)

# --- 帳號（D3）/ Accounts ---
check "Accounts (custom resource)" "$(out AccountCount)" "$want_pool"
members=$(aws cognito-idp list-users-in-group --user-pool-id "$pool_id" --group-name simulator --region "$region" \
  --query 'Users[].Username' --output json --max-items 100)
check "Simulator group members" "$(jq 'length' <<<"$members")" "$want_pool"
# 反向：模擬帳號不能同時在 staff 群組 / Negative: no simulated account is also staff.
staff=$(aws cognito-idp list-users-in-group --user-pool-id "$pool_id" --group-name staff --region "$region" \
  --query 'Users[].Username' --output json --max-items 100)
check "Simulated accounts in staff" "$(jq -n --argjson a "$members" --argjson b "$staff" '[$a[] | select(. as $x | $b | index($x))] | length')" "0"
# S2d：模擬烘焙廠在 simulator-roastery 群組、沒有租戶、不在 staff、不在 simulator 群組。
# 這個 user pool 以 email 當登入別名 → Cognito 的 Username 是 UUID，要用 email 屬性找人，再用 Username 比對群組。
# The pool signs in with an email alias, so Username is a UUID: find the roaster by its email attribute,
# then compare Usernames across groups.
roasters=$(aws cognito-idp list-users-in-group --user-pool-id "$pool_id" --group-name simulator-roastery --region "$region" \
  --output json --max-items 100)
roaster=$(jq -c '[.Users[] | select(any(.Attributes[]?; .Name == "email" and .Value == "sim-roaster@example.com"))]' <<<"$roasters")
roaster_name=$(jq -r '.[0].Username // ""' <<<"$roaster")
check "Roaster account in simulator-roastery" "$(jq 'length' <<<"$roaster")" "1"
check "Roaster has no tenant_id" "$(jq '[.[0].Attributes[]? | select(.Name == "custom:tenant_id")] | length' <<<"$roaster")" "0"
check "Roaster in staff" "$(jq -n --argjson b "$staff" --arg u "$roaster_name" '$u != "" and ($b | index($u) != null)')" "false"
check "Roaster in simulator (cafe) group" "$(jq -n --argjson a "$members" --arg u "$roaster_name" '$u != "" and ($a | index($u) != null)')" "false"

# --- SSM：開關、設定、密碼（D7、D2）/ Switch, config, credentials ---
state=$(aws ssm get-parameter --name "${prefix}/state" --region "$region" --query Parameter.Value --output text 2>/dev/null || echo missing)
check "State is paused or running" "$([[ "$state" == paused || "$state" == running ]] && echo "true ($state)" || echo "false ($state)")" "true ($state)"
config=$(aws ssm get-parameter --name "${prefix}/config" --region "$region" --query Parameter.Value --output text)
check "Config poolSize"   "$(jq -r .poolSize <<<"$config")" "$want_pool"
check "Config has no retainOnDelete" "$(jq 'has("retainOnDelete")' <<<"$config")" "false"
check "Config activationStartMonth (S1c)" "$(jq -r '.activationStartMonth // "missing"' <<<"$config" | grep -Ec '^[0-9]{4}-(0[1-9]|1[0-2])$')" "1"
check "Config orders/day range" "$(jq -r '"\(.ordersPerDay.min)-\(.ordersPerDay.max)"' <<<"$config")" "$want_orders"
cred=$(aws ssm describe-parameters --region "$region" --parameter-filters "Key=Name,Values=${prefix}/credentials" \
  --query 'Parameters[0].[Type,KeyId,Tier]' --output text)
check "Credentials parameter (type, key, tier)" "$cred" "$(printf 'SecureString\t%s\tStandard' "$key_arn")"
# 反向：唯讀角色讀得到參數存在，但解不開 / Negative: the read-only role cannot decrypt it.
if aws ssm get-parameter --name "${prefix}/credentials" --with-decryption --region "$region" >/dev/null 2>&1; then
  check "Read-only role decrypts credentials" "true" "false"
else
  check "Read-only role decrypts credentials" "false" "false"
fi

# --- 排程（D8）/ Schedule ---
sched=$(aws scheduler get-schedule --group-name "$(out ScheduleGroupName)" --name "$(out ScheduleName)" --region "$region" --output json)
run_fn=$(out RunFunctionName)
run_arn=$(aws lambda get-function-configuration --function-name "$run_fn" --region "$region" --query FunctionArn --output text)
check "Schedule state"      "$(jq -r .State <<<"$sched")" "ENABLED"
check "Schedule expression" "$(jq -r .ScheduleExpression <<<"$sched")" "cron(5 8-19 * * ? *)"
check "Schedule timezone"   "$(jq -r .ScheduleExpressionTimezone <<<"$sched")" "Asia/Taipei"
check "Schedule flexible window" "$(jq -r .FlexibleTimeWindow.Mode <<<"$sched")" "OFF"
check "Schedule target = run function" "$(jq -r .Target.Arn <<<"$sched")" "$run_arn"
check "Schedule retries" "$(jq -r .Target.RetryPolicy.MaximumRetryAttempts <<<"$sched")" "0"
check "Schedule DLQ" "$(jq -r '.Target.DeadLetterConfig.Arn // "none"' <<<"$sched")" \
  "arn:aws:sqs:${region}:${account}:brewline-${env_name}-simulator-dlq"
trust=$(aws iam get-role --role-name "brewline-${env_name}-simulator-scheduler" --query Role.AssumeRolePolicyDocument --output json)
check "Scheduler role SourceArn = schedule group" \
  "$(jq -r '[.Statement[].Condition.StringEquals["aws:SourceArn"]] | flatten | first' <<<"$trust")" \
  "arn:aws:scheduler:${region}:${account}:schedule-group/brewline-${env_name}-simulator"

# --- 位置檔排程（P2b-2，E4）/ Positions schedule ---
vsched=$(aws scheduler get-schedule --group-name "$(out ScheduleGroupName)" --name "$(out VoyagesScheduleName)" --region "$region" --output json)
check "Voyages schedule state"      "$(jq -r .State <<<"$vsched")" "ENABLED"
check "Voyages schedule expression" "$(jq -r .ScheduleExpression <<<"$vsched")" "cron(20,50 * * * ? *)"
check "Voyages schedule timezone"   "$(jq -r .ScheduleExpressionTimezone <<<"$vsched")" "Asia/Taipei"
check "Voyages schedule target = run function" "$(jq -r .Target.Arn <<<"$vsched")" "$run_arn"
check "Voyages schedule input segment" "$(jq -r '.Target.Input | fromjson | .segment' <<<"$vsched")" "positions"
check "Voyages schedule retries" "$(jq -r .Target.RetryPolicy.MaximumRetryAttempts <<<"$vsched")" "0"
check "Voyages schedule DLQ" "$(jq -r '.Target.DeadLetterConfig.Arn // "none"' <<<"$vsched")" \
  "arn:aws:sqs:${region}:${account}:brewline-${env_name}-simulator-dlq"

# --- 執行函數 / Run function ---
cfg=$(aws lambda get-function-configuration --function-name "$run_fn" --region "$region" --output json)
check "Run function timeout (s, cafés + roastery)" "$(jq -r .Timeout <<<"$cfg")" "300"
check "Run runtime"      "$(jq -r .Runtime <<<"$cfg")" "nodejs24.x"
check "Run architecture" "$(jq -c .Architectures <<<"$cfg")" '["arm64"]'
check "Run tracing"      "$(jq -r .TracingConfig.Mode <<<"$cfg")" "Active"
check "Run reserved concurrency" "$(aws lambda get-function-concurrency --function-name "$run_fn" --region "$region" \
  --query ReservedConcurrentExecutions --output text)" "1"
eic=$(aws lambda get-function-event-invoke-config --function-name "$run_fn" --region "$region" --output json)
check "Run async retries" "$(jq -r .MaximumRetryAttempts <<<"$eic")" "0"
check "Run async on-failure → DLQ" "$(jq -r '.DestinationConfig.OnFailure.Destination // "none"' <<<"$eic")" \
  "arn:aws:sqs:${region}:${account}:brewline-${env_name}-simulator-dlq"

# --- 執行角色：政策模擬（D3：只能登入、只讀 3 個參數）/ Run role: policy simulation ---
run_role=$(jq -r .Role <<<"$cfg")
sim() { # sim <action> <resource arn>
  aws iam simulate-principal-policy --policy-source-arn "$run_role" --action-names "$1" --resource-arns "$2" \
    --query 'EvaluationResults[0].EvalDecision' --output text
}
check "Run role → AdminInitiateAuth"        "$(sim cognito-idp:AdminInitiateAuth "$pool_arn")" "allowed"
check "Run role → read credentials"         "$(sim ssm:GetParameter "$(ssm_arn "${prefix}/credentials")")" "allowed"
check "Run role → AdminCreateUser (neg)"    "$(sim cognito-idp:AdminCreateUser "$pool_arn")" "implicitDeny"
check "Run role → AdminSetUserPassword (neg)" "$(sim cognito-idp:AdminSetUserPassword "$pool_arn")" "implicitDeny"
check "Run role → write state (neg)"        "$(sim ssm:PutParameter "$(ssm_arn "${prefix}/state")")" "implicitDeny"
check "Run role → other parameter (neg)"    "$(sim ssm:GetParameter "$(ssm_arn "/brewline/${env_name}/data/kms-key-arn")")" "implicitDeny"
check "Run role → DynamoDB PutItem (neg)"   "$(sim dynamodb:PutItem "$table_arn")" "implicitDeny"
# P2b-2（E3）：只能寫 raw/positions/source=sim/ / Positions: source=sim only, write only.
lake_arn="arn:aws:s3:::$(aws ssm get-parameter --name "/brewline/${env_name}/lake/bucket-name" --region "$region" --query Parameter.Value --output text)"
check "Run role → PutObject positions source=sim" "$(sim s3:PutObject "${lake_arn}/raw/positions/source=sim/dt=2026-11-23/0020.jsonl.gz")" "allowed"
check "Run role → PutObject source=ais (neg)"     "$(sim s3:PutObject "${lake_arn}/raw/positions/source=ais/dt=2026-11-23/x.jsonl.gz")" "implicitDeny"
check "Run role → PutObject raw/events (neg)"     "$(sim s3:PutObject "${lake_arn}/raw/events/x.gz")" "implicitDeny"
check "Run role → GetObject positions (neg)"      "$(sim s3:GetObject "${lake_arn}/raw/positions/source=sim/x")" "implicitDeny"
check "Run role → DeleteObject positions (neg)"   "$(sim s3:DeleteObject "${lake_arn}/raw/positions/source=sim/x")" "implicitDeny"

# --- 告警與 DLQ / Alarms and DLQ ---
alarms=$(aws cloudwatch describe-alarms --alarm-name-prefix "brewline-${env_name}-simulator-" --region "$region" --output json)
check "Alarm count" "$(jq '.MetricAlarms | length' <<<"$alarms")" "2"
check "Alarms with an action" "$(jq '[.MetricAlarms[] | select((.AlarmActions | length) > 0 and (.OKActions | length) > 0)] | length' <<<"$alarms")" "2"
check "Alarms in ALARM" "$(jq '[.MetricAlarms[] | select(.StateValue == "ALARM")] | length' <<<"$alarms")" "0"
total=$(aws cloudwatch describe-alarms --region "$region" --query 'length(MetricAlarms)' --output text)
# ADR-030 D9 修訂（P2 設計 D8）：每環境上限 13（與 verify-ops-stack.sh 相同）/ D9 revised: ≤ 13 per environment.
check "Account alarms ≤ 13 (ADR-030 D9 revised)" "$([[ "$total" -le 13 ]] && echo "true ($total)" || echo "false ($total)")" "true ($total)"
dlq=$(aws sqs get-queue-attributes --queue-url "$(out DlqUrl)" --region "$region" \
  --attribute-names SqsManagedSseEnabled ApproximateNumberOfMessages --output json)
check "DLQ SSE-SQS"  "$(jq -r .Attributes.SqsManagedSseEnabled <<<"$dlq")" "true"
check "DLQ messages" "$(jq -r .Attributes.ApproximateNumberOfMessages <<<"$dlq")" "0"

check "Stack termination protection" "$(aws cloudformation describe-stacks --stack-name "$stack" --region "$region" \
  --query 'Stacks[0].EnableTerminationProtection' --output text | tr '[:upper:]' '[:lower:]')" "$want_termination_protection"

exit "$fail"
