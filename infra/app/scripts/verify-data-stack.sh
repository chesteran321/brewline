#!/usr/bin/env bash
# 部署後驗證共用資料層：查詢 AWS 實際狀態，而不是只看 template。
# Post-deploy verification of the shared data layer: checks real AWS state, not just the template.
#
# 用法 Usage: scripts/verify-data-stack.sh <dev|prod> <outputs.json>
# 需要唯讀權限（CI 以 CDK lookup role 執行，它有 ReadOnlyAccess）。
# Needs read-only access (CI runs it as the CDK lookup role, which has ReadOnlyAccess).
set -euo pipefail

env_name="${1:?usage: verify-data-stack.sh <dev|prod> <outputs.json>}"
outputs="${2:?usage: verify-data-stack.sh <dev|prod> <outputs.json>}"
region="${AWS_REGION:-ap-east-2}"
stack="brewline-${env_name}-data"

case "$env_name" in
  dev)  want_deletion_protection=false; want_termination_protection=false ;;
  prod) want_deletion_protection=true;  want_termination_protection=true ;;
  *) echo "unknown env: $env_name" >&2; exit 2 ;;
esac

table=$(jq -r --arg s "$stack" '.[$s].TableName' "$outputs")
key_arn=$(jq -r --arg s "$stack" '.[$s].KeyArn' "$outputs")
fail=0

check() { # check <label> <actual> <expected>
  if [[ "$2" == "$3" ]]; then
    echo "✅ $1 = $2"
  else
    echo "❌ $1 = $2 (expected $3)"
    fail=1
  fi
}

aws sts get-caller-identity --query Arn --output text

# 等 GSI 變成 ACTIVE 再驗證。AWS::DynamoDB::GlobalTable 在索引仍是 CREATING（回填中）時
# 就會回報 UPDATE_COMPLETE，所以「CloudFormation 完成」不等於「索引可用」（2026-11-12 實測）。
# Wait for GSIs to become ACTIVE: GlobalTable reports UPDATE_COMPLETE while an index is still CREATING.
max_wait_checks=80   # 80 × 15 s = 20 分鐘 / minutes（實測 Dev 空表約 8 分鐘）
for ((i = 1; i <= max_wait_checks; i++)); do
  pending=$(aws dynamodb describe-table --table-name "$table" --region "$region" \
    --query 'Table.GlobalSecondaryIndexes[?IndexStatus!=`ACTIVE`].[IndexName, IndexStatus]' --output text)
  # 沒有 GSI 時 JMESPath 回 None / "None" means the table has no GSI at all.
  [[ -z "$pending" || "$pending" == "None" ]] && break
  echo "⏳ waiting for GSI to become ACTIVE ($i/$max_wait_checks): $(tr '\t\n' ' ;' <<<"$pending")"
  sleep 15
done

desc=$(aws dynamodb describe-table --table-name "$table" --region "$region" --output json)
check "TableStatus"               "$(jq -r '.Table.TableStatus' <<<"$desc")" "ACTIVE"
check "SSE type"                  "$(jq -r '.Table.SSEDescription.SSEType' <<<"$desc")" "KMS"
check "SSE status"                "$(jq -r '.Table.SSEDescription.Status' <<<"$desc")" "ENABLED"
check "SSE key = stack CMK"       "$(jq -r '.Table.SSEDescription.KMSMasterKeyArn' <<<"$desc")" "$key_arn"
check "DeletionProtectionEnabled" "$(jq -r '.Table.DeletionProtectionEnabled' <<<"$desc")" "$want_deletion_protection"
check "Key schema"                "$(jq -c '[.Table.KeySchema[].AttributeName]' <<<"$desc")" '["pk","sk"]'

# GSI1（A1a）：ACTIVE、鍵、寫入上限與資料表相同 / GSI1 is ACTIVE with the expected keys and write cap.
gsi=$(jq -c '.Table.GlobalSecondaryIndexes // [] | map(select(.IndexName == "gsi1")) | .[0] // {}' <<<"$desc")
check "GSI count"         "$(jq -r '.Table.GlobalSecondaryIndexes // [] | length' <<<"$desc")" "1"
check "GSI1 status"       "$(jq -r '.IndexStatus' <<<"$gsi")" "ACTIVE"
check "GSI1 key schema"   "$(jq -c '[.KeySchema[]?.AttributeName]' <<<"$gsi")" '["gsi1pk","gsi1sk"]'
check "GSI1 projection"   "$(jq -r '.Projection.ProjectionType' <<<"$gsi")" "ALL"
check "GSI1 max write = table max write" \
  "$(jq -r '.OnDemandThroughput.MaxWriteRequestUnits' <<<"$gsi")" "$(jq -r '.Table.OnDemandThroughput.MaxWriteRequestUnits' <<<"$desc")"

check "PITR" "$(aws dynamodb describe-continuous-backups --table-name "$table" --region "$region" \
  --query 'ContinuousBackupsDescription.PointInTimeRecoveryDescription.PointInTimeRecoveryStatus' --output text)" "ENABLED"

check "TTL" "$(aws dynamodb describe-time-to-live --table-name "$table" --region "$region" \
  --query 'TimeToLiveDescription.[TimeToLiveStatus,AttributeName]' --output text | tr '\t' ' ')" "ENABLED expires_at"

check "KMS rotation" "$(aws kms get-key-rotation-status --key-id "$key_arn" --region "$region" \
  --query KeyRotationEnabled --output text)" "True"

check "SSM table-name" "$(aws ssm get-parameter --name "/brewline/${env_name}/data/table-name" --region "$region" \
  --query Parameter.Value --output text)" "$table"

check "Stack termination protection" "$(aws cloudformation describe-stacks --stack-name "$stack" --region "$region" \
  --query 'Stacks[0].EnableTerminationProtection' --output text | tr '[:upper:]' '[:lower:]')" "$want_termination_protection"

exit "$fail"
