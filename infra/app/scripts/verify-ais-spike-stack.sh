#!/usr/bin/env bash
# 部署後驗證 aisstream spike（P2b-spike，只在 Dev，ADR-032 D2／D9，spike 規格 F1–F12）：
# 取樣函數設定、排程（:10／:40 台北、7 天、不重試、DLQ）、API key 參數的「中繼資料」（不讀值）、Glue 表 ais_static，
# 以及取樣函數角色與排程角色的政策模擬（正向：讀 key、寫 source=ais/；反向：寫 source=sim/、讀其他參數、DynamoDB…）。
# Post-deploy verification of the Dev-only aisstream spike, including IAM policy simulations.
#
# 以 lookup role（ReadOnlyAccess）執行：只讀，不寫、不解密任何東西 / Read-only; never decrypts the key.
# 用法 Usage: scripts/verify-ais-spike-stack.sh dev <outputs.json>
set -euo pipefail

env_name="${1:?usage: verify-ais-spike-stack.sh dev <outputs.json>}"
outputs="${2:?usage: verify-ais-spike-stack.sh dev <outputs.json>}"
[[ "$env_name" == dev ]] || { echo "the aisstream spike is Dev-only" >&2; exit 2; }
region=ap-east-2
stack="brewline-${env_name}-ais-spike"

fail=0
check() { if [[ "$2" == "$3" ]]; then echo "✅ $1 = $2"; else echo "❌ $1 = $2 (expected $3)"; fail=1; fi; }
out() { jq -r --arg s "$stack" --arg k "$1" '.[$s][$k] // empty' "$outputs"; }
ssm() { aws ssm get-parameter --name "$1" --region "$region" --query Parameter.Value --output text; }

aws sts get-caller-identity --query Arn --output text
account=$(aws sts get-caller-identity --query Account --output text)
lake=$(ssm "/brewline/${env_name}/lake/bucket-name")
lake_arn="arn:aws:s3:::${lake}"
table_arn=$(ssm "/brewline/${env_name}/data/table-arn")
key_arn=$(ssm "/brewline/${env_name}/data/kms-key-arn")
dlq_arn="arn:aws:sqs:${region}:${account}:brewline-${env_name}-shipment-dlq"
key_param="/brewline/${env_name}/ais/api-key"
key_param_arn="arn:aws:ssm:${region}:${account}:parameter${key_param}"

# --- 1) API key 參數：只看中繼資料（F8）/ Key parameter: metadata only ---
check "Output ApiKeyParameterName" "$(out ApiKeyParameterName)" "$key_param"
meta=$(aws ssm describe-parameters --region "$region" --output json \
  --parameter-filters "Key=Name,Option=Equals,Values=${key_param}")
check "Key parameter exists"   "$(jq '.Parameters | length' <<<"$meta")" "1"
check "Key parameter type"     "$(jq -r '.Parameters[0].Type // "missing"' <<<"$meta")" "SecureString"
check "Key parameter CMK"      "$(jq -r '.Parameters[0].KeyId // "missing"' <<<"$meta")" "alias/brewline-${env_name}-data"

# --- 2) 取樣函數 / Sampler function ---
fn=$(out SamplerFunctionName)
check "Sampler function name" "$fn" "brewline-${env_name}-ais-spike-sampler"
cfg=$(aws lambda get-function-configuration --function-name "$fn" --region "$region" --output json)
check "Sampler runtime"      "$(jq -r .Runtime <<<"$cfg")" "nodejs24.x"
check "Sampler architecture" "$(jq -c .Architectures <<<"$cfg")" '["arm64"]'
check "Sampler tracing"      "$(jq -r .TracingConfig.Mode <<<"$cfg")" "Active"
check "Sampler memory (MB)"  "$(jq -r .MemorySize <<<"$cfg")" "256"
check "Sampler timeout (s)"  "$(jq -r .Timeout <<<"$cfg")" "150"
# 唯讀驗證角色看不到環境變數的值（null）→ 只在看得到時判定；實際控制是下方的政策模擬。
# The read-only role does not see environment values; judge only when visible. The IAM simulation is the control.
envs=$(jq -c '.Environment.Variables // empty' <<<"$cfg")
if [[ -n "$envs" && "$envs" != "null" ]]; then
  check "Sampler env AIS_KEY_PARAM" "$(jq -r .AIS_KEY_PARAM <<<"$envs")" "$key_param"
  check "Sampler env LAKE_BUCKET"   "$(jq -r .LAKE_BUCKET <<<"$envs")" "$lake"
  check "Sampler env COLLECT_SECONDS" "$(jq -r .COLLECT_SECONDS <<<"$envs")" "120"
else
  echo "ℹ️  Sampler environment not visible to this role (enforced by the IAM simulations below)"
fi
check "Sampler reserved concurrency" "$(aws lambda get-function-concurrency --function-name "$fn" --region "$region" \
  --query ReservedConcurrentExecutions --output text)" "1"
eic=$(aws lambda get-function-event-invoke-config --function-name "$fn" --region "$region" --output json)
check "Sampler async retries" "$(jq -r .MaximumRetryAttempts <<<"$eic")" "0"
check "Sampler async on-failure → shipment-dlq" "$(jq -r '.DestinationConfig.OnFailure.Destination // "none"' <<<"$eic")" "$dlq_arn"

# --- 3) 排程（F2、F3）/ Schedule ---
group=$(out ScheduleGroupName)
check "Schedule group" "$group" "brewline-${env_name}-ais-spike"
sch=$(aws scheduler get-schedule --group-name "$group" --name "$(out ScheduleName)" --region "$region" --output json)
check "Schedule state"      "$(jq -r .State <<<"$sch")" "ENABLED"
check "Schedule expression" "$(jq -r .ScheduleExpression <<<"$sch")" "cron(10,40 * * * ? *)"
check "Schedule timezone"   "$(jq -r .ScheduleExpressionTimezone <<<"$sch")" "Asia/Taipei"
check "Schedule flexible window" "$(jq -r .FlexibleTimeWindow.Mode <<<"$sch")" "OFF"
start=$(jq -r .StartDate <<<"$sch"); end=$(jq -r .EndDate <<<"$sch")
dur=$(( $(date -d "$end" +%s) - $(date -d "$start" +%s) ))
check "Schedule window = 7 days (D2)" "$dur" "604800"
echo "ℹ️  Schedule window: ${start} → ${end}"
check "Schedule target = sampler" "$(jq -r '.Target.Arn | endswith(":function:'"$fn"'")' <<<"$sch")" "true"
check "Schedule retries"    "$(jq -r .Target.RetryPolicy.MaximumRetryAttempts <<<"$sch")" "0"
check "Schedule DLQ"        "$(jq -r '.Target.DeadLetterConfig.Arn // "none"' <<<"$sch")" "$dlq_arn"

# --- 4) Glue 表 ais_static（F12）/ Static-data table ---
st=$(aws glue get-table --database-name brewline_raw --name ais_static --region "$region" --query Table --output json)
check "ais_static location"   "$(jq -r .StorageDescriptor.Location <<<"$st")" "s3://${lake}/raw/ais-static/"
check "ais_static partitions" "$(jq -r '[.PartitionKeys[].Name] | join(",")' <<<"$st")" "dt"
check "ais_static projection" "$(jq -r '.Parameters."projection.enabled"' <<<"$st")" "true"
check "ais_static malformed JSON fails" "$(jq -r '.StorageDescriptor.SerdeInfo.Parameters."ignore.malformed.json"' <<<"$st")" "false"
check "ais_static synthetic"  "$(jq -r .Parameters.synthetic <<<"$st")" "false"

# --- 5) 取樣函數角色：政策模擬（只算身分政策）/ Sampler role: policy simulation ---
role=$(jq -r .Role <<<"$cfg")
sim() {  # sim <role> <action> <resource> [context-entries...]
  local r=$1 a=$2 res=$3; shift 3
  aws iam simulate-principal-policy --policy-source-arn "$r" --action-names "$a" --resource-arns "$res" "$@" \
    --query 'EvaluationResults[0].EvalDecision' --output text
}
ctx() { echo "ContextKeyName=$1,ContextKeyValues=$2,ContextKeyType=string"; }
via_ssm=$(ctx kms:ViaService "ssm.${region}.amazonaws.com")
via_s3=$(ctx kms:ViaService "s3.${region}.amazonaws.com")
other_param_arn="arn:aws:ssm:${region}:${account}:parameter/brewline/${env_name}/simulator/credentials"
check "GetParameter api-key"                 "$(sim "$role" ssm:GetParameter "$key_param_arn")" "allowed"
check "GetParameter simulator creds (neg)"   "$(sim "$role" ssm:GetParameter "$other_param_arn")" "implicitDeny"
check "GetParametersByPath (neg)"            "$(sim "$role" ssm:GetParametersByPath "arn:aws:ssm:${region}:${account}:parameter/brewline/${env_name}")" "implicitDeny"
check "KMS Decrypt via SSM (api-key context)" "$(sim "$role" kms:Decrypt "$key_arn" --context-entries "$via_ssm" \
  "$(ctx kms:EncryptionContext:PARAMETER_ARN "$key_param_arn")")" "allowed"
check "KMS Decrypt via SSM (other param, neg)" "$(sim "$role" kms:Decrypt "$key_arn" --context-entries "$via_ssm" \
  "$(ctx kms:EncryptionContext:PARAMETER_ARN "$other_param_arn")")" "implicitDeny"
check "KMS Decrypt direct (neg)"             "$(sim "$role" kms:Decrypt "$key_arn")" "implicitDeny"
check "PutObject source=ais/"                "$(sim "$role" s3:PutObject "${lake_arn}/raw/positions/source=ais/dt=2026-11-27/0010.jsonl.gz")" "allowed"
check "PutObject ais-static/"                "$(sim "$role" s3:PutObject "${lake_arn}/raw/ais-static/dt=2026-11-27/0010.jsonl.gz")" "allowed"
check "PutObject source=sim/ (neg)"          "$(sim "$role" s3:PutObject "${lake_arn}/raw/positions/source=sim/dt=2026-11-27/x.gz")" "implicitDeny"
check "PutObject curated/ (neg)"             "$(sim "$role" s3:PutObject "${lake_arn}/curated/x")" "implicitDeny"
check "GetObject source=ais/ (neg)"          "$(sim "$role" s3:GetObject "${lake_arn}/raw/positions/source=ais/x")" "implicitDeny"
check "DeleteObject source=ais/ (neg)"       "$(sim "$role" s3:DeleteObject "${lake_arn}/raw/positions/source=ais/x")" "implicitDeny"
check "KMS GenerateDataKey via S3 (bucket context)" "$(sim "$role" kms:GenerateDataKey "$key_arn" --context-entries "$via_s3" \
  "$(ctx kms:EncryptionContext:aws:s3:arn "$lake_arn")")" "allowed"
check "dynamodb:Query (neg)"                 "$(sim "$role" dynamodb:Query "$table_arn")" "implicitDeny"
check "dynamodb:PutItem (neg)"               "$(sim "$role" dynamodb:PutItem "$table_arn")" "implicitDeny"
check "events:PutEvents (neg)"               "$(sim "$role" events:PutEvents "arn:aws:events:${region}:${account}:event-bus/brewline-${env_name}")" "implicitDeny"

# --- 6) 排程角色 / Scheduler role ---
srole=$(jq -r .Target.RoleArn <<<"$sch")
check "Scheduler role name" "${srole##*/}" "brewline-${env_name}-ais-spike-scheduler"
fn_arn=$(jq -r .FunctionArn <<<"$cfg")
check "Scheduler: invoke sampler"              "$(sim "$srole" lambda:InvokeFunction "$fn_arn")" "allowed"
check "Scheduler: invoke simulator-run (neg)"  "$(sim "$srole" lambda:InvokeFunction "arn:aws:lambda:${region}:${account}:function:brewline-${env_name}-simulator-run")" "implicitDeny"
check "Scheduler: send to shipment-dlq"        "$(sim "$srole" sqs:SendMessage "$dlq_arn")" "allowed"
trust=$(aws iam get-role --role-name "${srole##*/}" --query Role.AssumeRolePolicyDocument --output json)
check "Scheduler trust aws:SourceArn = group" "$(jq -r '.Statement[0].Condition.StringEquals["aws:SourceArn"]' <<<"$trust")" \
  "arn:aws:scheduler:${region}:${account}:schedule-group/${group}"

exit "$fail"
