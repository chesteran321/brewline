#!/usr/bin/env bash
# 部署後驗證事件層（A3b，ADR-026）：bus、Streams 事件來源對應、稽核規則、DLQ、告警；Dev 另檢查 smoke test 下的單有產生事件。
# Post-deploy verification of the event layer; in Dev also checks that smoke-test orders produced OrderCreated events.
#
# 用法 Usage: scripts/verify-events-stack.sh <dev|prod> <outputs.json>
# 需要唯讀權限（CI 以 CDK lookup role 執行）/ Read-only (CI runs it as the CDK lookup role).
set -euo pipefail

env_name="${1:?usage: verify-events-stack.sh <dev|prod> <outputs.json>}"
outputs="${2:?usage: verify-events-stack.sh <dev|prod> <outputs.json>}"
region="${AWS_REGION:-ap-east-2}"
stack="brewline-${env_name}-events"

case "$env_name" in
  dev)  want_retention=7;  want_orders=true;  want_termination_protection=false ;;
  prod) want_retention=30; want_orders=false; want_termination_protection=true ;;
  *) echo "unknown env: $env_name" >&2; exit 2 ;;
esac

out() { jq -r --arg s "$stack" --arg k "$1" '.[$s][$k] // empty' "$outputs"; }
fail=0
check() { # check <label> <actual> <expected>
  if [[ "$2" == "$3" ]]; then echo "✅ $1 = $2"; else echo "❌ $1 = $2 (expected $3)"; fail=1; fi
}

aws sts get-caller-identity --query Arn --output text
bus="brewline-${env_name}"

# --- Bus 與 SSM / Bus and SSM ---
check "Bus exists" "$(aws events describe-event-bus --name "$bus" --region "$region" --query Name --output text 2>/dev/null || echo missing)" "$bus"
check "SSM bus-name" "$(aws ssm get-parameter --name "/brewline/${env_name}/events/bus-name" --region "$region" \
  --query Parameter.Value --output text)" "$bus"

# --- Streams 事件來源對應 / Stream event source mapping ---
esm=$(aws lambda get-event-source-mapping --uuid "$(out StreamMappingId)" --region "$region" --output json)
stream_arn=$(aws ssm get-parameter --name "/brewline/${env_name}/data/table-stream-arn" --region "$region" --query Parameter.Value --output text)
check "Mapping state"            "$(jq -r .State <<<"$esm")" "Enabled"
check "Mapping source = table stream (SSM)" "$(jq -r .EventSourceArn <<<"$esm")" "$stream_arn"
check "Mapping partial failures" "$(jq -c .FunctionResponseTypes <<<"$esm")" '["ReportBatchItemFailures"]'
check "Mapping retries"          "$(jq -r .MaximumRetryAttempts <<<"$esm")" "3"
check "Mapping bisect on error"  "$(jq -r .BisectBatchOnFunctionError <<<"$esm")" "true"
check "Mapping on-failure → DLQ" "$(jq -r '.DestinationConfig.OnFailure.Destination // "none" | test(":events-stream-dlq$")' <<<"$esm")" "true"
check "Mapping filters"          "$(jq -r '.FilterCriteria.Filters | length' <<<"$esm")" "2"

fn=$(out PublisherFunctionName)
cfg=$(aws lambda get-function-configuration --function-name "$fn" --region "$region" --output json)
check "Publisher runtime"      "$(jq -r .Runtime <<<"$cfg")" "nodejs24.x"
check "Publisher architecture" "$(jq -c .Architectures <<<"$cfg")" '["arm64"]'
check "Publisher tracing"      "$(jq -r .TracingConfig.Mode <<<"$cfg")" "Active"
check "Publisher reserved concurrency" "$(aws lambda get-function-concurrency --function-name "$fn" --region "$region" \
  --query ReservedConcurrentExecutions --output text)" "2"

# --- 稽核規則與 log / Audit rule and log ---
rule=$(aws events describe-rule --name "brewline-${env_name}-audit-log" --event-bus-name "$bus" --region "$region" --output json)
check "Audit rule state"   "$(jq -r .State <<<"$rule")" "ENABLED"
check "Audit rule pattern" "$(jq -r .EventPattern <<<"$rule" | jq -c .)" '{"source":[{"prefix":"brewline."}]}'
log_group=$(out EventLogGroup)
check "Event log retention" "$(aws logs describe-log-groups --log-group-name-prefix "$log_group" --region "$region" \
  --query 'logGroups[0].retentionInDays' --output text)" "$want_retention"

# --- DLQ（反向：應該是空的）/ DLQs (negative: should be empty) ---
for q in StreamDlqUrl RuleDlqUrl; do
  attrs=$(aws sqs get-queue-attributes --queue-url "$(out "$q")" --region "$region" \
    --attribute-names SqsManagedSseEnabled ApproximateNumberOfMessages --output json)
  check "$q SSE-SQS"   "$(jq -r .Attributes.SqsManagedSseEnabled <<<"$attrs")" "true"
  check "$q messages"  "$(jq -r .Attributes.ApproximateNumberOfMessages <<<"$attrs")" "0"
done

# --- 告警 / Alarms ---
alarms=$(aws cloudwatch describe-alarms --alarm-name-prefix "brewline-${env_name}-events-" --region "$region" --output json)
check "Alarm count" "$(jq '.MetricAlarms | length' <<<"$alarms")" "3"
check "Alarms in ALARM" "$(jq '[.MetricAlarms[] | select(.StateValue == "ALARM")] | length' <<<"$alarms")" "0"

check "Stack termination protection" "$(aws cloudformation describe-stacks --stack-name "$stack" --region "$region" \
  --query 'Stacks[0].EnableTerminationProtection' --output text | tr '[:upper:]' '[:lower:]')" "$want_termination_protection"

# --- 事件內容 / Event content ---
since=$(( ($(date +%s) - 3600) * 1000 ))
count() { # count <filter pattern> → number of matching log events in the last hour
  aws logs filter-log-events --log-group-name "$log_group" --region "$region" --start-time "$since" \
    --filter-pattern "$1" --query 'length(events)' --output text 2>/dev/null || echo error
}
if [[ "$want_orders" == true ]]; then
  # smoke test 剛下過單（A 租戶）→ 應該有 OrderCreated；給 stream 與 bus 一點時間
  # The smoke test just placed orders for tenant A; allow a little time for stream + bus delivery.
  created=0
  for _ in 1 2 3 4 5 6; do
    created=$(count '{ ($.detail-type = "OrderCreated") && ($.detail.tenant_id = "t_01SMKTEST000000000000000A1") }')
    [[ "$created" =~ ^[0-9]+$ && "$created" -ge 1 ]] && break
    sleep 10
  done
  check "Smoke-test OrderCreated events (last hour) ≥ 1" "$([[ "$created" =~ ^[0-9]+$ && "$created" -ge 1 ]] && echo true || echo "false ($created)")" "true"
  check "Events with source brewline.ordering" "$( n=$(count '{ $.source = "brewline.ordering" }'); [[ "$n" =~ ^[0-9]+$ && "$n" -ge 1 ]] && echo true || echo "false ($n)")" "true"
fi
# 反向：事件 detail 不可含使用者 sub、鍵、冪等鍵 / Negative: no user sub, keys or idempotency key in details.
# 以文字比對（引號內為字面字串）/ Literal term matches.
check "Events containing created_by"      "$(count '"created_by"')" "0"
check "Events containing idempotency_key" "$(count '"idempotency_key"')" "0"
check "Events containing a TENANT# key"   "$(count '"TENANT#"')" "0"

exit "$fail"
