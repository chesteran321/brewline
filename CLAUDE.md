# CLAUDE.md — BrewLine 工作規則 / Working Rules

BrewLine 是在 AWS 上建置的 B2B 精品咖啡供應平台，用來展示 AWS Solutions Architect 能力的**非商業作品集**。
BrewLine is a non-commercial AWS Solutions Architect portfolio: a B2B specialty-coffee supply platform.

## 文件優先順序 / Document precedence

1. `docs/landing-zone-status.md` — 實際建置結果，最權威 / As-built, authoritative.
2. `docs/00`–`docs/14` — v0.1 設計初稿；與 status 衝突時以 status 為準 / v0.1 drafts; status wins on conflict.

## 固定事實 / Fixed facts

| 項目 Item | 值 Value |
|---|---|
| 主要區域 Primary region | `ap-east-2`（台北 Taipei）— 所有工作負載 / all workloads |
| 全域服務 Global | `us-east-1`（CloudFront ACM、帳單 billing） |
| DR 演練 Drill | `ap-northeast-1`（東京），平時被 `scp-region-restrict` 拒絕 / denied except during drills |
| Management | `324200381393` |
| Security | `978684888186` |
| Prod | `062868712468` |
| Dev | `610935435571` |
| 年度預算 Annual budget | ≤ USD 300 |
| IaC | AWS CDK（TypeScript），Node 24 LTS（本機、CI），Lambda `Runtime.NODEJS_24_X`（ADR-023） |
| CDK bootstrap | qualifier `hnb659fds`，Dev / Prod 的 ap-east-2 與 us-east-1 |

### 共用資料層 / Shared data layer（ADR-018）

| 項目 Item | 值 Value |
|---|---|
| Stack | `brewline-<env>-data`（Prod 終止保護） |
| KMS CMK | `alias/brewline-<env>-data`，年度輪替；每帳號 1 把，之後 S3／SQS／SNS 共用 |
| DynamoDB | `brewline-<env>-core`，CDK `TableV2`（= `AWS::DynamoDB::GlobalTable`），鍵 `pk`／`sk`，TTL `expires_at` |
| Streams | `NEW_AND_OLD_IMAGES`（A3a，事件來源）；**不要改 view type** |
| 取得名稱／ARN | SSM `/brewline/<env>/data/{table-name,table-arn,kms-key-arn,table-stream-arn}`（不要用 CloudFormation Export） |

- cdk-nag `AwsSolutions-DDB3` **不檢查** `CfnGlobalTable`；PITR／CMK／刪除保護由 `lib/aspects/data-protection.ts` 把關。
- 新增 GSI：一次 PR 只加一個（CloudFormation 每次更新只能新增一個 GSI）。
- 不要把 `TableV2` 改成 `Table`（資源類型不同 → 取代 → 資料遺失）。

### 身分層 / Identity layer（ADR-022）

| 項目 Item | 值 Value |
|---|---|
| Stack | `brewline-<env>-auth`（module `identity`；Prod 刪除保護＋終止保護） |
| User pool | Cognito **Essentials**，不開放自助註冊；群組 `cafe`、`simulator`、`staff` |
| 授權 | pre token 觸發器 V2 把群組轉成 access token scope（`services/identity/src/scopes.ts`）；API 路由用 scope 授權 |
| 租戶 | `custom:tenant_id`（`t_<ULID>`，任何 app client 都不能寫；**建立後不可刪除或改名**） |
| 取得 ID | SSM `/brewline/<env>/auth/{user-pool-id,user-pool-arn,web-client-id,issuer}` |
| Token | Access／ID **15 分鐘**、refresh 7 天（RSK-015） |
| 租戶隔離 | 角色 `brewline-<env>-tenant-access`：訂單函數（角色名稱必須是 `brewline-<env>-orders-*`）以 session tag `tenant_id` 扮演；`LeadingKeys = TENANT#${aws:PrincipalTag/tenant_id}` **完全比對**；商品只能改庫存欄位（ADR-024） |

### 訂貨 API / Ordering API（ADR-020、ADR-021）

| 項目 Item | 值 Value |
|---|---|
| Stack | `brewline-<env>-api`（module `ordering`；Prod 終止保護） |
| 類型 | HTTP API，Cognito JWT authorizer；**每條路由必須有 scope**（`lib/aspects/api-guardrails.ts`） |
| WAF | A1 不掛（ADR-020）；靠 JWT、scope、stage 限流、保留併發、DynamoDB 上限、Budget Actions |
| 商品資料 | `PRODUCT#<id>`／`META`（每次部署覆寫）、`STOCK`（只寫一次，部署不重設庫存）；目錄由 GSI1 `gsi1pk=CATALOG` 查詢 |
| IAM | `dynamodb:LeadingKeys` 限定 `PRODUCT#*`／`CATALOG`；**絕不授予 Scan**（`ForAllValues` 對空集合為 true）並明確 Deny |
| 驗證 | Dev 每次部署跑 smoke test custom resource（失敗即 rollback）；CI 跑 `scripts/verify-api-stack.sh` |
| 訂單（ADR-025） | `POST /orders`（`orders.write`、`Idempotency-Key`）、`GET /orders`、`GET /orders/{id}`（`orders.read`）；一個 `TransactWriteItems`＝冪等記錄＋訂單＋扣庫存；sk `ORDER#<ULID>`；每筆 ≤ 25 個商品、每個 1–500 kg；訂單函數角色**沒有** DynamoDB 權限，只能扮演租戶角色 |
| staff 訂單（ADR-027） | `GET /admin/orders?status=`、`GET`／`PATCH /admin/tenants/{tenantId}/orders/{orderId}`（`brewline/admin`）；狀態機在 `order-lifecycle.ts`；一個交易＝訂單（條件：原狀態）＋庫存（SHIPPED 消耗、CANCELLED 釋放）；staff 函數**不扮演**租戶角色 |
| 逾時取消（ADR-028） | `OrderCreated` → Standard `brewline-<env>-order-lifecycle`：Wait（Dev 10 分／Prod 48 小時）→ 仍是 CREATED 就取消並釋放庫存（`system:timeout`）；冪等靠條件寫入，不靠執行名稱 |
| 測試商品 | Dev 專用 `p-9001`（併發）、`p-9002`（smoke），不設 `gsi1pk` → 不在目錄 |
| 訂單測試 | Dev 手動：`infra/app/scripts/run-order-tests.sh`（冪等風暴、搶庫存、IAM 探測；函數 `brewline-dev-ordering-order-tests`） |
| 合約 | `api/openapi.yaml` |

### 事件層 / Event layer（ADR-026）

| 項目 Item | 值 Value |
|---|---|
| Stack | `brewline-<env>-events`（module `events`；Prod 終止保護） |
| Bus | `brewline-<env>`；SSM `/brewline/<env>/events/{bus-name,bus-arn}` |
| 來源 | DynamoDB Streams → `brewline-<env>-events-stream-publisher`（台北**沒有** Pipes、Archive）；事件過濾只處理訂單與庫存 |
| 事件 | `source=brewline.ordering`：`OrderCreated`、`OrderStatusChanged`、`StockLow`；detail 白名單、`event_id`＝stream eventID（下游去重） |
| 留存 | 規則寫入 `/aws/events/brewline-<env>`（取代 Archive）；DLQ SSE-SQS |

### Lambda 標準 / Lambda standard（ADR-023）

- 一律用 `lib/constructs/brewline-function.ts`：Node 24、arm64、X-Ray、保留併發、自建 log group（Dev 7 天／Prod 30 天）、esbuild 打包（含 AWS SDK）。
- `lib/aspects/lambda-guardrails.ts` 在 synth 時檢查；CDK 內部函數需用 `LambdaGuardrailsChecker.exempt(scope, reason)` 明確豁免。
- Lambda 程式碼在 `services/`（獨立 package：`npm ci && npm test`）。

### CI/CD 身分 / CI/CD identities（GitHub OIDC）

| 角色 Role | 帳號 Account | 信任 `sub` | 用途 Use |
|---|---|---|---|
| `gha-readonly` | Dev、Prod | `repo:chesteran321@219534971/brewline@1451431799:pull_request` | PR 的 `cdk diff`（只能扮演 lookup role） |
| `gha-deploy-dev` | Dev | `repo:chesteran321@219534971/brewline@1451431799:ref:refs/heads/main` | main 合併後部署 Dev |
| `gha-deploy-prod` | Prod | `repo:chesteran321@219534971/brewline@1451431799:environment:production` | 經 `production` environment 核准後部署 Prod |

> **`sub` 格式**：GitHub 簽發的 `sub` 含不可變 ID（`<owner>@<owner_id>/<repo>@<repo_id>`；帳號 ID `219534971`、repo ID `1451431799`）。信任政策用 `StringEquals` 逐字比對，不要用 `*` 兼容舊格式。repo 刪除後以同名重建，ID 會改變，需更新信任政策。

## 絕對規則 / Hard rules

- **不使用任何 AWS 存取金鑰**（IAM User access key、長期憑證）。人員走 IAM Identity Center；CI 走 OIDC。
  **Never use AWS access keys.** People use IAM Identity Center; CI uses OIDC.
- **不要直接 push 到 `main`**。一律開分支、開 PR。
  **Never push to `main`.** Branch and open a PR.
- **不使用任何非公開的第三方資料或格式**（限制 C-03）。EDI 只依 UN/EDIFACT 公開目錄與 DCSA 公開標準自行設計。
  **No non-public third-party data or formats.** EDI follows public UN/EDIFACT / DCSA specs only.
- 區域一律 `ap-east-2`，除非是 CloudFront 憑證（`us-east-1`）。
- Serverless 優先；不建立 NAT Gateway、常駐 EC2、Kinesis Data Streams、MSK 等常駐計費資源（多數已被 `scp-deny-expensive` 拒絕）。
- 不把機密寫進程式碼、環境變數或 repo。第三方 API key 放 SSM Parameter Store SecureString。
- 這是**公開 repo**：不要提交 Email、存取入口網址、break-glass 細節、密碼或任何憑證。

## 工作方式 / How to work

- 回答使用繁體中文，關鍵術語附英文。
- 每一步附「學習重點」說明原因；每一步完成後提供驗證方式（正向 + 反向測試）。
- 給 CLI 指令時，先 `aws sts get-caller-identity` 確認身分，對台北的指令加 `--region ap-east-2`。
- 新增 AWS 資源前：確認該服務在 ap-east-2 可用（見 status §2）、估算成本、確認 cdk-nag 通過。
- cdk-nag 的刻意例外用 `Validations.of(construct).acknowledge({ id, reason })`，並在 PR 說明原因。
- 每個資源都要有標籤 `project`、`env`、`module`、`owner`（由 `infra/app/lib/aspects/required-tags.ts` 強制）。
- 完成影響基礎設施或治理的重要變更後，提醒更新 `docs/landing-zone-status.md`。

## 錯誤訊息判讀 / Reading AWS errors

| 訊息 Message | 查 Check |
|---|---|
| `explicit deny in a service control policy` | SCP（政策 ID 對照 status §4；`p-mljh1epv` 代表預算鎖定中） |
| `resource control policy` | RCP `rcp-data-perimeter` |
| `no identity-based policy allows` | IAM 角色權限 |
| `Not authorized to perform sts:AssumeRoleWithWebIdentity` | OIDC 信任政策的 `sub` / `aud` 條件 |

## 常用指令 / Common commands

```bash
(cd services && npm ci && npm test)   # Lambda 程式碼 / Lambda code
cd infra/app
npm ci
npm test
npx cdk synth -c env=dev     # 不需要 AWS 憑證 / no AWS credentials needed
npx cdk diff  -c env=dev --no-change-set
```
