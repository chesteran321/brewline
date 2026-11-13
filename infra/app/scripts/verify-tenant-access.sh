#!/usr/bin/env bash
# 驗證租戶存取角色（ADR-024）：設定檢查＋IAM 政策模擬（正向與反向）。
# Verify the tenant access role: configuration checks plus IAM policy simulation (positive and negative).
#
# 用法 Usage: scripts/verify-tenant-access.sh <dev|prod> <outputs.json>
# simulate-principal-policy 只計算角色的身分政策（不含 SCP／RCP／key policy、不執行任何動作）。
# 若目前身分沒有 iam:SimulatePrincipalPolicy 權限，模擬部分會略過（⚠️），不視為失敗。
# simulate-principal-policy evaluates identity policies only and performs no action.
set -euo pipefail

env_name="${1:?usage: verify-tenant-access.sh <dev|prod> <outputs.json>}"
outputs="${2:?usage: verify-tenant-access.sh <dev|prod> <outputs.json>}"
region="${AWS_REGION:-ap-east-2}"
stack="brewline-${env_name}-api"
fail=0

check() { # check <label> <actual> <expected>
  if [[ "$2" == "$3" ]]; then echo "✅ $1 = $2"; else echo "❌ $1 = $2 (expected $3)"; fail=1; fi
}

role_arn=$(jq -r --arg s "$stack" '.[$s].TenantAccessRoleArn // empty' "$outputs")
role_name="brewline-${env_name}-tenant-access"
table_arn=$(aws ssm get-parameter --name "/brewline/${env_name}/data/table-arn" --region "$region" --query Parameter.Value --output text)
account=$(cut -d: -f5 <<<"$table_arn")

aws sts get-caller-identity --query Arn --output text

# --- 設定 / Configuration ---
role=$(aws iam get-role --role-name "$role_name" --output json)
check "Role ARN = stack output" "$(jq -r .Role.Arn <<<"$role")" "$role_arn"
check "Max session (s)" "$(jq -r .Role.MaxSessionDuration <<<"$role")" "3600"
trust=$(jq -c '.Role.AssumeRolePolicyDocument' <<<"$role")
check "Trust actions" "$(jq -c '[.Statement[].Action] | sort' <<<"$trust")" '["sts:AssumeRole","sts:TagSession"]'
check "Trust caller pattern" "$(jq -r '[.Statement[].Condition.ArnLike["aws:PrincipalArn"]] | unique | .[]' <<<"$trust")" \
  "arn:aws:iam::${account}:role/brewline-${env_name}-orders-*"
check "Trust tag length pattern" "$(jq -r '[.Statement[].Condition.StringLike["aws:RequestTag/tenant_id"]] | unique | .[]' <<<"$trust")" \
  "t_??????????????????????????"
check "Trust allowed tag keys" "$(jq -c '[.Statement[].Condition["ForAllValues:StringEquals"]["aws:TagKeys"]] | unique | .[]' <<<"$trust")" '["tenant_id"]'

# --- 政策模擬 / Policy simulation ---
A=t_01AAAAAAAAAAAAAAAAAAAAAAAA      # 租戶 A / tenant A
B=t_01BBBBBBBBBBBBBBBBBBBBBBBB      # 租戶 B / tenant B
SHORT=t_1                            # 前綴攻擊：t_1 不可碰 TENANT#t_1… / prefix attack

# sim <label> <expected> <action> <principal tag or ""> <leading key> [attributes,comma,separated] [returnValues]
sim() {
  local label=$1 want=$2 action=$3 tag=$4 key=$5 attrs=${6:-} rv=${7:-}
  local ctx=()
  [[ -n "$tag" ]] && ctx+=("ContextKeyName=aws:PrincipalTag/tenant_id,ContextKeyValues=${tag},ContextKeyType=string")
  [[ -n "$key" ]] && ctx+=("ContextKeyName=dynamodb:LeadingKeys,ContextKeyValues=${key},ContextKeyType=stringList")
  [[ -n "$attrs" ]] && ctx+=("ContextKeyName=dynamodb:Attributes,ContextKeyValues=${attrs},ContextKeyType=stringList")
  [[ -n "$rv" ]] && ctx+=("ContextKeyName=dynamodb:ReturnValues,ContextKeyValues=${rv},ContextKeyType=string")
  local out
  if ! out=$(aws iam simulate-principal-policy --policy-source-arn "$role_arn" --action-names "$action" \
        --resource-arns "$table_arn" ${ctx[@]+--context-entries "${ctx[@]}"} \
        --query 'EvaluationResults[0].EvalDecision' --output text 2>&1); then
    if grep -q 'AccessDenied' <<<"$out"; then
      echo "⚠️  $label: this identity cannot call iam:SimulatePrincipalPolicy (skipped)"; return
    fi
    echo "❌ $label: $out"; fail=1; return
  fi
  check "$label" "$out" "$want"
}

stock_attrs="pk,sk,available_kg,reserved_kg,version,updated_at"
sim "A reads own order"                  allowed      dynamodb:GetItem       "$A" "TENANT#$A"
sim "A writes own order (Put)"           allowed      dynamodb:PutItem       "$A" "TENANT#$A"
sim "A reads B's order"                  implicitDeny dynamodb:GetItem       "$A" "TENANT#$B"
sim "A writes into B (Put)"              implicitDeny dynamodb:PutItem       "$A" "TENANT#$B"
sim "Prefix attack t_1 → TENANT#t_1…"    implicitDeny dynamodb:Query         "$SHORT" "TENANT#${SHORT}2AAAAAAAAAAAAAAAAAAAAAAAA"
sim "No session tag → own-looking key"   implicitDeny dynamodb:GetItem       ""   "TENANT#$A"
sim "Read product"                       allowed      dynamodb:GetItem       "$A" "PRODUCT#p-0001"
sim "Reserve stock (stock attributes)"   allowed      dynamodb:UpdateItem    "$A" "PRODUCT#p-0001" "$stock_attrs" "NONE"
sim "Change price"                       implicitDeny dynamodb:UpdateItem    "$A" "PRODUCT#p-0001" "pk,sk,price_per_kg" "NONE"
sim "Reserve stock but read ALL_NEW"     implicitDeny dynamodb:UpdateItem    "$A" "PRODUCT#p-0001" "$stock_attrs" "ALL_NEW"
sim "Create product (Put)"               implicitDeny dynamodb:PutItem       "$A" "PRODUCT#p-9999"
sim "Delete own order"                   implicitDeny dynamodb:DeleteItem    "$A" "TENANT#$A"
sim "Scan"                               explicitDeny dynamodb:Scan          "$A" ""

exit "$fail"
