# 13 維運手冊 / Operations Runbook

> 相關文件 Related：[01 架構](01-architecture.md)｜[10 資安](10-security.md)｜[11 成本](11-cost-governance.md)

---

## 1. 服務水準目標 / Service Level Objectives

| SLO | 指標 SLI | 目標 Target | 錯誤預算 Error budget（30 天） |
|---|---|---|---|
| 訂貨 API 可用性 / Ordering availability | 非 5xx 回應比例 | 99.5% | 約 3.6 小時 |
| 訂貨 API 延遲 / Ordering latency | p95 | < 500 ms | — |
| 資料擷取新鮮度 / Ingestion freshness | 排程成功率 | 99% | 每月 ≤ 29 次 AIS 失敗 |
| EDI 處理 / EDI processing | 解析成功或進 DLQ | 100% | 0 筆遺失 |

## 2. 告警 / Alarms

| 編號 ID | 告警 Alarm | 條件 Condition | 嚴重度 Severity | 處置 Runbook |
|---|---|---|---|---|
| OPS-A01 | API 5xx 比例 | > 2%，連續 5 分鐘 | High | RB-OPS-01 |
| OPS-A02 | API p95 延遲 | > 1,000 ms，連續 10 分鐘 | Medium | RB-OPS-01 |
| OPS-A03 | Lambda 錯誤 | 任一函數錯誤率 > 5% | Medium | RB-OPS-01 |
| OPS-A04 | Lambda 節流 Throttles | > 0，連續 5 分鐘 | Medium | RB-OPS-01 |
| OPS-A05 | DLQ 有訊息 / DLQ not empty | ≥ 1 | Medium | RB-OPS-02 |
| OPS-A06 | Step Functions 失敗 | ≥ 1 | Medium | RB-OPS-02 |
| OPS-A07 | 擷取逾期 / Ingestion stale | 超過預期週期 2 倍無新資料 | Low | RB-OPS-03 |
| OPS-A08 | 預算 80% / Budget 80% | 見 [11](11-cost-governance.md) | Medium | RB-COST-01 |
| OPS-A09 | GuardDuty High | 任一 | High | RB-SEC-01 |
| OPS-A10 | Security Hub 分數下降 | < 90% | Low | RB-SEC-02 |

告警數量控制在 CloudWatch 免費額度內（以官方價格頁為準）；超過部分以複合告警（composite alarm）合併。

## 3. 儀表板 / Dashboard

單一 CloudWatch 儀表板 `brewline-prod-overview`：

| 區塊 Section | 內容 Widgets |
|---|---|
| 流量 Traffic | API 請求數、4xx、5xx、p50 / p95 |
| 運算 Compute | Lambda 呼叫、錯誤、節流、併發、時長 |
| 流程 Workflow | Step Functions 成功 / 失敗、DLQ 深度 |
| 資料 Data | 各來源最後擷取時間、隔離筆數 |
| 業務 Business | 每日訂單數、模擬器狀態、`cost_per_order` |

## 4. 處置手冊 / Runbooks

### RB-OPS-01 API 錯誤或延遲 / API errors or latency

1. 開啟儀表板，判斷是單一路由或全面性問題。
2. 以 X-Ray 服務地圖找出錯誤來源（Lambda、DynamoDB、外部呼叫）。
3. 若發生於部署後 1 小時內，確認 canary 是否已自動回滾；未回滾則手動將別名指回前一版。
4. 若為 DynamoDB 節流，檢查是否觸及最大吞吐量上限，評估是否為攻擊流量（查 WAF 日誌）。
5. 事後在 `docs/incidents/` 記錄時間軸、原因、改善項目。

### RB-OPS-02 DLQ 或工作流程失敗 / DLQ or workflow failure

1. 讀取 DLQ 訊息，依錯誤類型分類：資料格式、下游失敗、程式錯誤。
2. 資料格式錯誤（含模擬器注入）：確認已記錄，移至 `edi/rejected/`，不重送。
3. 下游暫時失敗：修復後以 redrive 重送。
4. 程式錯誤：建立 issue，修正後部署，再 redrive。

### RB-OPS-03 資料擷取逾期 / Ingestion stale

1. 檢查 Scheduler 執行紀錄與 Lambda 日誌。
2. 確認外部來源狀態（是否服務中斷、API key 失效、速率限制）。
3. API key 失效：更新 SSM 參數，下次排程自動生效。
4. 外部來源長期中斷：於前端資料來源頁標示，更新 [14 風險清單](14-adr-and-risks.md)。

### RB-SEC-01 高風險安全發現 / High-severity security finding

1. 確認自動處置 Lambda 已執行（停用金鑰、撤銷工作階段、標記隔離）。
2. 於 Security 帳號查詢 CloudTrail：該身分過去 24 小時的所有動作。
3. 判斷影響範圍：是否有資料讀取、資源建立、權限變更。
4. 輪替所有可能受影響的機密（SSM 參數、第三方 API key）。
5. 若有不明資源，以 IaC 狀態比對後刪除。
6. 撰寫事件報告，更新威脅模型。

### RB-SEC-02 合規分數下降 / Compliance score drop

1. 於 Security Hub 依嚴重度排序失敗檢查。
2. 能以 IaC 修正者，建立 PR 修正；屬刻意取捨者，記錄抑制原因並寫入 ADR。

### RB-COST-01 預算告警或鎖定 / Budget alert or lockdown

1. 查看成本異常偵測與 CUR 儀表板，找出暴增服務與資源。
2. 若為演練資源未清除，手動刪除堆疊。
3. 若為攻擊流量，加強 WAF 規則或暫時降低限流。
4. 若已觸發 `scp-budget-lockdown`：處理完畢後，由管理員於 Management 帳號移除 SCP，或等待下個週期自動解除。
5. 記錄於當月成本檢視。

### RB-DR-01 跨區重建演練 / Cross-region rebuild drill

1. 確認演練預算與 `ttl` 標籤設定。
2. 以 CDK 參數指定 ap-southeast-1、`env=drill` 部署全部應用堆疊。
3. 由 Prod 的 DynamoDB PITR 匯出至 S3，再匯入演練區的新表。
4. 以 S3 跨區複製或同步還原網站與必要資料。
5. 執行冒煙測試，記錄實際 RTO 與 RPO。
6. 刪除演練堆疊，確認成本儀表板無殘留。

## 5. 備份與復原 / Backup & Recovery

| 資料 Data | 備份 Backup | RPO | 還原方式 Restore |
|---|---|---|---|
| DynamoDB | PITR（35 天） | ≤ 5 分鐘 | 還原至新表後切換 |
| S3 資料湖 Data lake | 版本控制 Versioning | 0（物件層級） | 還原舊版本 |
| S3 網站 Website | 版本控制 + Git | 0 | 重新部署 |
| 基礎設施 Infrastructure | Git + CDK | 0 | `cdk deploy` |
| 稽核日誌 Audit logs | Object Lock | 0 | 不需還原（不可刪除） |

## 6. 維運行事曆 / Operations Calendar

| 頻率 Frequency | 工作 Task |
|---|---|
| 每日 Daily | 檢視告警信件 |
| 每週 Weekly | Security Hub 新發現、Access Analyzer 發現、Dependabot PR |
| 每月 Monthly | 成本檢視、SLO 錯誤預算檢視、KMS 與機密輪替狀態 |
| 每季 Quarterly | 安全事件演練、負載測試、外部資料授權複查 |
| 每半年 Semi-annually | 跨區 DR 演練、架構與 ADR 複審 |

## 7. 值班說明 / On-call Note

本專案為單人維運，無 24/7 值班；告警以 Email 通知，回應時間依 [10 資安](10-security.md) 嚴重度表。此限制已列入風險清單 RSK-005。
