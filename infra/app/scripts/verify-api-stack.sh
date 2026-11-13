#!/usr/bin/env bash
# 部署後驗證訂貨 API（A1）：查詢 AWS 實際狀態，並以 HTTP 做不需要登入的反向測試。
# Post-deploy verification of the ordering API (A1): real AWS state plus unauthenticated HTTP negative tests.
#
# 用法 Usage: scripts/verify-api-stack.sh <dev|prod> <outputs.json>
# 需要唯讀權限（CI 以 CDK lookup role 執行，它有 ReadOnlyAccess）。
# 需要登入的測試（cafe／staff／scope）由 Dev 的 smoke test custom resource 在部署時執行。
# Authenticated tests run during the Dev deploy as the smoke-test custom resource.
set -euo pipefail

env_name="${1:?usage: verify-api-stack.sh <dev|prod> <outputs.json>}"
outputs="${2:?usage: verify-api-stack.sh <dev|prod> <outputs.json>}"
region="${AWS_REGION:-ap-east-2}"
stack="brewline-${env_name}-api"

case "$env_name" in
  dev)  want_rate=10; want_burst=20;  want_concurrency=5;  want_retention=7;  want_smoke=true;  want_termination_protection=false ;;
  prod) want_rate=50; want_burst=100; want_concurrency=10; want_retention=30; want_smoke=false; want_termination_protection=true ;;
  *) echo "unknown env: $env_name" >&2; exit 2 ;;
esac

out() { jq -r --arg s "$stack" --arg k "$1" '.[$s][$k] // empty' "$outputs"; }
api_url=$(out ApiUrl)
api_id=$(out ApiId)
fail=0

check() { # check <label> <actual> <expected>
  if [[ "$2" == "$3" ]]; then
    echo "✅ $1 = $2"
  else
    echo "❌ $1 = $2 (expected $3)"
    fail=1
  fi
}

http_status() { # http_status <method> <path> [authorization header value]
  local args=(-s -o /dev/null -w '%{http_code}' --max-time 10 -X "$1")
  [[ -n "${3:-}" ]] && args+=(-H "Authorization: $3")
  curl "${args[@]}" "${api_url%/}$2"
}

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

aws sts get-caller-identity --query Arn --output text

# --- 路由與授權 / Routes and authorization ---
routes=$(aws apigatewayv2 get-routes --api-id "$api_id" --region "$region" --output json)
check "Routes" "$(jq -c '[.Items[].RouteKey] | sort' <<<"$routes")" \
  '["GET /admin/products/{id}/stock","GET /products","GET /products/{id}"]'
check "Routes without JWT" "$(jq -r '[.Items[] | select(.AuthorizationType != "JWT")] | length' <<<"$routes")" "0"
check "Routes without a scope" "$(jq -r '[.Items[] | select((.AuthorizationScopes // []) | length == 0)] | length' <<<"$routes")" "0"
check "Admin route scope" "$(jq -c '.Items[] | select(.RouteKey == "GET /admin/products/{id}/stock") | .AuthorizationScopes' <<<"$routes")" '["brewline/admin"]'

authz=$(aws apigatewayv2 get-authorizers --api-id "$api_id" --region "$region" --output json)
issuer=$(aws ssm get-parameter --name "/brewline/${env_name}/auth/issuer" --region "$region" --query Parameter.Value --output text)
web_client=$(aws ssm get-parameter --name "/brewline/${env_name}/auth/web-client-id" --region "$region" --query Parameter.Value --output text)
check "Authorizer issuer = user pool" "$(jq -r '.Items[0].JwtConfiguration.Issuer' <<<"$authz")" "$issuer"
check "Authorizer audience has web client" "$(jq -r --arg c "$web_client" '.Items[0].JwtConfiguration.Audience | index($c) != null' <<<"$authz")" "true"

stage=$(aws apigatewayv2 get-stage --api-id "$api_id" --stage-name '$default' --region "$region" --output json)
# ThrottlingRateLimit 是浮點數（API 回 10.0），先轉整數再比對 / The API returns the rate as a float (10.0).
check "Stage throttle rate"  "$(jq -r '.DefaultRouteSettings.ThrottlingRateLimit | floor' <<<"$stage")" "$want_rate"
check "Stage throttle burst" "$(jq -r '.DefaultRouteSettings.ThrottlingBurstLimit | floor' <<<"$stage")" "$want_burst"
check "Stage access logs"    "$(jq -r '.AccessLogSettings.DestinationArn // "none" | test("^arn:aws:logs:")' <<<"$stage")" "true"
check "No CORS configured"   "$(aws apigatewayv2 get-api --api-id "$api_id" --region "$region" --query 'CorsConfiguration' --output text)" "None"

# --- Lambda ---
IFS=',' read -r -a fns <<<"$(out FunctionNames)"
check "API function count" "${#fns[@]}" "3"
for fn in "${fns[@]}"; do
  cfg=$(aws lambda get-function-configuration --function-name "$fn" --region "$region" --output json)
  short=${fn#brewline-${env_name}-ordering-}
  check "$short runtime"      "$(jq -r '.Runtime' <<<"$cfg")" "nodejs24.x"
  check "$short architecture" "$(jq -c '.Architectures' <<<"$cfg")" '["arm64"]'
  check "$short tracing"      "$(jq -r '.TracingConfig.Mode' <<<"$cfg")" "Active"
  check "$short reserved concurrency" "$(aws lambda get-function-concurrency --function-name "$fn" --region "$region" \
    --query ReservedConcurrentExecutions --output text)" "$want_concurrency"
  check "$short log retention" "$(aws logs describe-log-groups --log-group-name-prefix "/aws/lambda/${fn}" --region "$region" \
    --query 'logGroups[0].retentionInDays' --output text)" "$want_retention"
done

# --- 種子與 smoke test / Seed and smoke test ---
seeded=$(out SeededProducts)
check "Seeded products ≥ 8" "$([[ "${seeded:-0}" -ge 8 ]] && echo true || echo false)" "true"
smoke=$(out SmokeTestSummary)
if [[ "$want_smoke" == true ]]; then
  smoke_result="${smoke:-missing}"
  if [[ "$smoke" =~ ^([0-9]+)/([0-9]+)\ passed ]] && [[ "${BASH_REMATCH[1]}" == "${BASH_REMATCH[2]}" ]]; then
    smoke_result=passed
  fi
  check "Smoke test (deploy-time)" "$smoke_result" "passed"
  echo "   ↳ $smoke"
else
  check "No smoke test in $env_name" "${smoke:-none}" "none"
fi

check "Stack termination protection" "$(aws cloudformation describe-stacks --stack-name "$stack" --region "$region" \
  --query 'Stacks[0].EnableTerminationProtection' --output text | tr '[:upper:]' '[:lower:]')" "$want_termination_protection"

# --- 反向：HTTP，不帶有效 token / Negative: HTTP without a valid token ---
now=$(date +%s)
forged_header=$(printf '{"alg":"RS256","kid":"not-a-real-key","typ":"JWT"}' | b64url)
forged_payload=$(printf '{"iss":"%s","client_id":"%s","token_use":"access","scope":"brewline/admin brewline/catalog.read","exp":%d,"iat":%d,"sub":"forged"}' \
  "$issuer" "$web_client" $((now + 3600)) "$now" | b64url)
forged="${forged_header}.${forged_payload}.$(printf 'forged-signature' | b64url)"

check "GET /products without token"           "$(http_status GET /products)" "401"
check "GET /admin/... without token"          "$(http_status GET /admin/products/p-0001/stock)" "401"
check "GET /products with garbage token"      "$(http_status GET /products 'Bearer not-a-jwt')" "401"
check "GET /admin/... with forged admin JWT"  "$(http_status GET /admin/products/p-0001/stock "Bearer ${forged}")" "401"
check "Unknown route"                         "$(http_status GET /no-such-route)" "404"
check "POST /products (no such method)"       "$(http_status POST /products)" "404"

# --- 反向：唯讀角色讀不到資料內容（表層 CMK）/ Negative: read-only role cannot read item contents (CMK) ---
table=$(aws ssm get-parameter --name "/brewline/${env_name}/data/table-name" --region "$region" --query Parameter.Value --output text)
if err=$(aws dynamodb get-item --table-name "$table" --region "$region" \
      --key '{"pk":{"S":"PRODUCT#p-0001"},"sk":{"S":"META"}}' --output json 2>&1); then
  check "Read-only role reads item contents" "allowed" "denied"
else
  check "Read-only role reads item contents" "$(grep -qi 'AccessDenied\|kms' <<<"$err" && echo denied || echo "error: ${err:0:80}")" "denied"
fi

exit "$fail"
