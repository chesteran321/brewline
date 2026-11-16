#!/usr/bin/env bash
# 部署後驗證維運通知（A4b，ADR-029）：SNS 主題（CMK、TLS、發布者）、所有告警都接上主題、StockLow 規則。
# Post-deploy verification of ops notifications: topic (CMK, TLS, publishers), alarm wiring, StockLow rule.
#
# 用法 Usage: scripts/verify-ops-stack.sh <dev|prod> <outputs.json>
set -euo pipefail

env_name="${1:?usage: verify-ops-stack.sh <dev|prod> <outputs.json>}"
outputs="${2:?usage: verify-ops-stack.sh <dev|prod> <outputs.json>}"
region="${AWS_REGION:-ap-east-2}"
stack="brewline-${env_name}-ops"
case "$env_name" in
  dev)  want_termination_protection=false ;;
  prod) want_termination_protection=true ;;
  *) echo "unknown env: $env_name" >&2; exit 2 ;;
esac

fail=0
check() { if [[ "$2" == "$3" ]]; then echo "✅ $1 = $2"; else echo "❌ $1 = $2 (expected $3)"; fail=1; fi; }

aws sts get-caller-identity --query Arn --output text
topic=$(jq -r --arg s "$stack" '.[$s].AlertsTopicArn // empty' "$outputs")
key_arn=$(aws ssm get-parameter --name "/brewline/${env_name}/data/kms-key-arn" --region "$region" --query Parameter.Value --output text)

attrs=$(aws sns get-topic-attributes --topic-arn "$topic" --region "$region" --query Attributes --output json)
check "SSM alerts-topic-arn" "$(aws ssm get-parameter --name "/brewline/${env_name}/ops/alerts-topic-arn" --region "$region" \
  --query Parameter.Value --output text)" "$topic"
check "Topic KMS key = account CMK" "$(jq -r .KmsMasterKeyId <<<"$attrs")" "$key_arn"
policy=$(jq -r .Policy <<<"$attrs")
check "Topic policy denies non-TLS" "$(jq '[.Statement[] | select(.Effect == "Deny" and .Condition.Bool["aws:SecureTransport"] == "false")] | length' <<<"$policy")" "1"
check "Topic publishers" "$(jq -c '[.Statement[] | select(.Sid == "AllowAlarmsAndRulesToPublish") | .Principal.Service] | flatten | sort' <<<"$policy")" \
  '["cloudwatch.amazonaws.com","events.amazonaws.com"]'
check "Topic publisher condition = this account" \
  "$(jq -r '.Statement[] | select(.Sid == "AllowAlarmsAndRulesToPublish") | .Condition.StringEquals["aws:SourceAccount"]' <<<"$policy")" \
  "$(cut -d: -f5 <<<"$topic")"
# 反向：沒有對任何人開放的 Allow / Negative: no Allow for Principal "*".
check "Public allow statements" "$(jq '[.Statement[] | select(.Effect == "Allow" and (.Principal == "*" or .Principal.AWS == "*"))] | length' <<<"$policy")" "0"

# 所有 brewline-<env>-* 告警都通知這個主題（ALARM 與 OK）/ Every alarm notifies the topic.
alarms=$(aws cloudwatch describe-alarms --alarm-name-prefix "brewline-${env_name}-" --region "$region" --output json)
total=$(jq '.MetricAlarms | length' <<<"$alarms")
wired=$(jq --arg t "$topic" '[.MetricAlarms[] | select((.AlarmActions | index($t)) and (.OKActions | index($t)))] | length' <<<"$alarms")
check "Alarms (brewline-${env_name}-*)" "$total" "5"
check "Alarms notifying the topic (ALARM + OK)" "$wired" "$total"

rule=$(aws events describe-rule --name "brewline-${env_name}-stock-low" --event-bus-name "brewline-${env_name}" --region "$region" --output json)
check "StockLow rule state" "$(jq -r .State <<<"$rule")" "ENABLED"
check "StockLow rule target = topic" "$(aws events list-targets-by-rule --rule "brewline-${env_name}-stock-low" \
  --event-bus-name "brewline-${env_name}" --region "$region" --query 'Targets[0].Arn' --output text)" "$topic"

check "Stack termination protection" "$(aws cloudformation describe-stacks --stack-name "$stack" --region "$region" \
  --query 'Stacks[0].EnableTerminationProtection' --output text | tr '[:upper:]' '[:lower:]')" "$want_termination_protection"

# 訂閱是手動的（Email 不進 repo）→ 只顯示，不判定 / Subscriptions are manual: informational only.
confirmed=$(aws sns list-subscriptions-by-topic --topic-arn "$topic" --region "$region" --output json \
  | jq '[.Subscriptions[] | select(.SubscriptionArn | startswith("arn:"))] | length')
echo "ℹ️  Confirmed subscriptions: ${confirmed}（手動訂閱，見 PR 說明 / manual, see the PR）"

exit "$fail"
