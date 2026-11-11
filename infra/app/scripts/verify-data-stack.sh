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

desc=$(aws dynamodb describe-table --table-name "$table" --region "$region" --output json)
check "TableStatus"               "$(jq -r '.Table.TableStatus' <<<"$desc")" "ACTIVE"
check "SSE type"                  "$(jq -r '.Table.SSEDescription.SSEType' <<<"$desc")" "KMS"
check "SSE status"                "$(jq -r '.Table.SSEDescription.Status' <<<"$desc")" "ENABLED"
check "SSE key = stack CMK"       "$(jq -r '.Table.SSEDescription.KMSMasterKeyArn' <<<"$desc")" "$key_arn"
check "DeletionProtectionEnabled" "$(jq -r '.Table.DeletionProtectionEnabled' <<<"$desc")" "$want_deletion_protection"
check "Key schema"                "$(jq -c '[.Table.KeySchema[].AttributeName]' <<<"$desc")" '["pk","sk"]'

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
