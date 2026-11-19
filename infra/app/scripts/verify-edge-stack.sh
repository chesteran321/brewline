#!/usr/bin/env bash
# 部署後驗證溯源公開頁的 us-east-1 資源（S2b，ADR-031 D3／D4）：ACM 憑證、CLOUDFRONT web ACL（Free 方案 ≤ 5 條規則）。
# Post-deploy verification of the edge stack: ACM certificate and CLOUDFRONT web ACL (≤ 5 rules for the Free plan).
#
# 用法 Usage: scripts/verify-edge-stack.sh <dev|prod> <outputs.json>
set -euo pipefail

env_name="${1:?usage: verify-edge-stack.sh <dev|prod> <outputs.json>}"
outputs="${2:?usage: verify-edge-stack.sh <dev|prod> <outputs.json>}"
region=us-east-1   # CloudFront 的憑證與 web ACL 只能在這裡 / CloudFront certs and web ACLs live here only
stack="brewline-${env_name}-edge"
case "$env_name" in
  dev)  want_domain=trace.dev.brewline-demo.click; want_termination_protection=false ;;
  prod) want_domain=trace.brewline-demo.click;     want_termination_protection=true ;;
  *) echo "unknown env: $env_name" >&2; exit 2 ;;
esac

fail=0
check() { if [[ "$2" == "$3" ]]; then echo "✅ $1 = $2"; else echo "❌ $1 = $2 (expected $3)"; fail=1; fi; }
out() { jq -r --arg s "$stack" --arg k "$1" '.[$s][$k] // empty' "$outputs"; }

aws sts get-caller-identity --query Arn --output text
cert_arn=$(out TraceCertificateArn)
acl_arn=$(out TraceWebAclArn)

# --- 憑證 / Certificate ---
cert=$(aws acm describe-certificate --certificate-arn "$cert_arn" --region "$region" --query Certificate --output json)
check "Certificate region" "$(cut -d: -f4 <<<"$cert_arn")" "us-east-1"
check "Certificate domain" "$(jq -r .DomainName <<<"$cert")" "$want_domain"
# 反向：只涵蓋這一個名稱（沒有萬用字元、沒有多餘的 SAN）/ Negative: exactly one name, no wildcard.
check "Certificate names" "$(jq -c '.SubjectAlternativeNames' <<<"$cert")" "[\"$want_domain\"]"
check "Certificate status" "$(jq -r .Status <<<"$cert")" "ISSUED"
check "Certificate validation" "$(jq -r '.DomainValidationOptions[0].ValidationMethod' <<<"$cert")" "DNS"
check "Certificate type (ACM-managed, auto-renew)" "$(jq -r .Type <<<"$cert")" "AMAZON_ISSUED"
# ACM 只會自動續約「使用中」的憑證：S2c 掛上 CloudFront 之前是 INELIGIBLE，之後必須變成 ELIGIBLE。
# ACM renews only certificates in use: INELIGIBLE until S2c attaches it to CloudFront, ELIGIBLE afterwards.
in_use=$(jq '.InUseBy | length' <<<"$cert")
if [ "$in_use" -gt 0 ]; then
  check "Certificate renewal eligibility (in use by $in_use)" "$(jq -r .RenewalEligibility <<<"$cert")" "ELIGIBLE"
else
  check "Certificate renewal eligibility (not in use yet)" "$(jq -r .RenewalEligibility <<<"$cert")" "INELIGIBLE"
fi

# --- Web ACL ---
check "Web ACL ARN is global (CLOUDFRONT scope)" "$(cut -d: -f6 <<<"$acl_arn" | cut -d/ -f1)" "global"
acl_name=$(cut -d/ -f3 <<<"$acl_arn")
acl_id=$(cut -d/ -f4 <<<"$acl_arn")
acl=$(aws wafv2 get-web-acl --scope CLOUDFRONT --name "$acl_name" --id "$acl_id" --region "$region" --query WebACL --output json)
check "Web ACL default action" "$(jq -c '.DefaultAction | keys' <<<"$acl")" '["Allow"]'
# 不變條件：Free 方案最多 5 條；規則一律生效（沒有 Count 模式）/ Invariants: ≤ 5 rules (Free plan); all enforcing.
check "Web ACL rules ≤ 5 (Free plan)" "$(jq '.Rules | length <= 5' <<<"$acl")" "true"
check "Web ACL rule names" "$(jq -c '[.Rules[].Name] | sort' <<<"$acl")" \
  '["AWSManagedRulesAmazonIpReputationList","AWSManagedRulesCommonRuleSet","RateLimitPerIp"]'
check "Rules in Count mode" "$(jq '[.Rules[] | select(.Action.Count != null or .OverrideAction.Count != null)] | length' <<<"$acl")" "0"
rate=$(jq -c '.Rules[] | select(.Name == "RateLimitPerIp")' <<<"$acl")
check "Rate rule action" "$(jq -c '.Action | keys' <<<"$rate")" '["Block"]'
check "Rate rule key" "$(jq -r .Statement.RateBasedStatement.AggregateKeyType <<<"$rate")" "IP"
check "Rate rule window (s)" "$(jq -r .Statement.RateBasedStatement.EvaluationWindowSec <<<"$rate")" "300"
check "Rate rule limit within 100-2000" "$(jq '.Statement.RateBasedStatement.Limit | . >= 100 and . <= 2000' <<<"$rate")" "true"
check "Metrics on every rule" "$(jq '[.Rules[] | select(.VisibilityConfig.CloudWatchMetricsEnabled != true)] | length' <<<"$acl")" "0"

# --- SSM（us-east-1）與 stack / SSM and stack ---
check "SSM trace-certificate-arn" "$(aws ssm get-parameter --name "/brewline/${env_name}/edge/trace-certificate-arn" --region "$region" \
  --query Parameter.Value --output text)" "$cert_arn"
check "SSM trace-web-acl-arn" "$(aws ssm get-parameter --name "/brewline/${env_name}/edge/trace-web-acl-arn" --region "$region" \
  --query Parameter.Value --output text)" "$acl_arn"
check "Stack termination protection" "$(aws cloudformation describe-stacks --stack-name "$stack" --region "$region" \
  --query 'Stacks[0].EnableTerminationProtection' --output text | tr '[:upper:]' '[:lower:]')" "$want_termination_protection"

echo
echo "config.ts trace.edge for ${env_name} must match (S2c):"
echo "  certificateArn: '${cert_arn}'"
echo "  webAclArn: '${acl_arn}'"
exit $fail
