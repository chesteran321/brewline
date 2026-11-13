# 14 架構決策紀錄與風險清單 / ADRs & Risk Register

> 相關文件 Related：[01 架構](01-architecture.md)｜[11 成本](11-cost-governance.md)

---

## Part A：架構決策紀錄 / Architecture Decision Records

狀態 Status：Accepted（已採用）、Proposed（待定）、Superseded（已取代）

### ADR-001 Serverless 優先 / Serverless First

- **狀態 Status**：Accepted
- **背景 Context**：年度預算 USD 300、單人維運，流量低且不規律。
- **決策 Decision**：運算以 Lambda、Step Functions 為主，不使用 ECS、EKS、EC2。
- **後果 Consequences**：閒置成本趨近 0、無需修補作業系統；代價是冷啟動延遲與 15 分鐘執行上限。長時間作業以拆分或 Step Functions 處理。

### ADR-002 自建 Landing Zone，不用 Control Tower / Self-built Landing Zone

- **狀態 Status**：Accepted
- **背景 Context**：Control Tower 會在各帳號部署 Config 等資源，成本隨帳號數倍增。
- **決策 Decision**：以 Organizations + CDK 自建同等控制（SCP、RCP、組織 CloudTrail、委派管理員）。
- **後果 Consequences**：成本可控、可展示底層理解；代價是需自行維護漂移偵測，且缺少 Account Factory。

### ADR-003 Lambda 不放 VPC、不使用 NAT Gateway / No VPC, No NAT

- **狀態 Status**：Accepted
- **背景 Context**：NAT Gateway 每月固定費用即可能吃掉年度預算一大部分；工作負載只使用 AWS 託管服務與公開 API。
- **決策 Decision**：Lambda 不連接 VPC；以 IAM、資源政策、RCP 資料邊界取代網路隔離。
- **後果 Consequences**：省下 NAT 與 Interface Endpoint 費用；代價是無法使用需 VPC 的服務（如 RDS 私有子網）。若未來需要，改用 Gateway Endpoint 並重新評估。

### ADR-004 單區部署，可用性目標 99.5% / Single Region, 99.5% Availability

- **狀態 Status**：Accepted
- **背景 Context**：多區主動備援（Global Tables、雙區 API）會使成本與複雜度倍增。
- **決策 Decision**：Prod 單區（ap-northeast-1）；DR 以 IaC 重建 + PITR 還原，RTO 4 小時。
- **後果 Consequences**：符合預算；以半年一次的跨區演練驗證 RTO。擴展路徑見 [01 §10](01-architecture.md)。

### ADR-005 WAF 採 CloudFront 固定費率 Free 方案 / WAF via CloudFront Flat-rate Free Plan

- **狀態 Status**：Accepted
- **背景 Context**：按量計費的 WAF 每月至少數美元；固定費率 Free 方案內含 WAF、DDoS 防護、DNS、TLS 憑證，且無超額費用。
- **決策 Decision**：單一 CloudFront distribution 使用 Free 方案；帳號須為 Paid plan（Free plan 帳號不能使用固定費率方案）。
- **後果 Consequences**：邊緣安全成本為 0、同時降低錢包阻斷風險；代價是 WAF 規則上限 5 條、每月 100 萬次請求額度。

### ADR-006 模擬付款，排除 PCI DSS 範圍 / Mock Payments, PCI Out of Scope

- **狀態 Status**：Accepted
- **背景 Context**：處理卡號將使整個平台落入 PCI DSS 範圍。
- **決策 Decision**：付款以介面抽象化並以模擬實作；不接觸任何卡號。
- **後果 Consequences**：合規範圍大幅縮小；未來可替換為託管結帳頁（hosted checkout）的金流服務，仍不接觸卡號。

### ADR-007 AIS 取樣而非串流 / AIS Sampling over Streaming

- **狀態 Status**：Accepted
- **背景 Context**：串流需常駐連線（EC2 或容器）或 Kinesis，皆有固定成本；作品集不需秒級即時性。
- **決策 Decision**：每 15 分鐘以 Lambda 連線 2–3 分鐘取樣。
- **後果 Consequences**：用量落在 Lambda 永久免費額度內；代價是位置資料延遲最高約 20 分鐘，部分短暫靠港可能漏偵測。

### ADR-008 安全服務啟用範圍 / Security Services Scope

- **狀態 Status**：Proposed（待試用期實測後定案）
- **背景 Context**：GuardDuty、Security Hub、Config 成本隨帳號與用量變動，試用期可能低估正式費用。
- **決策 Decision（暫定）**：GuardDuty 全帳號；Security Hub 僅 Prod；Config 範圍化記錄。試用期結束前依 [11 §7](11-cost-governance.md) 定案。
- **後果 Consequences**：以實測資料決策；定案後更新本 ADR。

### ADR-009 主要區域選擇 / Primary Region Selection

- **狀態 Status**：Proposed
- **背景 Context**：東京區域服務完整；台北區域（ap-east-2）延遲最低，但服務可用性與價格需確認。
- **決策 Decision（暫定）**：採用 ap-northeast-1；P0 階段確認台北區域是否提供本專案所需全部服務與價格。
- **後果 Consequences**：若台北區域服務齊全且價格相近，可改為主要區域並更新 SCP。

### ADR-010 DynamoDB 單表 + IAM 層租戶隔離 / Single Table with IAM Tenant Isolation

- **狀態 Status**：Accepted
- **背景 Context**：每租戶一張表在成本與維運上不可行；僅靠程式碼過濾風險高。
- **決策 Decision**：單表設計，租戶資料以 `TENANT#` 前綴分割，搭配 STS session tag 與 `dynamodb:LeadingKeys` 強制隔離。
- **後果 Consequences**：資料層強制隔離；代價是每個請求多一次 AssumeRole（可快取憑證降低延遲）。

### ADR-011 模擬器經由公開 API 寫入 / Simulator Writes via Public API

- **狀態 Status**：Accepted
- **背景 Context**：直接寫資料庫較快，但無法驗證驗證、限流、隔離等路徑。
- **決策 Decision**：模擬器以專屬 Cognito 群組帳號呼叫公開 API。
- **後果 Consequences**：模擬流量同時是持續性的端到端測試；代價是佔用 API 限流額度（上限 50%）。

### ADR-012 帳號採 Paid plan / Paid Plan Account

- **狀態 Status**：Accepted
- **背景 Context**：Free plan 帳號在期滿時會被關閉，且不能使用 CloudFront 固定費率方案；Organizations 成員帳號也不適用 Free plan 福利。
- **決策 Decision**：Management 帳號以 Paid plan 建立，依靠 Budgets 與 SCP 控制成本。
- **後果 Consequences**：可長期運作並使用全部服務；成本控制責任完全落在本專案的治理設計上。

### ADR-018 共用資料層：每帳號 1 把 CMK + DynamoDB 單表（TableV2）/ Shared Data Layer: One CMK per Account + Single Table (TableV2)

- **狀態 Status**：Accepted（2026-11-11）
- **背景 Context**：訂貨、溯源、模擬器都依賴同一張表與同一把金鑰；表的 key schema、CDK construct 類型、金鑰 alias 之後很難改（改了需重建或 retain + `cdk import`），應在獨立的小 PR 先決定。
- **決策 Decision**：
  - Stack `brewline-<env>-data`：KMS 對稱 CMK `alias/brewline-<env>-data`（年度自動輪替）＋ DynamoDB `brewline-<env>-core`。
  - 使用 CDK `TableV2`（合成為 `AWS::DynamoDB::GlobalTable`），保留日後東京 DR 演練加 replica 的彈性，且不需 custom resource。
  - 鍵名用通用 `pk` / `sk`（String）；實體型別寫在值裡。GSI 與 Streams 延後到需要的模組 PR（CloudFormation 每次更新只能新增一個 GSI）。
  - **修訂（2026-11-13，A3a）**：開啟 Streams `NEW_AND_OLD_IMAGES`，作為事件來源（A3 決策 D1：Streams → Lambda → EventBridge；台北沒有 EventBridge Pipes）。Stream ARN 發布到 SSM `/brewline/<env>/data/table-stream-arn`。之後**不要修改 view type**（GlobalTable 有多個 replica 時無法修改）。
  - On-demand 加最大吞吐量上限（COST-005）：Dev 50 / 25、Prod 200 / 100 RRU / WRU；TTL 屬性 `expires_at`。
  - Prod：刪除保護、RETAIN、終止保護；Dev：可刪除，金鑰等待期 7 天。
  - 其他 stack 由 SSM 參數 `/brewline/<env>/data/*` 取得名稱與 ARN，不用 CloudFormation Export。
  - 資料表標記 `data-class=pii`（之後會存聯絡人）。本階段為**表層級** SSE-KMS；欄位層級加密於訂貨模組決定。
  - **修訂（2026-11-12，訂貨 A1a）**：新增唯一一個**多用途 GSI**（overloaded GSI）`gsi1`，鍵 `gsi1pk`／`gsi1sk`（String），projection ALL，sparse（只有帶 `gsi1pk` 的項目會進索引）。用途由值決定：商品目錄 `CATALOG`／`PRODUCT#<id>`（A1）、訂單狀態 `STATUS#<status>`／`<ts>`（A2，取代 03 §6 的專用 GSI1）。GSI 的 on-demand 最大吞吐量**明確設成與資料表相同**：CDK 未設定時 template 不帶上限（= 索引不受限）；寫入上限也不可低於資料表，否則 GSI 反壓會連帶節流資料表寫入。
- **後果 Consequences**：
  - 費用約 USD 1／月／帳號（KMS key）；第一次、第二次輪替後各加 USD 1／月，每把上限 USD 3／月。
  - cdk-nag `AwsSolutions-DDB3` 只檢查 `CfnTable`，對 `CfnGlobalTable` 視為不適用 → 以自訂 `DataProtectionChecker` Aspect 補上（PITR、CMK、Prod 刪除保護），違規即 synth 失敗。
  - `CfnGlobalTable` 不是 ITaggable（標籤在 `Replicas[].Tags`），`RequiredTagsChecker` 已改為逐一檢查 replica，並要求資料資源帶 `data-class`。
  - 金鑰被停用或排程刪除時，資料表會無法存取；Prod 金鑰等待期 30 天、RETAIN。

### ADR-019 Dev 也開啟 PITR / PITR Enabled in Dev

- **狀態 Status**：Accepted（2026-11-11）；取代 02 §3「Dev PITR 關閉」
- **背景 Context**：PITR 依表大小計費（約 USD 0.20／GB-月），Dev 表只有 KB 等級；關閉反而需要 cdk-nag／自訂檢查的例外。
- **決策 Decision**：Dev、Prod 都開 PITR，保留 35 天。
- **後果 Consequences**：費用約 0；不需要任何例外；可在 Dev 練習 PITR 還原（RB-DR 相關演練）而不碰 Prod。

### ADR-020 A1 不掛 WAF，改以分層限流防範錢包阻斷 / No WAF in A1; Layered Throttling Against Denial of Wallet

- **狀態 Status**：Accepted（2026-11-12，訂貨 A1）；修訂 09 §1.2、03 §10、10 SEC-050 的「登入與註冊套用 WAF 速率規則」
- **背景 Context**：HTTP API 不能直接掛 WAF。三個選項：(A) CloudFront（固定費率 Free 方案，含 WAF）放在 API 前面；(B) Cognito user pool 掛 regional WAF；(C) 暫不掛 WAF。關鍵事實：登入與註冊呼叫的是 **Cognito 自己的端點**，不經過我們的 CloudFront；execute-api 預設網址也能**繞過** CloudFront。Regional WAF 每個 web ACL 約 USD 5／月加規則費，Dev＋Prod 一年約 USD 190，超過年度預算的 60%。A1 沒有前端。
- **決策 Decision**：A1 採 **C**，以分層控制取代：
  1. 不開放自助註冊（ADR-022）→ 註冊端點的攻擊面消失；
  2. JWT authorizer：未登入或簽章無效的請求在 Gateway 回 401，不叫起 Lambda；
  3. Scope 授權：越權請求在 Gateway 回 403；
  4. Stage 預設限流：Dev 10／20、Prod 50／100 req/s（COST-003）；
  5. Lambda 保留併發：API 函數 Dev 5、Prod 10（COST-004）；
  6. DynamoDB 最大吞吐量（COST-005）、Budget Actions、成本異常偵測。
  做前端時改採 **A**（CloudFront 同網域 `/api/*` → 也不需要 CORS），並同時評估 API 自訂網域＋`disableExecuteApiEndpoint`，才能關閉繞過路徑。
- **後果 Consequences**：費用 0；沒有 IP 層級規則（RSK-014）。API Gateway 官方文件沒有明確說明被拒絕的請求是否計費，保守視為計費：HTTP API 每 1M 請求約 USD 1。新增 `ApiGuardrailsChecker`：每條路由必須 JWT＋至少一個 scope，每個 stage 必須有 access log 與限流。
- **替代方案 Alternatives considered**：A（現在沒有東西可以保護，且無法涵蓋 Cognito 端點與 execute-api 繞過）；B（成本過高）。

### ADR-021 API 類型：HTTP API / API Type: HTTP API

- **狀態 Status**：Accepted（2026-11-12，訂貨 A1）
- **背景 Context**：REST API 支援 WAF、usage plan（每用戶端限流）、請求驗證、快取；HTTP API 較便宜（約 USD 1 vs 3.5／1M 請求）、延遲較低、內建 JWT authorizer 並可依 scope 授權。Config 已記錄 `AWS::ApiGatewayV2::*`（status §8）。
- **決策 Decision**：HTTP API，單一 `$default` stage（auto deploy），Lambda proxy integration（payload 2.0）。不開 CORS（A1 沒有前端）。Access log 為 JSON，**不記錄 token、標頭與 query string**。
- **後果 Consequences**：
  - **ORD-N-003「每租戶 10 req/s」無法用 HTTP API 原生達成**（只有 stage 與路由層級限流）→ A2 決定：應用層計數、改為每路由限流，或接受限制。
  - 不能直接掛 WAF（見 ADR-020）。
  - 輸入驗證在 Lambda（zod），不是 Gateway。
- **替代方案 Alternatives considered**：REST API（功能較多，但本專案需要的 WAF 與 usage plan 都要額外成本，且需修改 Config 記錄類型）。

### ADR-022 身分層：Cognito Essentials、以 scope 授權、`custom:tenant_id` / Identity: Cognito Essentials, Scope-based Authorization, `custom:tenant_id`

- **狀態 Status**：Accepted（2026-11-12，訂貨 A1b）；取代 09 §1.3 的「Lite」與「staff 群組強制 TOTP」
- **背景 Context**：A1 的 HTTP API 用 JWT authorizer；授權要在 Gateway 完成（越權請求不叫起 Lambda），A2 的租戶隔離需要 access token 帶 `tenant_id`。Cognito 預設 access token 只有群組，沒有自訂屬性；修改 access token 需要 pre token generation 觸發器 V2，只有 Essentials／Plus 可用。Lite 與 Essentials 都有每月 10,000 MAU 免費額度（以帳號或 organization 計），Plus 沒有。
- **決策 Decision**：
  - Stack `brewline-<env>-auth`（module `identity`），與 API stack 分開：user pool 有狀態，Prod 刪除保護、RETAIN、終止保護。
  - 方案 **Essentials**；不開放自助註冊（`AllowAdminCreateUserOnly`，配合 ORD-F-001 由內部人員開通）；Email 登入；密碼 ≥ 12 字元含大小寫、數字、符號，禁止重複最近 5 組。
  - 群組 `cafe`、`simulator`、`staff`。**pre token 觸發器（V2）把群組轉成 access token 的 scope**：`cafe`／`simulator` → `brewline/catalog.read`；`staff` → `brewline/catalog.read`＋`brewline/admin`。對照表在 `services/identity/src/scopes.ts`，CDK 與 Lambda 共用。
  - 自訂屬性 **`custom:tenant_id`**（String，1–64，mutable），格式 `t_<ULID>`；觸發器檢查格式後以 `tenant_id` claim 放進 access token。**任何 app client 的 writeAttributes 都不含它** → 只有管理員 API 能設定。
  - 一律 fail closed：同時屬於 staff 與 cafe／simulator、缺 tenant_id 或格式錯誤 → 不加任何 scope（登入成功但 API 回 403）。
  - MFA：Cognito 只能整個 pool 設定，**無法只對 staff 強制** → OPTIONAL、只開 TOTP（不開 SMS，沒有 SNS 角色）；部署後驗證腳本偵測「已啟用的 staff 帳號沒有 TOTP」並讓 CI 失敗（偵測性控制）。
  - App client：`web`（SRP＋refresh、無 OAuth／hosted UI、token 撤銷、不洩漏帳號是否存在）；Dev 另有 `smoke-test`（`ADMIN_USER_PASSWORD_AUTH`，只能以 IAM 身分呼叫，供 A1c smoke test）。Access／ID token 60 分鐘、refresh 7 天。
  - **修訂（2026-11-13，A2a）**：Access／ID token 改為 **15 分鐘**（RSK-015）；`cafe`／`simulator` 加上 `brewline/orders.read`、`brewline/orders.write`；`staff` 不屬於任何租戶，**不給**訂單 scope（跨租戶的訂單端點在 A3）。
  - 其他 stack 由 SSM `/brewline/<env>/auth/{user-pool-id,user-pool-arn,web-client-id,issuer[,smoke-test-client-id]}` 取得。
- **後果 Consequences**：
  - 費用 0（MAU 遠低於免費額度）。
  - cdk-nag 例外：`AwsSolutions-COG2`（MFA 非 REQUIRED，原因如上）、`AwsSolutions-COG8`（Plus 方案沒有免費額度）。預期 Security Hub CSPM FSBP `Cognito.1`（威脅防護）會失敗，列為已接受的 finding。
  - `custom:tenant_id` 之後**不能刪除、改名或修改長度限制**。
  - JWT authorizer 只檢查簽章與期限，**不檢查撤銷**：停用帳號或 GlobalSignOut 後，舊 access token 在到期前（最多 60 分鐘）仍可呼叫 API（RSK-015）。群組變更在下次 refresh 時生效。
- **替代方案 Alternatives considered**：Lite（無法自訂 access token，只能在每個 Lambda 檢查群組，越權請求仍會叫起 Lambda）；Plus（威脅防護，但沒有免費額度）；用 ID token 授權（ID token 不是給 API 用的，且沒有 scope）；Lambda authorizer（每個請求多一次 Lambda 呼叫與延遲）。

### ADR-023 Node.js 24：本機、CI、Lambda 一致 / Node.js 24 Across Local, CI and Lambda

- **狀態 Status**：Accepted（2026-11-12）；取代 status §10.3「Node 22 / `Runtime.NODEJS_22_X`」
- **背景 Context**：Lambda `nodejs22.x` 預定 2027-04-30 淘汰（之後陸續封鎖建立與更新函數），落在本作品集的第一個營運年內；`nodejs24.x` 預定 2028-04-30 淘汰。訂貨模組 A1 是第一個 Lambda，此時切換成本最低。本機、CI、Lambda 主版本不一致時，型別（`@types/node`）與實際執行行為可能不同。
- **決策 Decision**：
  - Lambda 一律 `Runtime.NODEJS_24_X`、arm64（由 A1 起的 Lambda 標準 construct 強制）。
  - 本機與 CI 用 Node 24 LTS：`.nvmrc` = 24、`package.json` `engines` = `>=24 <25`、`@types/node` ^24；Dependabot 只接受 `@types/node` 的 minor／patch。
- **後果 Consequences**：
  - Node 24 runtime 移除了 callback 形式的 handler，一律寫 `async` handler。
  - 下一次主版本升級約在 2027 年底評估（Node 26）。
- **替代方案 Alternatives considered**：維持 Node 22 → 一年內必須再遷移一次，且 cdk-nag `AwsSolutions-L1`（最新 runtime）可能需要例外。

### ADR-024 租戶隔離：STS session tag ＋ `dynamodb:LeadingKeys` 完全比對 / Tenant Isolation via STS Session Tags and Exact LeadingKeys

- **狀態 Status**：Accepted（2026-11-13，訂貨 A2a）；細化 ADR-010、修正 03 §5 的範例政策
- **背景 Context**：ORD-N-001 要求租戶隔離「在資料層強制」：程式有 bug 時，IAM 仍要拒絕跨租戶讀寫。03 §5 的範例條件 `TENANT#${aws:PrincipalTag/tenant_id}*` 結尾的 `*` 是前綴比對，會讓 `t_1` 也能存取 `TENANT#t_12…`。
- **決策 Decision**：
  - 角色 `brewline-<env>-tenant-access`（api stack）。訂單 Lambda 從**已驗證的 JWT**（API Gateway JWT authorizer）取出 `tenant_id`，呼叫 `sts:AssumeRole` 並帶 session tag `tenant_id`，取得最長 1 小時的臨時憑證；Lambda 依租戶在記憶體中快取憑證。
  - **信任政策**：只允許名稱為 `brewline-<env>-orders-*` 的角色；必須帶 `tenant_id`，長度固定為 `t_` ＋ 26 字元（以 26 個 `?` 比對，IAM 沒有正規表示式）；`aws:TagKeys` 只能是 `tenant_id`。動作 `sts:AssumeRole`＋`sts:TagSession`。呼叫端的身分政策也必須允許（`grantAssume`）。
  - **權限政策**：
    - `TENANT#<自己>`：`GetItem`／`Query`／`PutItem`／`ConditionCheckItem`，`ForAllValues:StringEquals dynamodb:LeadingKeys = TENANT#${aws:PrincipalTag/tenant_id}`（**完全比對**）。
    - 商品：`GetItem`／`BatchGetItem`（`PRODUCT#*`）；`UpdateItem` 只能動 `pk, sk, available_kg, reserved_kg, version, updated_at`（`dynamodb:Attributes`），`ReturnValues` 不可為 `ALL_*` → **改不了價格**。
    - 明確 Deny `dynamodb:Scan`；KMS 限 `kms:ViaService = dynamodb.<region>.amazonaws.com`；沒有 `DeleteItem`。
  - `TransactWriteItems` 沒有獨立的 IAM 動作，依每個項目的 Put／Update／ConditionCheck 授權。
- **後果 Consequences**：
  - 驗證以 `aws iam simulate-principal-policy` 為主（`scripts/verify-tenant-access.sh`：13 個情境，含前綴攻擊、沒有 session tag、改價格、`ALL_NEW` 讀回、Scan）。
  - 跨租戶存取的證據是應用層的 `AccessDenied` → 403／404 與結構化日誌（A2 決定 D4）；CloudTrail 未開資料事件，DynamoDB 的拒絕不會進 CloudTrail。
  - 已知限制：`dynamodb:Attributes` 無法區分排序鍵，租戶憑證理論上可以在 META 項目新增 `available_kg` 等欄位（不影響價格），由程式的 `ConditionExpression` 防範。
  - 費用 0（STS 免費）。
- **替代方案 Alternatives considered**：只在程式中過濾（bug 即外洩）；每個租戶一個 IAM 角色（數量無法擴展）；DynamoDB 細粒度存取搭配 Cognito Identity Pool（需要前端直連 DynamoDB）。

### ADR-025 下單交易與冪等 / Order Transaction and Idempotency

- **狀態 Status**：Accepted（2026-11-13，訂貨 A2b）；修正 03 §6（訂單 sk）、ORD-F-004（不用 Powertools Idempotency）
- **背景 Context**：ORD-F-003「下單同時預留庫存，不足則整筆失敗」、ORD-F-004「Idempotency-Key 重送不重複」、ORD-N-001「租戶隔離在資料層強制」。A2 決策：D1 STS session tag（ADR-024）、D2 冪等記錄放在同一個交易、D3 只做路由限流。
- **決策 Decision**：
  - `POST /orders` 用**一個 `TransactWriteItems`**：`[0]` Put `TENANT#<t>/IDEMP#<key>`（`attribute_not_exists(pk) OR expires_at < :now`，TTL 24 小時）、`[1]` Put `TENANT#<t>/ORDER#<ULID>`、`[2..]` 每個商品 Update `PRODUCT#<p>/STOCK`（`available_kg >= :q` → 減 available、加 reserved、version + 1）。依 `CancellationReasons` 的位置判斷：`[0]` 失敗 → 讀冪等記錄（同一請求 200 回原訂單、內容不同 422）；`[2..]` 失敗 → 409 並列出商品；`TransactionConflict` → 重試 3 次後 503；throttle → 503。
  - **定價在伺服器端**：先以租戶憑證 `BatchGetItem` 讀 META（價格、狀態），訂單保存價格快照；body 不接受價格（`strictObject`）。
  - 訂單 sk 改為 **`ORDER#<ULID>`**（v0.1 為 `ORDER#<ts>#<id>`）：ULID 依時間排序，`GET /orders/{id}` 可直接 `GetItem`。`order_id = o_<ULID>`。GSI1：`STATUS#CREATED`／`<created_at>#<order_id>`。
  - **輸入上限**（決策 D6 修訂）：每筆最多 **25** 個商品、每個 **1–500 kg**（整數）、商品不重複、body ≤ 16 KB。理由：交易最多 100 個項目；交易寫入為 2 倍 WRU，單一請求不可吃光表的寫入上限；下限 1 防止負數「增加」庫存。
  - 付款：`payment_status = PAID_MOCK`（ORD-F-010）。訂單函數的角色（`brewline-<env>-orders-{create,list,get}`）**沒有任何 DynamoDB／KMS 權限**，只能扮演租戶角色；憑證依租戶快取（到期前 5 分鐘更新）。
  - 讀取：`GET /orders` 以 `Query` 查自己的分割區（新的在前，`limit` 1–50，游標只帶 sk）；`GET /orders/{id}` 別的租戶 → **404**（不透露是否存在）。
  - 路由限流 `POST /orders`：Dev 2／5、Prod 10／20 req/s（stage `RouteSettings`）。
  - Dev 測試商品 `p-9001`（併發測試，A2b-2）、`p-9002`（smoke test）：只寫入 Dev，**不設 `gsi1pk`**（稀疏索引）→ 不在目錄、可以用 ID 下單。smoke test 每次重設 `p-9002` 庫存、結束後刪除兩個固定測試租戶的項目（角色權限以 `LeadingKeys` 完全比對限定）。
- **後果 Consequences**：
  - 讀價格與扣庫存**不是同一個原子操作**：租戶角色不能對商品做 `ConditionCheckItem`（ADR-024）。下單瞬間改價時，以讀到的價格成交（價格快照）。可接受：價格只由部署變更。
  - 25 個商品的交易約 54 WRU，**超過 Dev 表 25 WRU/s 的上限** → 最大訂單在 Dev 可能被 throttle，回 503（可用同一個 key 重試）。Prod 上限 100。
  - 一筆最多可預留 500 kg，可能等於某商品全部庫存；在取消與逾時釋放（A3）之前，預留無法自動釋放（RSK-016）。
  - 冪等記錄的 TTL 是延遲刪除；程式以 `expires_at` 判斷，不依賴 TTL 準時。
  - HTTP API 的 route key 必須先存在，stage 才能設定 `RouteSettings` → stage 依賴路由；`RouteSettings` 是 Json 型別，鍵名必須是 PascalCase。
  - 費用：STS 免費；每筆訂單約 6–54 WRU，smoke test 規模每月 < USD 0.1。
  - **A2b-2（Dev，手動）**：`brewline-dev-ordering-order-tests`（角色 `brewline-dev-orders-tests`）以 `infra/app/scripts/run-order-tests.sh` 觸發：冪等風暴（同一個 key 同時 10 次 → 1 筆）、搶庫存（100 個請求搶 10 kg → 不超賣、帳目一致；Dev 寫入上限造成的 throttle 視為預期）、IAM 探測（租戶 A 的真實憑證讀／寫 B、改價格、查 GSI1、Scan、刪除 → `AccessDeniedException`）。
- **替代方案 Alternatives considered**：Powertools Idempotency（需要另一張表或另一套 key，且與訂單寫入不在同一交易，會有「記錄了冪等但訂單失敗」的視窗）；以 `version` 做樂觀鎖（多一次讀取，交易條件已足夠）；訂單 sk 用時間戳（需要另一個索引才能依 ID 查）。

### ADR 範本 / ADR Template

```markdown
### ADR-0XX 標題 / Title
- **狀態 Status**：Proposed | Accepted | Superseded by ADR-0YY
- **背景 Context**：
- **決策 Decision**：
- **後果 Consequences**：
- **替代方案 Alternatives considered**：
```

---

## Part B：風險清單 / Risk Register

可能性與影響 Likelihood & Impact：H（高）、M（中）、L（低）

| 編號 ID | 風險 Risk | 可能性 L | 影響 I | 緩解 Mitigation | 負責 Owner |
|---|---|---|---|---|---|
| RSK-001 | aisstream.io 服務中斷或條款變更 / AIS source outage or terms change | M | M | 擷取逾期告警；溯源頁降級顯示；評估替代來源 | Chester |
| RSK-002 | AWS 免費額度或定價政策變更 / Free tier or pricing changes | M | M | 每季複查價格；月度成本檢視 | Chester |
| RSK-003 | 安全服務實際成本超出預估 / Security services cost overrun | M | M | 試用期實測；ADR-008 縮減順序 | Chester |
| RSK-004 | CloudFront Free 方案額度或規則數不足 / Free plan limits reached | L | M | 監控用量通知；必要時升級 Pro（每月 USD 15） | Chester |
| RSK-005 | 單人維運，無 24/7 回應 / Single maintainer, no 24/7 | H | L | 自動處置、Budget Actions、低維運架構 | Chester |
| RSK-006 | 誤解資料授權條款 / License misinterpretation | M | M | DATA-001 未確認不上線；每季授權複查 | Chester |
| RSK-007 | SCP 設定錯誤導致自己被鎖住 / Locked out by SCP | L | H | 先套用 Dev OU；保留 Management 帳號緊急存取流程 | Chester |
| RSK-008 | AIS 取樣漏偵測短暫靠港 / Missed short port calls | M | L | 地理範圍加大緩衝；以前後位置推斷 | Chester |
| RSK-009 | CQI 資料集授權灰色地帶 / CQI data license ambiguity | M | L | 只用分布；README 註明；必要時改以文獻參數產生 | Chester |
| RSK-010 | Bedrock 成本失控或不當輸出 / Bedrock cost or unsafe output | L | M | 配額、預算、Guardrails、規則式退路 | Chester |
| RSK-011 | GitHub 帳號遭入侵影響部署 / GitHub account compromise | L | H | GitHub 強制 MFA；Prod 需人工核准；OIDC 條件限制 | Chester |
| RSK-012 | 非公開的第三方資料或格式不慎混入 / Non-public third-party data leakage into project | L | H | 限制 C-03；EDI 只依公開規格；提交前自我檢查清單 | Chester |
| RSK-014 | 沒有 WAF，惡意流量只能靠限流與預算控制擋下；execute-api 網址可被直接呼叫 / No WAF; floods are stopped only by throttling and budgets | M | L | ADR-020 的六層控制；Budget Actions；前端上線時加 CloudFront＋WAF 並評估關閉 execute-api 預設端點 | Chester |
| RSK-015 | 已撤銷的帳號在 access token 到期前仍可呼叫 API；staff MFA 無法由 Cognito 強制 / Revoked users keep API access until token expiry; staff MFA not enforceable per group | M | M | Token **15 分鐘**（A2a）；部署後驗證偵測 staff 未設 TOTP；高風險操作（A2 之後）在 Lambda 再查使用者狀態 | Chester |
| RSK-016 | A3（取消、逾時釋放）之前，已預留的庫存不會自動釋放；單筆最多可預留 500 kg，可能佔滿某商品全部庫存 / Reserved stock is never released before A3; one order may reserve a product's entire stock | M | M | 只有核准開通的租戶能下單（不開放註冊）；路由限流；`GET /admin/products/{id}/stock` 監看 reserved；A3 加入取消與逾時釋放 | Chester |

風險清單於每季複查，新增或變更紀錄於 Git 歷史。
The register is reviewed quarterly; changes are tracked in Git history.
