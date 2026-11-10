# 09 服務配置規格 / Service Configuration Specification

> 相關文件 Related：[01 架構](01-architecture.md)｜[10 資安](10-security.md)｜[11 成本](11-cost-governance.md)

本文件集中記錄每個 AWS 服務的設定基準，模組文件只描述需求，不重複設定細節。數值為 Prod 預設，Dev 差異見 [02 部署](02-deployment.md)。
This document centralizes per-service configuration baselines. Module specs describe requirements only. Values are Prod defaults; Dev differences are in 02.

---

## 1. 邊緣與身分 / Edge & Identity

### 1.1 CloudFront

| 項目 Setting | 值 Value |
|---|---|
| 計價 Pricing | 固定費率 Free 方案 / Flat-rate Free plan |
| 來源 Origins | S3（Origin Access Control）、API Gateway |
| 最低 TLS / Minimum TLS | TLSv1.2_2021 |
| 快取 Cache | 靜態檔 1 天；`/public/trace/*` 5 分鐘；其他 API 不快取 |
| 安全標頭 Security headers | HSTS、CSP、X-Content-Type-Options、Referrer-Policy（Response headers policy） |
| 地理限制 Geo restriction | 無 None |

### 1.2 AWS WAF（方案內含 Included in plan）

| 規則 Rule | 動作 Action |
|---|---|
| AWS 託管核心規則集 Managed core rule set | Block |
| 已知惡意輸入 Known bad inputs | Block |
| 速率限制：`/public/*` 每 IP 每 5 分鐘 300 次 | Block |
| 速率限制：登入與註冊每 IP 每 5 分鐘 30 次 | Block |
| IP 信譽清單 IP reputation list | Block |

Free 方案限 5 條規則，以上剛好用滿；若需更多規則須升級 Pro 方案。
The Free plan allows 5 rules; this uses all five.

### 1.3 Cognito

| 項目 Setting | 值 Value |
|---|---|
| 方案 Tier | Lite |
| 群組 Groups | `cafe`、`staff`、`simulator` |
| 自訂屬性 Custom attributes | `tenant_id`（不可由使用者修改 / immutable by user） |
| 密碼政策 Password policy | ≥ 12 字元，含大小寫、數字 |
| MFA | `staff` 群組強制 TOTP；`cafe` 選用 |
| Token 有效期 Token validity | Access 1 h、Refresh 7 d |
| 進階防護 Threat protection | 視方案可用性決定，不可用則以 WAF 補強 |

## 2. API 與運算 / API & Compute

### 2.1 API Gateway（HTTP API）

| 項目 Setting | 值 Value |
|---|---|
| 驗證 Authorizer | Cognito JWT |
| 預設限流 Default throttle | 50 req/s，突發 100 |
| 路由限流 Route throttle | `POST /orders` 10 req/s |
| 存取日誌 Access logs | CloudWatch Logs，JSON 格式 |
| CORS | 僅允許平台網域 / Platform domain only |

### 2.2 Lambda

| 項目 Setting | 值 Value |
|---|---|
| 架構 Architecture | arm64（Graviton） |
| 記憶體 Memory | API 256 MB；資料處理 512–1024 MB |
| 逾時 Timeout | API 10 s；AIS 取樣 240 s；轉換 300 s |
| 保留併發 Reserved concurrency | API 函數 20；背景作業 2 |
| 部署 Deployment | 版本 + 別名，CodeDeploy canary 10% / 10 分鐘 |
| 追蹤 Tracing | X-Ray Active |
| 函式庫 Library | Lambda Powertools（Logger、Tracer、Metrics、Idempotency） |
| VPC | 不放入 VPC（見 [ADR-003](14-adr-and-risks.md)） |
| 程式碼簽章 Code signing | 選配 Optional |

### 2.3 Step Functions

| 項目 Setting | 值 Value |
|---|---|
| 類型 Type | Standard（訂單流程，需可稽核）/ Express（EDI 解析，量大短時） |
| 重試 Retry | 指數退避，最多 3 次 |
| 錯誤處理 Catch | 進入失敗狀態並發布 `WorkflowFailed` 事件 |
| 日誌 Logging | ERROR 層級 |

### 2.4 EventBridge 與 Scheduler

| 項目 Setting | 值 Value |
|---|---|
| 事件匯流排 Event bus | 自訂匯流排 `brewline-<env>` |
| 事件結構 Schema | `source=brewline.<module>`，`detail-type` 為事件名稱 |
| 封存 Archive | 保留 30 天，可重播 / 30-day archive for replay |
| 目標 DLQ Target DLQ | 每個規則設定 SQS DLQ |
| 排程時區 Scheduler timezone | Asia/Taipei |

## 3. 資料 / Data

### 3.1 DynamoDB

| 項目 Setting | 值 Value |
|---|---|
| 容量模式 Capacity mode | On-demand，設定最大吞吐量上限 / with max throughput |
| 加密 Encryption | KMS 客戶管理金鑰 / CMK |
| PITR | Prod 開啟 / On in prod |
| 刪除保護 Deletion protection | Prod 開啟 |
| Streams | NEW_AND_OLD_IMAGES |
| TTL 屬性 TTL attribute | `expires_at`（冪等紀錄、暫存資料） |

### 3.2 S3

| 項目 Setting | 值 Value |
|---|---|
| 公開存取封鎖 Block Public Access | 帳號層級全開 / Account-level, all on |
| 物件擁有權 Object ownership | Bucket owner enforced（停用 ACL） |
| 加密 Encryption | SSE-KMS + Bucket Key |
| 版本控制 Versioning | 資料湖與網站開啟 |
| 傳輸 Transport | Bucket policy 拒絕非 TLS 請求 |
| 生命週期 Lifecycle | raw 90 天轉 Glacier IR、2 年刪除；舊版本 30 天刪除 |
| Object Lock | 僅 Security 帳號日誌桶，Governance 模式 1 年 |

### 3.3 Glue Data Catalog 與 Athena

| 項目 Setting | 值 Value |
|---|---|
| 資料庫 Databases | `brewline_raw`、`brewline_curated`、`brewline_analytics` |
| 分區 Partitioning | Partition projection（避免 crawler 成本） |
| Athena 工作群組 Workgroup | 強制設定、結果加密、單次查詢上限 1 GB |
| 查詢結果 Query results | 獨立 S3 前綴，7 天刪除 |

### 3.4 Data Firehose

| 項目 Setting | 值 Value |
|---|---|
| 目的地 Destination | S3 raw zone |
| 緩衝 Buffer | 5 MB 或 300 秒 |
| 壓縮 Compression | GZIP |

## 4. 通知 / Notification

### 4.1 SES

| 項目 Setting | 值 Value |
|---|---|
| 網域驗證 Domain | DKIM（Easy DKIM）、SPF、DMARC `p=quarantine` |
| 沙盒 Sandbox | 作品集階段可維持沙盒，只寄給已驗證地址 |
| 退信處理 Bounce handling | SNS 通知 + 抑制清單 Suppression list |

### 4.2 SNS

| 主題 Topic | 用途 Purpose | 訂閱 Subscription |
|---|---|---|
| `brewline-prod-ops-alerts` | 維運告警 Ops alerts | Email |
| `brewline-security-findings` | 安全發現 Security findings | Email + 自動處置 Lambda |
| `brewline-billing-alerts` | 預算告警 Budget alerts | Email |

## 5. 安全與治理服務 / Security & Governance Services

| 服務 Service | 設定 Configuration |
|---|---|
| IAM Identity Center | 權限集：`Admin`（需 MFA，工作階段 1 h）、`ReadOnly`、`BillingViewer` |
| Organizations | OU：Security、Workloads；SCP、RCP、Tag Policy |
| KMS | 每個工作負載帳號 1 把 CMK，年度自動輪替 |
| SSM Parameter Store | SecureString（standard tier）存放第三方 API key |
| CloudTrail | 組織 trail、管理事件、日誌檔驗證、寫入 Security 帳號 |
| GuardDuty | 基礎偵測 + S3 Protection；不開 Runtime / EKS / RDS Protection |
| Security Hub | Prod 開啟 FSBP 標準；委派管理員為 Security 帳號 |
| AWS Config | 僅記錄 IAM、S3、KMS、Lambda、DynamoDB、API Gateway、CloudFront 等關鍵類型 |
| IAM Access Analyzer | 組織層級外部存取分析器 / Org-level external access |
| Macie | 僅一次性掃描任務，不開自動探索 / One-time job only |
| AWS Budgets | 見 [11 成本治理](11-cost-governance.md) |

## 6. 可觀測性 / Observability

| 服務 Service | 設定 Configuration |
|---|---|
| CloudWatch Logs | 保留 30 天（Prod）、7 天（Dev）；JSON 結構化日誌 |
| CloudWatch Metrics | Powertools EMF 自訂指標 |
| CloudWatch Alarms | 見 [13 維運手冊](13-operations.md) |
| CloudWatch Dashboards | 1 個總覽儀表板（免費額度內） |
| X-Ray | 取樣率 5%，錯誤請求 100% |
