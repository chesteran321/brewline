# 05 採購分析模組 / Procurement Analytics Module

> 需求前綴 Prefix：PRC｜優先階段 Phase：P2
> 相關文件 Related：[12 資料治理](12-data-governance.md)｜[06 海運追蹤](06-module-shipment-tracking.md)

---

## 1. 目的 / Purpose

整合國際咖啡價格、匯率、產區天氣與台灣進口統計，協助內部人員判斷採購時機、試算到岸成本、監控生豆庫存老化。
Combine global coffee prices, FX rates, origin weather, and Taiwan import statistics to support buying decisions, landed-cost estimation, and green-coffee aging alerts.

## 2. 資料來源 / Data Sources

| 來源 Source | 頻率 Frequency | 用途 Use | 授權 License |
|---|---|---|---|
| FRED `PCOFFOTMUSDM`、`PCOFFROBUSDM` | 每月 Monthly | 阿拉比卡 / 羅布斯塔價格趨勢 | 非商業、需標示 FRED |
| ECB 參考匯率 ECB reference rates | 每個工作日 Daily | USD、BRL 等交叉匯率 | 可再利用、需標示、不可修改 |
| 央行新台幣匯率（待確認資料集）/ CBC TWD rate (TBC) | 每日 Daily | 新台幣換算 | 政府資料開放授權（待確認） |
| Open-Meteo | 每日 Daily | 產區降雨、氣溫 | 非商業、CC BY 4.0 |
| 關務署進出口統計 Customs trade stats | 每月 Monthly | 進口總值趨勢 | 政府資料開放授權條款第 1 版 |

詳細授權見 [12 資料治理](12-data-governance.md)。

## 3. 功能需求 / Functional Requirements

| 編號 ID | 需求 Requirement | 優先 Priority | 實作服務 Implemented by | 驗證 Verified by |
|---|---|---|---|---|
| PRC-F-001 | 依排程抓取各外部資料並存入 raw zone / Scheduled ingestion to raw zone | Must | EventBridge Scheduler、Lambda、S3 | 排程執行紀錄 Run log |
| PRC-F-002 | 轉換為 Parquet 並依日期分區寫入 curated zone / Transform to partitioned Parquet | Must | Lambda（pyarrow） | 資料品質檢查 DQ check |
| PRC-F-003 | 資料品質檢查：缺值、重複、範圍異常，失敗則隔離 / Data quality gates with quarantine | Must | Lambda、S3 `quarantine/` | 注入錯誤測試 Fault injection |
| PRC-F-004 | 到岸成本試算：FOB + 海運 + 保險 + 關稅 + 匯率 / Landed-cost calculator | Must | API Gateway、Lambda | 單元測試（已知案例 known cases） |
| PRC-F-005 | 價格趨勢儀表板：12 / 36 個月走勢、與移動平均比較 / Price trend dashboard | Must | Athena、前端圖表 | 畫面檢查 |
| PRC-F-006 | 產區天氣風險指標：近 30 天降雨偏離歷史平均 / Origin weather anomaly | Should | Athena、Lambda | 回測 |
| PRC-F-007 | 生豆庫存老化提醒：入庫超過 N 個月提醒 / Green-coffee aging alert | Should | EventBridge Scheduler、Lambda、SNS | 排程測試 |
| PRC-F-008 | 每個圖表顯示資料來源與出處標示 / Source attribution on every chart | Must | 前端 Frontend | 畫面檢查 |

## 4. 非功能需求 / Non-Functional Requirements

| 編號 ID | 需求 Requirement | 目標 Target |
|---|---|---|
| PRC-N-001 | 外部 API 呼叫遵守速率限制，具退避重試 / Respect rate limits with backoff | Open-Meteo < 1,000 次/日 |
| PRC-N-002 | 單次 Athena 查詢掃描上限 / Per-query scan cap | 1 GB（workgroup 強制） |
| PRC-N-003 | 擷取作業冪等：重跑同一日期不產生重複資料 / Idempotent ingestion | 以日期分區覆寫 / Partition overwrite |
| PRC-N-004 | 原始資料不對外提供下載 / No redistribution of raw data | 資料湖私有 Private bucket |
| PRC-N-005 | API key 不得出現在程式碼或環境變數 / No keys in code or env vars | SSM Parameter Store |

## 5. 到岸成本公式 / Landed-Cost Formula

```text
landed_cost_twd_per_kg =
  ( fob_usd_per_lb × 2.20462
    + freight_usd_per_kg
    + insurance_rate × fob_usd_per_kg )
  × (1 + import_duty_rate)
  × usd_twd_rate
```

| 參數 Parameter | 來源 Source |
|---|---|
| `fob_usd_per_lb` | FRED 價格 + 品質溢價（使用者輸入）/ FRED + user premium |
| `freight_usd_per_kg` | 使用者輸入或預設值 / User input or default |
| `insurance_rate` | 預設 0.3%，可調整 / default, adjustable |
| `import_duty_rate` | 使用者輸入，需自行查詢最新稅則 / User input; verify current tariff |
| `usd_twd_rate` | 匯率資料 / FX dataset |

## 6. 資料湖表格 / Data Lake Tables（Glue Catalog）

| 表 Table | 分區 Partition | 主要欄位 Key columns |
|---|---|---|
| `curated.coffee_price_monthly` | `year` | month, arabica_usc_lb, robusta_usc_lb, source |
| `curated.fx_daily` | `year/month` | date, base, quote, rate, source |
| `curated.origin_weather_daily` | `region/year/month` | date, precip_mm, tmax_c, tmin_c, source |
| `curated.tw_trade_monthly` | `year` | month, import_total_twd_k, source |
| `analytics.weather_anomaly` | `region` | month, precip_anomaly_pct |

每張表的 Glue table properties 記錄 `source_url`、`license`、`attribution_text`。

## 7. 使用服務 / Services Used

EventBridge Scheduler、Lambda、S3、Glue Data Catalog、Athena、API Gateway、SSM Parameter Store、SNS。

## 8. 驗收條件 / Acceptance Criteria

- [ ] 連續 30 天排程無遺漏，失敗會在 15 分鐘內發出告警
- [ ] 刻意注入格式錯誤資料，進入 `quarantine/` 而非 curated zone
- [ ] 到岸成本試算與手算結果誤差 < 0.1%
- [ ] Athena 超過 1 GB 掃描的查詢被拒絕
