#!/usr/bin/env bash
# 部署後驗證訂單通知信（A4d，ADR-029）：SES 網域身分（DKIM、MAIL FROM）、DNS（DMARC、委派）、configuration set、
# 通知函數與規則。**不印出任何收件地址**。
# Post-deploy verification of order e-mail: SES identity, DNS, configuration set, notifier and rules.
# Never prints a recipient address.
#
# 用法 Usage: scripts/verify-notify-stack.sh <dev|prod> <outputs.json>
# DNS 相關狀態（DKIM、MAIL FROM）在委派生效前是 PENDING → 顯示 ⏳，不判定失敗；FAILED 才算失敗。
# DNS-dependent states are PENDING until delegation propagates → shown as ⏳, not failures; FAILED fails.
set -euo pipefail

env_name="${1:?usage: verify-notify-stack.sh <dev|prod> <outputs.json>}"
outputs="${2:?usage: verify-notify-stack.sh <dev|prod> <outputs.json>}"
region="${AWS_REGION:-ap-east-2}"
stack="brewline-${env_name}-notify"
case "$env_name" in
  dev)  domain="dev.brewline-demo.click"; want_termination_protection=false ;;
  prod) domain="brewline-demo.click";     want_termination_protection=true ;;
  *) echo "unknown env: $env_name" >&2; exit 2 ;;
esac

fail=0
check() { if [[ "$2" == "$3" ]]; then echo "✅ $1 = $2"; else echo "❌ $1 = $2 (expected $3)"; fail=1; fi; }
# dns_state <label> <state>：SUCCESS ✅、PENDING／NOT_STARTED ⏳、其他 ❌
dns_state() {
  case "$2" in
    SUCCESS|true) echo "✅ $1 = $2" ;;
    PENDING|NOT_STARTED|TEMPORARY_FAILURE|false) echo "⏳ $1 = $2（等 DNS 委派生效 / waiting for DNS）" ;;
    *) echo "❌ $1 = $2"; fail=1 ;;
  esac
}
out() { jq -r --arg s "$stack" --arg k "$1" '.[$s][$k] // empty' "$outputs"; }

aws sts get-caller-identity --query Arn --output text
topic=$(aws ssm get-parameter --name "/brewline/${env_name}/ops/alerts-topic-arn" --region "$region" --query Parameter.Value --output text)
zone_id=$(out HostedZoneId)
config_set=$(out ConfigurationSetName)

# --- SES 網域身分 / Domain identity ---
id=$(aws sesv2 get-email-identity --email-identity "$domain" --region "$region" --output json)
check "Identity type" "$(jq -r .IdentityType <<<"$id")" "DOMAIN"
check "DKIM signing key" "$(jq -r '.DkimAttributes.CurrentSigningKeyLength // .DkimAttributes.NextSigningKeyLength' <<<"$id")" "RSA_2048_BIT"
check "DKIM signing enabled" "$(jq -r .DkimAttributes.SigningEnabled <<<"$id")" "true"
dns_state "DKIM status" "$(jq -r .DkimAttributes.Status <<<"$id")"
dns_state "Verified for sending" "$(jq -r .VerifiedForSendingStatus <<<"$id")"
check "MAIL FROM domain" "$(jq -r .MailFromAttributes.MailFromDomain <<<"$id")" "mail.${domain}"
check "MAIL FROM on MX failure" "$(jq -r .MailFromAttributes.BehaviorOnMxFailure <<<"$id")" "REJECT_MESSAGE"
dns_state "MAIL FROM status" "$(jq -r .MailFromAttributes.MailFromDomainStatus <<<"$id")"
check "Identity configuration set" "$(jq -r .ConfigurationSetName <<<"$id")" "$config_set"

# --- DNS（Route 53 記錄本身，不依賴傳播）/ Records in the zone ---
records=$(aws route53 list-resource-record-sets --hosted-zone-id "$zone_id" --output json)
rr() { jq -r --arg n "$1" --arg t "$2" '[.ResourceRecordSets[] | select(.Name == $n and .Type == $t) | .ResourceRecords[].Value] | join(" ")' <<<"$records"; }
check "DMARC record" "$(rr "_dmarc.${domain}." TXT)" '"v=DMARC1; p=quarantine; adkim=s; aspf=r"'
check "MAIL FROM MX" "$(rr "mail.${domain}." MX)" "10 feedback-smtp.${region}.amazonses.com"
check "MAIL FROM SPF" "$(rr "mail.${domain}." TXT)" '"v=spf1 include:amazonses.com ~all"'
check "DKIM CNAMEs" "$(jq '[.ResourceRecordSets[] | select(.Type == "CNAME" and (.Name | test("_domainkey")))] | length' <<<"$records")" "3"
if [[ "$env_name" == "prod" ]]; then
  ns=$(rr "dev.${domain}." NS)
  if [[ -n "$ns" ]]; then echo "✅ dev. delegation = ${ns}"; else echo "⏳ dev. delegation not configured yet（config mail.delegations）"; fi
fi
# 公開 DNS（委派是否生效）/ Public DNS: is the zone reachable?
if command -v dig >/dev/null; then
  pub=$(dig +short TXT "_dmarc.${domain}" | tr -d '\n')
  if [[ "$pub" == *"p=quarantine"* ]]; then echo "✅ Public DNS DMARC = $pub"; else echo "⏳ Public DNS DMARC not visible yet ($pub)"; fi
fi

# --- Configuration set ---
cs=$(aws sesv2 get-configuration-set --configuration-set-name "$config_set" --region "$region" --output json)
check "TLS policy" "$(jq -r .DeliveryOptions.TlsPolicy <<<"$cs")" "REQUIRE"
check "Suppression reasons" "$(jq -c '.SuppressionOptions.SuppressedReasons | sort' <<<"$cs")" '["BOUNCE","COMPLAINT"]'
dests=$(aws sesv2 get-configuration-set-event-destinations --configuration-set-name "$config_set" --region "$region" --output json)
check "Event destination → ops topic" "$(jq -r '.EventDestinations[0].SnsDestination.TopicArn' <<<"$dests")" "$topic"
check "Event types" "$(jq -c '.EventDestinations[0].MatchingEventTypes | sort' <<<"$dests")" '["BOUNCE","COMPLAINT","DELIVERY_DELAY","REJECT","RENDERING_FAILURE"]'

# --- 通知函數與規則 / Notifier and rules ---
fn=$(out NotifierFunctionName)
cfg=$(aws lambda get-function-configuration --function-name "$fn" --region "$region" --output json)
check "Notifier runtime" "$(jq -r .Runtime <<<"$cfg")" "nodejs24.x"
check "Notifier role" "$(jq -r '.Role | split("/") | last' <<<"$cfg")" "brewline-${env_name}-orders-notify"
check "Notifier From address" "$(jq -r .Environment.Variables.FROM_ADDRESS <<<"$cfg")" "orders@${domain}"
check "Notifier reserved concurrency" "$(aws lambda get-function-concurrency --function-name "$fn" --region "$region" \
  --query ReservedConcurrentExecutions --output text)" "1"
eic=$(aws lambda get-function-event-invoke-config --function-name "$fn" --region "$region" --output json)
check "Async retries" "$(jq -r .MaximumRetryAttempts <<<"$eic")" "2"
check "Async on-failure → notify DLQ" "$(jq -r '.DestinationConfig.OnFailure.Destination | split(":") | last' <<<"$eic")" "brewline-${env_name}-notify-dlq"
role="brewline-${env_name}-orders-notify"
actions=$(for p in $(aws iam list-role-policies --role-name "$role" --query 'PolicyNames[]' --output text); do
    aws iam get-role-policy --role-name "$role" --policy-name "$p" --query 'PolicyDocument.Statement' --output json
  done | jq -s -c '[.[][] | select(.Effect == "Allow") | .Action] | flatten | map(select(startswith("dynamodb:") or startswith("kms:"))) | unique')
# 反向：函數本身碰不到資料表與金鑰（只能透過租戶角色）/ Negative: no direct table or key access.
check "Notifier DynamoDB/KMS allows" "$actions" "[]"
send_from=$(for p in $(aws iam list-role-policies --role-name "$role" --query 'PolicyNames[]' --output text); do
    aws iam get-role-policy --role-name "$role" --policy-name "$p" --query 'PolicyDocument.Statement' --output json
  done | jq -s -r '[.[][] | select(.Sid == "SendOrderMail") | .Condition.StringEquals["ses:FromAddress"]] | first')
check "SES SendEmail pinned to From" "$send_from" "orders@${domain}"

for rule in mail-order-created mail-order-status; do
  name="brewline-${env_name}-${rule}"
  check "Rule $rule state" "$(aws events describe-rule --name "$name" --event-bus-name "brewline-${env_name}" --region "$region" \
    --query State --output text)" "ENABLED"
  check "Rule $rule target" "$(aws events list-targets-by-rule --rule "$name" --event-bus-name "brewline-${env_name}" --region "$region" \
    --query 'Targets[0].Arn' --output text | awk -F: '{print $NF}')" "$fn"
done
check "Status rule pattern" "$(aws events describe-rule --name "brewline-${env_name}-mail-order-status" --event-bus-name "brewline-${env_name}" \
  --region "$region" --query EventPattern --output text | jq -c '.detail.status | sort')" '["CANCELLED","CONFIRMED","SHIPPED"]'
check "Notify DLQ messages" "$(aws sqs get-queue-attributes --queue-url "$(out NotifyDlqUrl)" --region "$region" \
  --attribute-names ApproximateNumberOfMessages --query Attributes.ApproximateNumberOfMessages --output text)" "0"

check "Stack termination protection" "$(aws cloudformation describe-stacks --stack-name "$stack" --region "$region" \
  --query 'Stacks[0].EnableTerminationProtection' --output text | tr '[:upper:]' '[:lower:]')" "$want_termination_protection"

# 帳號層級：沙盒（ADR-029 E4）／ 只顯示 / Account level: sandbox, informational.
acct=$(aws sesv2 get-account --region "$region" --output json)
echo "ℹ️  SES production access: $(jq -r .ProductionAccessEnabled <<<"$acct")（false = 沙盒 sandbox）; sending: $(jq -r .SendingEnabled <<<"$acct")"
exit "$fail"
