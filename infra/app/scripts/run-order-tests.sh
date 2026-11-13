#!/usr/bin/env bash
# 手動執行 Dev 訂單測試（A2b-2，ADR-025）：冪等風暴、搶庫存（不超賣）、用租戶真實憑證的 IAM 探測。
# Run the Dev order tests manually: idempotency storm, stock race (no overselling), IAM probe with tenant credentials.
#
# 用法 Usage: scripts/run-order-tests.sh          （需要 lambda:InvokeFunction；Developer 或 Admin）
# 測試會重設 p-9001 庫存並清除兩個固定測試租戶的資料，不影響其他資料。
# Resets p-9001 stock and cleans two fixed test tenants; nothing else is touched.
set -euo pipefail
export AWS_PAGER=""
region="${AWS_REGION:-ap-east-2}"
fn="brewline-dev-ordering-order-tests"

aws sts get-caller-identity --query Arn --output text
out=$(mktemp)
trap 'rm -f "$out"' EXIT

meta=$(aws lambda invoke --function-name "$fn" --region "$region" \
  --cli-read-timeout 180 --payload '{}' --cli-binary-format raw-in-base64-out "$out")
if jq -e '.FunctionError' <<<"$meta" >/dev/null; then
  echo "❌ Function error:"; cat "$out"; echo; exit 1
fi

jq -r '.checks[] | "\(if .ok then "✅" else "❌" end) \(.name) — \(.detail)"' "$out"
echo
echo "stats: $(jq -c '.stats' "$out")"
if jq -e '.passed == true' "$out" >/dev/null; then
  echo "PASSED ($(jq '[.checks[] | select(.ok)] | length' "$out")/$(jq '.checks | length' "$out"))"
else
  echo "FAILED"; exit 1
fi
