#!/usr/bin/env bash
# 部署後驗證資料湖基礎（P2a，ADR-032）：兩個 bucket（SSE-KMS＋Bucket Key、私有、TLS、生命週期、bucket policy）、
# Glue 資料庫、Dev smoke 表的 projection、Athena workgroup（強制設定、掃描上限、結果加密）、lake-dlq＋告警、SSM。
# 反向：沒有公開 Allow、Prod 沒有 smoke 表、stack 沒有 Lambda、唯讀角色讀不到物件內容（KMS）、不能啟動查詢。
# Post-deploy verification of the data lake foundation, with negative checks.
#
# 以 lookup role（ReadOnlyAccess）執行：只讀，不寫任何東西 / Runs as the read-only lookup role.
# 用法 Usage: scripts/verify-lake-stack.sh <dev|prod> <outputs.json>
set -euo pipefail

env_name="${1:?usage: verify-lake-stack.sh <dev|prod> <outputs.json>}"
outputs="${2:?usage: verify-lake-stack.sh <dev|prod> <outputs.json>}"
region=ap-east-2
stack="brewline-${env_name}-lake"
# 預期值與 lib/config.ts 的 lake 設定一致 / Must match `lake` in lib/config.ts.
case "$env_name" in
  dev)  want_raw_days=30;  want_glacier="none"; want_cutoff=104857600;  want_smoke=true;  want_termination_protection=false ;;
  prod) want_raw_days=730; want_glacier="GLACIER_IR 90"; want_cutoff=1073741824; want_smoke=false; want_termination_protection=true ;;
  *) echo "unknown env: $env_name" >&2; exit 2 ;;
esac

fail=0
check() { if [[ "$2" == "$3" ]]; then echo "✅ $1 = $2"; else echo "❌ $1 = $2 (expected $3)"; fail=1; fi; }
skip() { echo "⏭  $1"; }
out() { jq -r --arg s "$stack" --arg k "$1" '.[$s][$k] // empty' "$outputs"; }

aws sts get-caller-identity --query Arn --output text
account=$(aws sts get-caller-identity --query Account --output text)
key_arn=$(aws ssm get-parameter --name "/brewline/${env_name}/data/kms-key-arn" --region "$region" --query Parameter.Value --output text)
lake=$(out BucketName)
results=$(out ResultsBucketName)
wg=$(out WorkgroupName)
check "Lake bucket name" "$lake" "brewline-${env_name}-lake-${account}"
check "Results bucket name" "$results" "brewline-${env_name}-athena-results-${account}"

# --- 1–8, 12：兩個 bucket 的共同設定 / Settings shared by both buckets ---
for b in "$lake" "$results"; do
  label=$([[ "$b" == "$lake" ]] && echo lake || echo results)
  check "[$label] encryption (algorithm key bucketKey)" "$(aws s3api get-bucket-encryption --bucket "$b" --region "$region" --query \
    'ServerSideEncryptionConfiguration.Rules[0].[ApplyServerSideEncryptionByDefault.SSEAlgorithm,ApplyServerSideEncryptionByDefault.KMSMasterKeyID,BucketKeyEnabled]' \
    --output text | tr '\t' ' ')" "aws:kms ${key_arn} True"
  check "[$label] public access block" "$(aws s3api get-public-access-block --bucket "$b" --region "$region" --query \
    'PublicAccessBlockConfiguration.[BlockPublicAcls,IgnorePublicAcls,BlockPublicPolicy,RestrictPublicBuckets]' --output text | tr '\t' ' ')" "True True True True"
  check "[$label] object ownership" "$(aws s3api get-bucket-ownership-controls --bucket "$b" --region "$region" \
    --query 'OwnershipControls.Rules[0].ObjectOwnership' --output text)" "BucketOwnerEnforced"
  check "[$label] tag data-class" "$(aws s3api get-bucket-tagging --bucket "$b" --region "$region" --output json \
    | jq -r '.TagSet[] | select(.Key == "data-class") | .Value')" "internal"
  policy=$(aws s3api get-bucket-policy --bucket "$b" --region "$region" --query Policy --output text)
  check "[$label] policy denies non-TLS" "$(jq '[.Statement[] | select(.Effect == "Deny" and .Condition.Bool["aws:SecureTransport"] == "false")] | length' <<<"$policy")" "1"
  # 反向：沒有任何 Allow 給 "*"（bucket 只靠 IAM 授權）/ Negative: no Allow for Principal "*".
  check "[$label] public Allow statements" "$(jq '[.Statement[] | select(.Effect == "Allow" and (.Principal == "*" or .Principal.AWS == "*"))] | length' <<<"$policy")" "0"
done

check "[lake] versioning" "$(aws s3api get-bucket-versioning --bucket "$lake" --region "$region" --query Status --output text)" "Enabled"
# 從未開啟時 API 沒有 Status（印出 None）/ Never enabled → no Status.
check "[results] versioning not Enabled" "$(aws s3api get-bucket-versioning --bucket "$results" --region "$region" --query Status --output text | grep -qx Enabled && echo false || echo true)" "true"

# --- 9–10：生命週期 / Lifecycle ---
lc=$(aws s3api get-bucket-lifecycle-configuration --bucket "$lake" --region "$region" --output json)
rule() { jq -c --arg id "$1" '.Rules[] | select(.ID == $id)' <<<"$lc"; }
prefix_of() { jq -r '.Filter.Prefix // .Prefix // ""' <<<"$1"; }
raw=$(rule raw)
check "[lake] raw/ prefix + expiration" "$(prefix_of "$raw") $(jq -r .Expiration.Days <<<"$raw")" "raw/ ${want_raw_days}"
check "[lake] raw/ transition" "$(jq -r 'if (.Transitions // []) | length == 0 then "none" else "\(.Transitions[0].StorageClass) \(.Transitions[0].Days)" end' <<<"$raw")" "$want_glacier"
for spec in "curated curated/ 730" "analytics analytics/ 730" "quarantine quarantine/ 90"; do
  read -r id pfx days <<<"$spec"
  r=$(rule "$id")
  check "[lake] ${pfx} prefix + expiration" "$(prefix_of "$r") $(jq -r .Expiration.Days <<<"$r")" "${pfx} ${days}"
done
all=$(rule noncurrent-and-multipart)
check "[lake] all prefixes: noncurrent days, multipart abort days" \
  "$(prefix_of "$all")|$(jq -r '"\(.NoncurrentVersionExpiration.NoncurrentDays) \(.AbortIncompleteMultipartUpload.DaysAfterInitiation)"' <<<"$all")" "|30 7"
lcr=$(aws s3api get-bucket-lifecycle-configuration --bucket "$results" --region "$region" --output json)
check "[results] lifecycle (prefix|expiration multipart)" \
  "$(jq -r '.Rules | length' <<<"$lcr") $(jq -r '.Rules[0] | "\(.Filter.Prefix // .Prefix // "")|\(.Expiration.Days) \(.AbortIncompleteMultipartUpload.DaysAfterInitiation)"' <<<"$lcr")" "1 |7 1"

# --- 11：lake bucket policy 的 KMS 保護 / KMS guards on the lake bucket ---
lp=$(aws s3api get-bucket-policy --bucket "$lake" --region "$region" --query Policy --output text)
check "[lake] DenyWrongKmsKey (only when the header is present; key = CMK)" "$(jq -c '.Statement[] | select(.Sid == "DenyWrongKmsKey") |
  [.Effect, .Action, .Condition.Null["s3:x-amz-server-side-encryption-aws-kms-key-id"], .Condition.StringNotEquals["s3:x-amz-server-side-encryption-aws-kms-key-id"]]' <<<"$lp")" \
  "$(jq -cn --arg k "$key_arn" '["Deny","s3:PutObject","false",$k]')"
check "[lake] DenyNonKmsSse (only when the header is present)" "$(jq -c '.Statement[] | select(.Sid == "DenyNonKmsSse") |
  [.Effect, .Action, .Condition.Null["s3:x-amz-server-side-encryption"], .Condition.StringNotEquals["s3:x-amz-server-side-encryption"]]' <<<"$lp")" \
  '["Deny","s3:PutObject","false","aws:kms"]'

# --- 13：Glue 資料庫 / Glue databases ---
for db in raw curated analytics; do
  check "Glue database brewline_${db}" "$(aws glue get-database --name "brewline_${db}" --region "$region" --query 'Database.[Name,LocationUri]' \
    --output text | tr '\t' ' ')" "brewline_${db} s3://${lake}/${db}/"
done

# --- 14：Dev smoke 表；Prod 不應存在 / Dev smoke table; must not exist in Prod ---
if [[ "$want_smoke" == true ]]; then
  tbl=$(aws glue get-table --database-name brewline_raw --name lake_smoke --region "$region" --query Table --output json)
  check "Smoke table type, location" "$(jq -r '"\(.TableType) \(.StorageDescriptor.Location)"' <<<"$tbl")" "EXTERNAL_TABLE s3://${lake}/raw/_smoke/"
  check "Smoke table projection" "$(jq -r '.Parameters | "\(."projection.enabled") \(."projection.dt.type") \(."projection.dt.range")"' <<<"$tbl")" "true date 2026-11-01,NOW"
  check "Smoke table location template" "$(jq -r '.Parameters."storage.location.template"' <<<"$tbl")" "s3://${lake}/raw/_smoke/dt=\${dt}/"
  check "Smoke table synthetic" "$(jq -r '.Parameters.synthetic' <<<"$tbl")" "true"
else
  # pipefail 下 `aws … | grep` 會回傳 aws 的失敗碼 → 先取錯誤訊息再判斷 / Capture first: with pipefail the pipe returns aws's status.
  err=$(aws glue get-table --database-name brewline_raw --name lake_smoke --region "$region" 2>&1 >/dev/null || true)
  check "Smoke table absent (negative)" "$(grep -q EntityNotFoundException <<<"$err" && echo absent || echo "present: ${err:0:80}")" "absent"
fi

# --- 15：Athena workgroup ---
w=$(aws athena get-work-group --work-group "$wg" --region "$region" --query WorkGroup --output json)
check "Workgroup name" "$wg" "brewline-${env_name}-analytics"
check "Workgroup state, enforced" "$(jq -r '"\(.State) \(.Configuration.EnforceWorkGroupConfiguration)"' <<<"$w")" "ENABLED true"
check "Workgroup scan cutoff (bytes)" "$(jq -r .Configuration.BytesScannedCutoffPerQuery <<<"$w")" "$want_cutoff"
check "Workgroup output location" "$(jq -r .Configuration.ResultConfiguration.OutputLocation <<<"$w")" "s3://${results}/athena/"
check "Workgroup result encryption" "$(jq -r '.Configuration.ResultConfiguration.EncryptionConfiguration | "\(.EncryptionOption) \(.KmsKey)"' <<<"$w")" "SSE_KMS ${key_arn}"
check "Workgroup expected bucket owner" "$(jq -r .Configuration.ResultConfiguration.ExpectedBucketOwner <<<"$w")" "$account"
check "Workgroup engine" "$(jq -r .Configuration.EngineVersion.SelectedEngineVersion <<<"$w")" "Athena engine version 3"

# --- 16：DLQ＋告警 / DLQ and its alarm ---
q=$(aws sqs get-queue-attributes --queue-url "$(out DlqUrl)" --region "$region" \
  --attribute-names SqsManagedSseEnabled MessageRetentionPeriod ApproximateNumberOfMessages --output json)
check "DLQ SSE-SQS, retention, messages" "$(jq -r '.Attributes | "\(.SqsManagedSseEnabled) \(.MessageRetentionPeriod) \(.ApproximateNumberOfMessages)"' <<<"$q")" "true 1209600 0"
topic=$(aws ssm get-parameter --name "/brewline/${env_name}/ops/alerts-topic-arn" --region "$region" --query Parameter.Value --output text)
al=$(aws cloudwatch describe-alarms --alarm-names "brewline-${env_name}-lake-dlq-not-empty" --region "$region" --query 'MetricAlarms[0]' --output json)
check "DLQ alarm → ops topic (ALARM + OK)" "$(jq -r --arg t "$topic" '"\((.AlarmActions // []) | index($t) != null) \((.OKActions // []) | index($t) != null)"' <<<"$al")" "true true"
check "DLQ alarm state not ALARM" "$(jq -r '.StateValue != "ALARM"' <<<"$al")" "true"

# --- 17：SSM = outputs（9 個）/ SSM parameters equal the outputs ---
declare -A params=(
  [bucket-name]=BucketName [bucket-arn]=BucketArn [results-bucket-name]=ResultsBucketName [workgroup-name]=WorkgroupName
  [db-raw]=DbRaw [db-curated]=DbCurated [db-analytics]=DbAnalytics [dlq-arn]=DlqArn [dlq-url]=DlqUrl
)
matched=0
for name in "${!params[@]}"; do
  v=$(aws ssm get-parameter --name "/brewline/${env_name}/lake/${name}" --region "$region" --query Parameter.Value --output text 2>/dev/null || echo "<missing>")
  if [[ -n "$(out "${params[$name]}")" && "$v" == "$(out "${params[$name]}")" ]]; then matched=$((matched + 1)); else echo "   mismatch: ${name} = ${v}"; fi
done
check "SSM parameters equal outputs" "$matched" "${#params[@]}"

# --- 18：終止保護；反向：stack 沒有 Lambda / Termination protection; negative: no Lambda in the stack ---
check "Stack termination protection" "$(aws cloudformation describe-stacks --stack-name "$stack" --region "$region" \
  --query 'Stacks[0].EnableTerminationProtection' --output text | tr '[:upper:]' '[:lower:]')" "$want_termination_protection"
check "Lambda functions in stack (negative)" "$(aws cloudformation list-stack-resources --stack-name "$stack" --region "$region" \
  --query "length(StackResourceSummaries[?ResourceType=='AWS::Lambda::Function'])" --output text)" "0"

# --- 19：反向：唯讀角色讀不到物件內容（沒有 kms:Decrypt）/ Negative: the read-only role cannot read objects (no kms:Decrypt) ---
obj=$(aws s3api list-objects-v2 --bucket "$lake" --region "$region" --max-items 1 --query 'Contents[0].Key' --output text 2>/dev/null || echo None)
if [[ -z "$obj" || "$obj" == "None" ]]; then
  skip "Read-only GetObject denied: no object in the lake yet (Dev: after T1 in the spec §7)"
else
  err=$(aws s3api get-object --bucket "$lake" --key "$obj" --region "$region" /dev/null 2>&1 >/dev/null || true)
  check "Read-only GetObject (${obj}) denied" "$(grep -q 'AccessDenied' <<<"$err" && echo denied || echo "allowed: ${err:0:80}")" "denied"
fi

# --- 20：反向：唯讀角色不能啟動查詢 / Negative: the read-only role cannot start queries ---
err=$(aws athena start-query-execution --work-group "$wg" --query-string 'SELECT 1' --region "$region" 2>&1 >/dev/null || true)
check "Read-only StartQueryExecution denied" "$(grep -q 'AccessDenied' <<<"$err" && echo denied || echo "allowed: ${err:0:80}")" "denied"

exit "$fail"
