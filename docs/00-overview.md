# 00 專案總覽與文件索引 / Project Overview & Document Index

> 專案代號 Project codename：**BrewLine**
> 文件版本 Version：v0.1（初稿 Draft）
> 最後更新 Last updated：2026-11-05
> 作者 Author：Chester Huang

---

## 1. 專案目的 / Purpose

本專案以「台灣精品咖啡生豆進口兼烘焙批發商」為虛構情境，在 AWS 上從零建置一套 B2B 供應平台，用以展示雲端解決方案架構師（AWS Solutions Architect）的能力：功能設計、資安、成本治理、資料治理與維運。

This project builds a B2B supply platform on AWS from scratch for a fictional Taiwanese specialty green-coffee importer and wholesale roaster. Its goal is to demonstrate AWS Solutions Architect skills across functional design, security, cost governance, data governance, and operations.

## 2. 限制條件 / Constraints

| 編號 ID | 限制 Constraint | 說明 Notes |
|---|---|---|
| C-01 | 年度預算 ≤ USD 300 / Annual budget ≤ USD 300 | 包含資料來源、安全服務、演練費用 / Includes data sources, security services, drills |
| C-02 | 全部部署於 AWS / All workloads on AWS | 外部僅允許公開資料 API / Only public data APIs are external |
| C-03 | 不使用任何非公開的第三方資料 / No non-public third-party data | 含 EDI 欄位對應、合作夥伴格式 / Including EDI mappings and partner formats |
| C-04 | 非商業作品集 / Non-commercial portfolio | 多數免費資料源限非商業用途 / Most free data sources are non-commercial only |
| C-05 | 單人開發與維運 / Single maintainer | 設計需偏向全託管、低維運 / Prefer fully managed, low-ops design |

## 3. 使用者與模組 / Users & Modules

| 使用者 User | 介面 Interface | 對應模組 Module |
|---|---|---|
| 咖啡廳 Café (B2B customer) | 訂貨入口 Ordering portal | [03 訂貨 Ordering](03-module-ordering.md) |
| 一般消費者 Consumer | QR 溯源頁 Traceability page | [04 溯源 Traceability](04-module-traceability.md) |
| 供應商內部 Internal staff | 營運儀表板 Ops dashboard | [05 採購分析 Procurement analytics](05-module-procurement-analytics.md)、[06 海運追蹤 Shipment tracking](06-module-shipment-tracking.md) |
| 系統 System | 背景作業 Background jobs | [07 模擬器 Simulator](07-module-simulator.md)、[08 AI 推薦 AI recommendation](08-module-ai-recommendation.md) |

## 4. 文件索引 / Document Index

| 編號 No. | 文件 Document | 類型 Type |
|---|---|---|
| 00 | [專案總覽 Overview](00-overview.md) | 總覽 Overview |
| 01 | [架構設計書 Architecture Design](01-architecture.md) | 架構 Architecture |
| 02 | [部署與環境 Deployment & Environments](02-deployment.md) | 架構 Architecture |
| 03 | [訂貨模組 Ordering](03-module-ordering.md) | 模組需求 Module spec |
| 04 | [溯源模組 Traceability](04-module-traceability.md) | 模組需求 Module spec |
| 05 | [採購分析模組 Procurement Analytics](05-module-procurement-analytics.md) | 模組需求 Module spec |
| 06 | [海運追蹤模組 Shipment Tracking](06-module-shipment-tracking.md) | 模組需求 Module spec |
| 07 | [模擬器模組 Simulator](07-module-simulator.md) | 模組需求 Module spec |
| 08 | [AI 推薦模組 AI Recommendation](08-module-ai-recommendation.md) | 模組需求 Module spec |
| 09 | [服務配置規格 Service Configuration](09-service-configuration.md) | 橫切面 Cross-cutting |
| 10 | [資安設計 Security Design](10-security.md) | 橫切面 Cross-cutting |
| 11 | [成本治理 Cost Governance](11-cost-governance.md) | 橫切面 Cross-cutting |
| 12 | [資料治理 Data Governance](12-data-governance.md) | 橫切面 Cross-cutting |
| 13 | [維運手冊 Operations Runbook](13-operations.md) | 橫切面 Cross-cutting |
| 14 | [ADR 與風險清單 ADRs & Risk Register](14-adr-and-risks.md) | 決策 Decisions |

## 5. 需求編號規則 / Requirement ID Convention

| 前綴 Prefix | 範圍 Scope | 範例 Example |
|---|---|---|
| ORD | 訂貨 Ordering | ORD-F-001（功能 Functional）、ORD-N-001（非功能 Non-functional） |
| TRC | 溯源 Traceability | TRC-F-001 |
| PRC | 採購分析 Procurement | PRC-F-001 |
| SHP | 海運追蹤 Shipment | SHP-F-001 |
| SIM | 模擬器 Simulator | SIM-F-001 |
| AIR | AI 推薦 AI recommendation | AIR-F-001 |
| NFR | 全平台非功能 Platform-wide NFR | NFR-001 |
| SEC / COST / DATA / OPS | 橫切面控制 Cross-cutting controls | SEC-001 |
| ADR / RSK | 決策與風險 Decisions & risks | ADR-001、RSK-001 |

每條需求在模組文件中會標示「實作服務 Implemented by」與「驗證方式 Verified by」，形成需求追溯。
Each requirement lists *Implemented by* and *Verified by* to enable traceability.

## 6. 撰寫慣例 / Writing Conventions

- 標題、需求敘述、表格欄位採中英對照；說明段落以中文為主，關鍵術語附英文。
  Headings, requirement statements, and table headers are bilingual; explanatory prose is primarily Chinese with English key terms.
- 圖表使用 Mermaid，標籤以英文為主以利國際讀者閱讀。
  Diagrams use Mermaid with English labels.
- 金額皆為美元估算值，以實際帳單為準。
  All costs are USD estimates; actual bills prevail.

## 7. 交付階段 / Delivery Phases

| 階段 Phase | 期間 Duration | 範圍 Scope |
|---|---|---|
| P0 地基 Foundation | 第 1–2 週 Weeks 1–2 | Landing Zone、SCP、Budgets、CI/CD |
| P1 核心 Core | 第 3–6 週 Weeks 3–6 | 訂貨、溯源、模擬器 |
| P2 資料 Data | 第 7–9 週 Weeks 7–9 | 採購分析、海運追蹤、資料湖 |
| P3 強化 Hardening | 第 10–12 週 Weeks 10–12 | 資安偵測、可觀測性、DR 演練、文件 |
| P4 選配 Optional | 之後 Afterwards | AI 推薦 |
