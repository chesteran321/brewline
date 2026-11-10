# 03 訂貨模組 / Ordering Module

> 需求前綴 Prefix：ORD｜優先階段 Phase：P1
> 相關文件 Related：[01 架構](01-architecture.md)｜[04 溯源](04-module-traceability.md)｜[10 資安](10-security.md)

---

## 1. 目的 / Purpose

讓咖啡廳（租戶）線上瀏覽商品、下單、設定定期補貨，並追蹤訂單狀態；內部人員可確認訂單與安排烘焙。
Enable cafés (tenants) to browse products, place orders, set up recurring replenishment, and track status; staff confirm orders and schedule roasting.

## 2. 範圍 / Scope

| 包含 In scope | 不包含 Out of scope |
|---|---|
| 商品目錄、下單、訂單狀態、定期補貨、用量預估 | 真實金流（以模擬付款取代）/ Real payments (mocked) |
| 多租戶隔離 / Multi-tenant isolation | 發票開立 / E-invoicing |
| 訂單通知信 / Order emails | 物流配送整合 / Last-mile delivery integration |

## 3. 功能需求 / Functional Requirements

| 編號 ID | 需求 Requirement | 優先 Priority | 實作服務 Implemented by | 驗證 Verified by |
|---|---|---|---|---|
| ORD-F-001 | 咖啡廳可註冊帳號並由內部人員核准開通 / Café can sign up; staff approve activation | Must | Cognito、Lambda | 整合測試 Integration test |
| ORD-F-002 | 瀏覽商品目錄，含產地、處理法、杯測分數、價格、庫存狀態 / Browse catalog with origin, process, cup score, price, stock | Must | API Gateway、Lambda、DynamoDB | API 合約測試 Contract test |
| ORD-F-003 | 下單時同時預留庫存，庫存不足則整筆失敗 / Placing an order reserves stock atomically; fails if insufficient | Must | DynamoDB TransactWriteItems | 單元測試 + 並發測試 / Unit + concurrency test |
| ORD-F-004 | 下單 API 支援 Idempotency-Key，重送不產生重複訂單 / Idempotent order creation | Must | Lambda Powertools Idempotency、DynamoDB | 重送測試 Replay test |
| ORD-F-005 | 訂單狀態流轉：建立 → 確認 → 排程烘焙 → 已烘焙 → 出貨 → 完成 / Order state machine | Must | Step Functions | 端到端測試 E2E test |
| ORD-F-006 | 狀態變更時寄送電子郵件通知 / Email on status change | Should | SES | 整合測試 |
| ORD-F-007 | 設定定期補貨（每週 / 雙週 / 每月）/ Recurring replenishment | Should | EventBridge Scheduler、Lambda | 排程測試 Schedule test |
| ORD-F-008 | 依歷史訂單預估「豆子預計用完日」/ Predict run-out date from history | Could | Lambda（移動平均 moving average） | 回測 Backtest |
| ORD-F-009 | 內部人員可查看所有租戶訂單並更新狀態 / Staff view all orders, update status | Must | Cognito group `staff`、Lambda | 權限測試 Authorization test |
| ORD-F-010 | 模擬付款：訂單建立後標記「已付款」，保留介面供日後串接 / Mock payment with pluggable interface | Must | Lambda | 單元測試 |

## 4. 非功能需求 / Non-Functional Requirements

| 編號 ID | 需求 Requirement | 目標 Target |
|---|---|---|
| ORD-N-001 | 租戶只能存取自己的資料，於資料庫層強制 / Tenant isolation enforced at data layer | 跨租戶存取測試 100% 失敗 / 100% denied |
| ORD-N-002 | 下單 API p95 延遲 / p95 latency | < 500 ms |
| ORD-N-003 | 每租戶限流 / Per-tenant throttling | 10 req/s，突發 20 / burst 20 |
| ORD-N-004 | 訂單資料保留 / Order retention | 帳號存續期間 + 2 年 |
| ORD-N-005 | 聯絡人個資最小化：僅姓名、Email、電話、地址 / PII minimization | 欄位審查 Field review |

## 5. 租戶隔離設計 / Tenant Isolation Design

1. Cognito 使用者帶自訂屬性 `custom:tenant_id`，ID Token 內含此值。
2. Lambda 從已驗證的 JWT 取出 `tenant_id`，以 STS `AssumeRole` 帶入 session tag `tenant_id`，取得**以租戶為範圍**的臨時憑證；該角色的 IAM 政策使用 `dynamodb:LeadingKeys` 條件，只能存取 `TENANT#<tenant_id>` 開頭的分割鍵。
   Lambda reads `tenant_id` from the verified JWT and calls STS `AssumeRole` with a `tenant_id` session tag to obtain tenant-scoped credentials restricted by `dynamodb:LeadingKeys`.
3. 商品與庫存屬於共用資料（`PRODUCT#` 開頭），同一角色另以第二段政策允許：`GetItem/Query` 唯讀，以及僅限 `available_kg`、`reserved_kg`、`version` 欄位的 `UpdateItem`（以 `dynamodb:Attributes` 條件限制），讓下單交易能預留庫存但無法竄改價格。
   Shared product/stock items (`PRODUCT#`) get a second statement: read-only access plus `UpdateItem` limited to stock attributes via `dynamodb:Attributes`, so orders can reserve stock without altering prices.
4. 即使程式碼有漏洞，IAM 也會拒絕跨租戶讀寫。/ Even with an app bug, IAM denies cross-tenant access.

```json
{
  "Effect": "Allow",
  "Action": ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem", "dynamodb:UpdateItem"],
  "Resource": "arn:aws:dynamodb:*:*:table/brewline-*-core",
  "Condition": {
    "ForAllValues:StringLike": {
      "dynamodb:LeadingKeys": ["TENANT#${aws:PrincipalTag/tenant_id}*"]
    }
  }
}
```

## 6. 資料模型 / Data Model（DynamoDB 單表 Single Table）

| 實體 Entity | PK | SK | 主要屬性 Key attributes |
|---|---|---|---|
| 租戶 Tenant | `TENANT#<id>` | `PROFILE` | name, status, plan |
| 聯絡人 Contact | `TENANT#<id>` | `CONTACT#<id>` | name, email, phone, address（加密 encrypted） |
| 訂單 Order | `TENANT#<id>` | `ORDER#<ts>#<id>` | status, items, total, idempotency_key |
| 定期補貨 Subscription | `TENANT#<id>` | `SUB#<id>` | product_id, qty, frequency |
| 商品 Product | `PRODUCT#<id>` | `META` | lot_id, roast_level, price_per_kg |
| 庫存 Inventory | `PRODUCT#<id>` | `STOCK` | available_kg, reserved_kg, version |

| 索引 Index | PK | SK | 用途 Purpose |
|---|---|---|---|
| GSI1 | `STATUS#<status>` | `<ts>` | 內部依狀態查訂單 / Staff query by status |

## 7. API 端點 / API Endpoints

| 方法 Method | 路徑 Path | 角色 Role | 說明 Description |
|---|---|---|---|
| GET | `/products` | cafe, staff | 商品列表 / List products |
| GET | `/products/{id}` | cafe, staff | 商品明細 / Product detail |
| POST | `/orders` | cafe | 下單（需 Idempotency-Key）/ Create order |
| GET | `/orders` | cafe | 自己的訂單 / Own orders |
| GET | `/orders/{id}` | cafe, staff | 訂單明細 / Order detail |
| PATCH | `/admin/orders/{id}` | staff | 更新狀態 / Update status |
| POST | `/subscriptions` | cafe | 建立定期補貨 / Create subscription |
| GET | `/forecast` | cafe | 預估用完日 / Run-out forecast |

完整規格見 `api/openapi.yaml`。/ Full spec in `api/openapi.yaml`.

## 8. 發布事件 / Published Events（EventBridge）

| 事件 Event | 觸發 Trigger | 訂閱者 Consumers |
|---|---|---|
| `OrderCreated` | 訂單建立 | Step Functions、資料湖 Data lake |
| `OrderStatusChanged` | 狀態變更 | SES 通知、資料湖、溯源模組 Traceability |
| `StockLow` | 可用庫存 < 門檻 | 內部 SNS 告警 |

## 9. 使用服務 / Services Used

API Gateway、Lambda、DynamoDB、Cognito、Step Functions、EventBridge、EventBridge Scheduler、SES、KMS。設定細節見 [09 服務配置](09-service-configuration.md)。

## 10. 資安重點 / Security Notes

- 不處理真實信用卡資料，PCI DSS 範圍排除（[ADR-006](14-adr-and-risks.md)）。
- 聯絡人欄位以 KMS 客戶管理金鑰加密，標記 `data-class=pii`。
- SES 設定 SPF、DKIM、DMARC，防止寄件網域遭冒用。
- 登入、註冊端點套用 WAF 速率規則。

## 11. 驗收條件 / Acceptance Criteria

- [ ] 兩個租戶互相存取對方訂單時，API 回傳 403 且 CloudTrail 有拒絕紀錄
- [ ] 同一 Idempotency-Key 重送 10 次只產生 1 筆訂單
- [ ] 100 個並發下單搶最後 10 kg 庫存，不會超賣
- [ ] 下單後 1 分鐘內收到確認信
