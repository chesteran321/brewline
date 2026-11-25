#!/usr/bin/env bash
# 部署後驗證公開溯源頁（S2c，ADR-031 D2–D4）：CloudFront（憑證、web ACL、OAC、Free 方案）、私有 S3、DNS，
# 以及從網際網路實際存取（正向：頁面 200、安全標頭；反向：亂數 token 404、HTTP 轉 HTTPS、直連 S3 被拒、TLS 1.1 被拒）。
# Post-deploy verification of the public trace page, including real HTTP checks from the internet.
#
# 以 lookup role（ReadOnlyAccess）執行：只讀，不寫任何東西 / Runs as the read-only lookup role.
# 用法 Usage: scripts/verify-trace-stack.sh <dev|prod> <outputs.json>
set -euo pipefail

env_name="${1:?usage: verify-trace-stack.sh <dev|prod> <outputs.json>}"
outputs="${2:?usage: verify-trace-stack.sh <dev|prod> <outputs.json>}"
region=ap-east-2
stack="brewline-${env_name}-trace"
edge="brewline-${env_name}-edge"
case "$env_name" in
  dev)  want_domain=trace.dev.brewline-demo.click; want_termination_protection=false ;;
  prod) want_domain=trace.brewline-demo.click;     want_termination_protection=true ;;
  *) echo "unknown env: $env_name" >&2; exit 2 ;;
esac

fail=0
check() { if [[ "$2" == "$3" ]]; then echo "✅ $1 = $2"; else echo "❌ $1 = $2 (expected $3)"; fail=1; fi; }
out() { jq -r --arg s "$1" --arg k "$2" '.[$s][$k] // empty' "$outputs"; }

aws sts get-caller-identity --query Arn --output text
dist_id=$(out "$stack" DistributionId)
bucket=$(out "$stack" BucketName)
cert_arn=$(out "$edge" TraceCertificateArn)
acl_arn=$(out "$edge" TraceWebAclArn)

# --- CloudFront ---
dist=$(aws cloudfront get-distribution --id "$dist_id" --query Distribution --output json)
cfg=$(jq '.DistributionConfig' <<<"$dist")
check "Distribution status" "$(jq -r .Status <<<"$dist")" "Deployed"
check "Distribution enabled" "$(jq -r .Enabled <<<"$cfg")" "true"
check "Aliases" "$(jq -c '.Aliases.Items' <<<"$cfg")" "[\"$want_domain\"]"
check "Certificate = edge stack output" "$(jq -r .ViewerCertificate.ACMCertificateArn <<<"$cfg")" "$cert_arn"
check "Minimum TLS" "$(jq -r .ViewerCertificate.MinimumProtocolVersion <<<"$cfg")" "TLSv1.2_2021"
check "Web ACL = edge stack output" "$(jq -r .WebACLId <<<"$cfg")" "$acl_arn"
check "Viewer protocol" "$(jq -r .DefaultCacheBehavior.ViewerProtocolPolicy <<<"$cfg")" "redirect-to-https"
check "Origin uses OAC" "$(jq -r '.Origins.Items[0].OriginAccessControlId | length > 0' <<<"$cfg")" "true"
check "No legacy OAI" "$(jq -r '.Origins.Items[0].S3OriginConfig.OriginAccessIdentity // ""' <<<"$cfg")" ""
check "Managed cache policy (CachingOptimized)" "$(jq -r .DefaultCacheBehavior.CachePolicyId <<<"$cfg")" "658327ea-f89d-4fab-a63d-7e88639e58f6"
check "Access logging off (Free plan)" "$(jq -r .Logging.Enabled <<<"$cfg")" "false"

# --- Free 方案 / Free plan ---
check "Free plan tier (subscription)" "$(out "$stack" FreePlanTier)" "FREE"

# --- ACM：掛上 CloudFront 後必須可自動續約 / Once in use the certificate must be renewable ---
cert=$(aws acm describe-certificate --certificate-arn "$cert_arn" --region us-east-1 --query Certificate --output json)
check "Certificate in use by this distribution" "$(jq -r --arg d "$dist_id" '[.InUseBy[] | select(endswith("distribution/" + $d))] | length' <<<"$cert")" "1"

# --- S3：私有 / Private bucket ---
check "Bucket public access block" "$(aws s3api get-public-access-block --bucket "$bucket" --query \
  'PublicAccessBlockConfiguration.[BlockPublicAcls,IgnorePublicAcls,BlockPublicPolicy,RestrictPublicBuckets]' --output text | tr '\t' ' ')" "True True True True"
policy=$(aws s3api get-bucket-policy --bucket "$bucket" --query Policy --output text)
check "Bucket policy Allow statements" "$(jq '[.Statement[] | select(.Effect == "Allow")] | length' <<<"$policy")" "1"
check "Only CloudFront may read" "$(jq -r '[.Statement[] | select(.Effect == "Allow")][0].Principal.Service' <<<"$policy")" "cloudfront.amazonaws.com"
check "Read scoped to this distribution" "$(jq -r '[.Statement[] | select(.Effect == "Allow")][0].Condition.StringEquals["AWS:SourceArn"] | endswith("distribution/'"$dist_id"'")' <<<"$policy")" "true"
check "No ListBucket (unknown keys stay 403 → 404)" "$(jq '[.Statement[] | select(.Effect == "Allow") | .Action] | flatten | map(select(. == "s3:ListBucket" or . == "s3:*")) | length' <<<"$policy")" "0"

# --- HTTP（從網際網路）/ HTTP from the internet ---
base="https://${want_domain}"
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$@"; }
for i in $(seq 1 12); do [[ "$(code "$base/")" == "200" ]] && break; sleep 10; done   # DNS／邊緣節點剛建立 / fresh DNS and edges
headers=$(curl -s -D - -o /dev/null --max-time 15 "$base/")
hdr() { grep -i "^$1:" <<<"$headers" | head -1 | cut -d' ' -f2- | tr -d '\r'; }
check "GET / (index.html)" "$(code "$base/")" "200"
check "Content-Type" "$(hdr content-type)" "text/html; charset=utf-8"
check "HSTS header present" "$(hdr strict-transport-security | grep -c max-age || true)" "1"
check "X-Content-Type-Options" "$(hdr x-content-type-options)" "nosniff"
check "X-Frame-Options" "$(hdr x-frame-options)" "SAMEORIGIN"
check "Cache-Control" "$(hdr cache-control)" "public, max-age=300"
check "GET /app.js" "$(code "$base/app.js")" "200"
check "GET /robots.txt" "$(code "$base/robots.txt")" "200"
# 反向 / Negative
random_token() { head -c 16 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=' ; }
bodies=""
for i in 1 2 3; do
  t=$(random_token)
  check "Random token #$i → 404" "$(code "$base/v1/$t.json")" "404"
  bodies+="$(curl -s --max-time 15 "$base/v1/$t.json" | sha256sum | cut -c1-16) "
done
check "Unknown tokens return identical bodies" "$(tr ' ' '\n' <<<"$bodies" | grep . | sort -u | wc -l | tr -d ' ')" "1"
check "Unknown path → 404" "$(code "$base/admin")" "404"
# CloudFront 對不允許的方法回 403，再經自訂錯誤回應統一成 404 → 與不存在的 token 無法分辨（正是要的）
# CloudFront answers disallowed methods with 403, which the custom error response turns into the same 404.
check "POST rejected (403 → uniform 404)" "$(code -X POST "$base/")" "404"
check "POST body is the uniform 404 page" "$(curl -s -X POST --max-time 15 "$base/" | sha256sum | cut -c1-16)" "$(tr ' ' '\n' <<<"$bodies" | grep . | head -1)"
check "HTTP → HTTPS redirect" "$(code "http://${want_domain}/")" "301"
check "Direct S3 access denied" "$(code "https://${bucket}.s3.${region}.amazonaws.com/index.html")" "403"
tls11=$(curl -s -o /dev/null --max-time 15 --tlsv1.1 --tls-max 1.1 "$base/" && echo accepted || echo rejected)
check "TLS 1.1 handshake" "$tls11" "rejected"

# --- 投影（Dev smoke test 會產生）：允許的欄位剛好是白名單 / Projection fields are exactly the allow-list ---
# 不印出 token（token 就是公開頁的網址）/ Never print the token.
# 不用 `--max-items N --output text`：物件超過 N 個時 CLI 會多印一行分頁 token，鍵名被污染 → curl exit 3（URL 格式錯誤）。
# Prod 在 2026-11-25 超過 50 個投影時發生（#81 同類教訓）。改成 JSON：CLI 自動分頁合併後，jq 取最新的鍵（沒有物件 → 空字串）。
# Never `--max-items N --output text`: past N objects the pagination token is printed as an extra line and pollutes the key.
key=$(aws s3api list-objects-v2 --bucket "$bucket" --prefix v1/ --output json 2>/dev/null \
  | jq -r '(.Contents // []) | sort_by(.LastModified) | last | .Key // empty' || true)
if [[ -n "$key" && ( "$key" == *$'\n'* || "$key" != v1/*.json ) ]]; then
  # 鍵名不是單一個 v1/*.json → 腳本錯誤，要失敗而不是略過 / A malformed key is a script error: fail, do not skip.
  check "Latest projection key is a single v1/*.json" "malformed" "ok"
elif [[ -n "$key" ]]; then
  body=$(curl -s --max-time 15 "$base/$key")
  check "Projection via CloudFront" "$(code "$base/$key")" "200"
  check "Projection top-level keys (recall optional)" "$(jq -c 'keys - ["recall"]' <<<"$body")" '["demo","generated_at","lot","product","roast","schema"]'
  check "Projection product keys" "$(jq -c '.product | keys - ["name_zh"]' <<<"$body")" '["name"]'
  check "Projection roast keys" "$(jq -c '.roast | keys' <<<"$body")" '["roast_date","roast_level"]'
  check "Projection lot keys" "$(jq -c '.lot | keys' <<<"$body")" '["altitude_m","cup_score","harvest","origin_country","process","producer_display_name","region","variety"]'
  check "Projection has no tenant/order/e-mail" "$(grep -ciE 'tenant|order|@|t_[0-9A-Z]{26}|o_[0-9A-Z]{26}' <<<"$body" || true)" "0"
else
  echo "⏭  No projection yet (S2d's simulated roastery or the Dev smoke test will create one)"
fi

check "Stack termination protection" "$(aws cloudformation describe-stacks --stack-name "$stack" --region "$region" \
  --query 'Stacks[0].EnableTerminationProtection' --output text | tr '[:upper:]' '[:lower:]')" "$want_termination_protection"
exit $fail
