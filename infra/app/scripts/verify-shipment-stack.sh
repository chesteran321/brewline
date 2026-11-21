#!/usr/bin/env bash
# 部署後驗證海運追蹤（P2b-2，ADR-032）：偵測函數、預設 bus 規則、shipment-dlq＋告警、Glue 表 positions，
# 以及偵測函數角色的政策模擬（正向：讀位置檔、寫 SHIP#、只改邊的 status；反向：讀其他前綴、Scan、刪除、改 LOT# 的其他欄位）。
# Post-deploy verification of shipment tracking, including policy simulations for the detector role.
#
# 以 lookup role（ReadOnlyAccess）執行：只讀，不寫任何東西 / Runs as the read-only lookup role.
# 用法 Usage: scripts/verify-shipment-stack.sh <dev|prod> <outputs.json>
set -euo pipefail

env_name="${1:?usage: verify-shipment-stack.sh <dev|prod> <outputs.json>}"
outputs="${2:?usage: verify-shipment-stack.sh <dev|prod> <outputs.json>}"
region=ap-east-2
stack="brewline-${env_name}-shipment"
case "$env_name" in
  dev)  want_termination_protection=false ;;
  prod) want_termination_protection=true ;;
  *) echo "unknown env: $env_name" >&2; exit 2 ;;
esac

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

# --- 1) Stack ---
check "Termination protection" "$(aws cloudformation describe-stacks --stack-name "$stack" --region "$region" \
  --query 'Stacks[0].EnableTerminationProtection' --output text | tr '[:upper:]' '[:lower:]')" "$want_termination_protection"

# --- 2) 偵測函數 / Detector function ---
fn=$(out DetectorFunctionName)
check "Detector function name" "$fn" "brewline-${env_name}-shipment-voyage-detector"
check "SSM detector-function-name = output" "$(ssm "/brewline/${env_name}/shipment/detector-function-name")" "$fn"
cfg=$(aws lambda get-function-configuration --function-name "$fn" --region "$region" --output json)
check "Detector runtime"      "$(jq -r .Runtime <<<"$cfg")" "nodejs24.x"
check "Detector architecture" "$(jq -c .Architectures <<<"$cfg")" '["arm64"]'
check "Detector tracing"      "$(jq -r .TracingConfig.Mode <<<"$cfg")" "Active"
check "Detector timeout (s)"  "$(jq -r .Timeout <<<"$cfg")" "60"
check "Detector env LAKE_BUCKET" "$(jq -r .Environment.Variables.LAKE_BUCKET <<<"$cfg")" "$lake"
check "Detector reserved concurrency (files in sequence)" "$(aws lambda get-function-concurrency --function-name "$fn" --region "$region" \
  --query ReservedConcurrentExecutions --output text)" "1"
eic=$(aws lambda get-function-event-invoke-config --function-name "$fn" --region "$region" --output json)
check "Detector async retries" "$(jq -r .MaximumRetryAttempts <<<"$eic")" "2"
check "Detector async on-failure → DLQ" "$(jq -r '.DestinationConfig.OnFailure.Destination // "none"' <<<"$eic")" "$dlq_arn"

# --- 3) 規則（預設 bus，E5）/ Rule on the default bus ---
rule=$(aws events describe-rule --name "brewline-${env_name}-shipment-positions" --region "$region" --output json)
check "Rule state" "$(jq -r .State <<<"$rule")" "ENABLED"
check "Rule on the default bus" "$(jq -r .EventBusName <<<"$rule")" "default"
pattern=$(jq -r .EventPattern <<<"$rule")
check "Rule source"      "$(jq -c .source <<<"$pattern")" '["aws.s3"]'
check "Rule detail-type" "$(jq -c '.["detail-type"]' <<<"$pattern")" '["Object Created"]'
check "Rule bucket = lake" "$(jq -c .detail.bucket.name <<<"$pattern")" "[\"${lake}\"]"
check "Rule key prefix" "$(jq -c .detail.object.key <<<"$pattern")" '[{"prefix":"raw/positions/"}]'
tgt=$(aws events list-targets-by-rule --rule "brewline-${env_name}-shipment-positions" --region "$region" --output json)
check "Rule targets" "$(jq '.Targets | length' <<<"$tgt")" "1"
check "Rule target = detector" "$(jq -r '.Targets[0].Arn | endswith(":function:'"$fn"'")' <<<"$tgt")" "true"
check "Rule target DLQ" "$(jq -r '.Targets[0].DeadLetterConfig.Arn // "none"' <<<"$tgt")" "$dlq_arn"
check "Rule target retries" "$(jq -r .Targets[0].RetryPolicy.MaximumRetryAttempts <<<"$tgt")" "3"

# --- 4) DLQ＋告警 / DLQ and alarm ---
dlq=$(aws sqs get-queue-attributes --queue-url "$(out DlqUrl)" --region "$region" \
  --attribute-names SqsManagedSseEnabled ApproximateNumberOfMessages Policy --output json)
check "DLQ SSE-SQS" "$(jq -r .Attributes.SqsManagedSseEnabled <<<"$dlq")" "true"
check "DLQ empty"   "$(jq -r .Attributes.ApproximateNumberOfMessages <<<"$dlq")" "0"
check "DLQ TLS only" "$(jq -r '.Attributes.Policy | fromjson | [.Statement[] | select(.Effect == "Deny" and .Condition.Bool["aws:SecureTransport"] == "false")] | length > 0' <<<"$dlq")" "true"
alarm=$(aws cloudwatch describe-alarms --alarm-names "brewline-${env_name}-shipment-dlq-not-empty" --region "$region" --output json)
check "DLQ alarm exists" "$(jq '.MetricAlarms | length' <<<"$alarm")" "1"
check "DLQ alarm notifies ALARM and OK" "$(jq '[.MetricAlarms[] | select((.AlarmActions | length) > 0 and (.OKActions | length) > 0)] | length' <<<"$alarm")" "1"
check "DLQ alarm not in ALARM" "$(jq -r '.MetricAlarms[0].StateValue != "ALARM"' <<<"$alarm")" "true"
total=$(aws cloudwatch describe-alarms --region "$region" --query 'length(MetricAlarms)' --output text)
check "Account alarms ≤ 13 (ADR-030 D9 revised)" "$([[ "$total" -le 13 ]] && echo "true ($total)" || echo "false ($total)")" "true ($total)"

# --- 5) Glue 表 positions / Positions table ---
pt=$(aws glue get-table --database-name brewline_raw --name positions --region "$region" --query Table --output json)
check "positions location" "$(jq -r .StorageDescriptor.Location <<<"$pt")" "s3://${lake}/raw/positions/"
check "positions partitions" "$(jq -r '[.PartitionKeys[].Name] | join(",")' <<<"$pt")" "source,dt"
check "positions projection" "$(jq -r '.Parameters | "\(."projection.enabled") \(."projection.source.values") \(."projection.dt.range")"' <<<"$pt")" "true sim,ais 2026-11-21,NOW"
check "positions location template" "$(jq -r '.Parameters."storage.location.template"' <<<"$pt")" "s3://${lake}/raw/positions/source=\${source}/dt=\${dt}/"
check "positions malformed JSON fails" "$(jq -r '.StorageDescriptor.SerdeInfo.Parameters."ignore.malformed.json"' <<<"$pt")" "false"
check "positions synthetic = mixed" "$(jq -r .Parameters.synthetic <<<"$pt")" "mixed"

# --- 6) 偵測函數角色：政策模擬（只算身分政策）/ Detector role: policy simulation ---
role=$(jq -r .Role <<<"$cfg")
sim() {  # sim <action> <resource> [context-entries...]
  local a=$1 res=$2; shift 2
  aws iam simulate-principal-policy --policy-source-arn "$role" --action-names "$a" --resource-arns "$res" "$@" \
    --query 'EvaluationResults[0].EvalDecision' --output text
}
lk() { echo "ContextKeyName=dynamodb:LeadingKeys,ContextKeyValues=$1,ContextKeyType=stringList"; }
attrs() { echo "ContextKeyName=dynamodb:Attributes,ContextKeyValues=$1,ContextKeyType=stringList"; }
check "GetObject raw/positions/"         "$(sim s3:GetObject "${lake_arn}/raw/positions/source=sim/dt=2026-11-23/0020.jsonl.gz")" "allowed"
check "GetObject raw/events/ (neg)"      "$(sim s3:GetObject "${lake_arn}/raw/events/dt=2026-11-23/x.gz")" "implicitDeny"
check "GetObject curated/ (neg)"         "$(sim s3:GetObject "${lake_arn}/curated/x")" "implicitDeny"
check "PutObject raw/positions/ (neg)"   "$(sim s3:PutObject "${lake_arn}/raw/positions/source=sim/x")" "implicitDeny"
via_s3="ContextKeyName=kms:ViaService,ContextKeyValues=s3.${region}.amazonaws.com,ContextKeyType=string"
check "KMS Decrypt via S3 (bucket context)" "$(sim kms:Decrypt "$key_arn" --context-entries "$via_s3" \
  "ContextKeyName=kms:EncryptionContext:aws:s3:arn,ContextKeyValues=${lake_arn},ContextKeyType=string")" "allowed"
check "KMS Decrypt direct (neg)"         "$(sim kms:Decrypt "$key_arn")" "implicitDeny"
check "Query VESSEL#"                    "$(sim dynamodb:Query "$table_arn" --context-entries "$(lk 'VESSEL#SIMV-01')")" "allowed"
check "Query TENANT# (neg)"              "$(sim dynamodb:Query "$table_arn" --context-entries "$(lk 'TENANT#t_x')")" "implicitDeny"
check "UpdateItem SHIP#"                 "$(sim dynamodb:UpdateItem "$table_arn" --context-entries "$(lk 'SHIP#s_x')")" "allowed"
check "PutItem SHIP# (events, track)"    "$(sim dynamodb:PutItem "$table_arn" --context-entries "$(lk 'SHIP#s_x')")" "allowed"
check "UpdateItem LOT# edge status"      "$(sim dynamodb:UpdateItem "$table_arn" --context-entries "$(lk 'LOT#L-1')" "$(attrs 'pk,sk,status')")" "allowed"
check "UpdateItem LOT# other field (neg)" "$(sim dynamodb:UpdateItem "$table_arn" --context-entries "$(lk 'LOT#L-1')" "$(attrs 'pk,sk,origin')")" "implicitDeny"
check "PutItem LOT# (neg)"               "$(sim dynamodb:PutItem "$table_arn" --context-entries "$(lk 'LOT#L-1')")" "implicitDeny"
check "DeleteItem SHIP# (neg)"           "$(sim dynamodb:DeleteItem "$table_arn" --context-entries "$(lk 'SHIP#s_x')")" "implicitDeny"
check "Scan (explicit deny)"             "$(sim dynamodb:Scan "$table_arn")" "explicitDeny"
check "events:PutEvents (neg)"           "$(sim events:PutEvents "arn:aws:events:${region}:${account}:event-bus/brewline-${env_name}")" "implicitDeny"

exit "$fail"
