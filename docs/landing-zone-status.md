# Landing Zone 實際狀態 / Landing Zone As-Built Status

> 狀態 Status：**P0、P1 完成；P2a 資料湖基礎、P2a-2 訂單事件、P2b 海運追蹤（訂艙、模擬航程、航程偵測）完成**——CI/CD、共用資料基礎、訂貨模組 A1–A4、模擬器 S1、溯源 S2a–S2d、資料湖基礎 P2a 與訂單事件 P2a-2（§10.21）、海運追蹤 P2b-1／P2b-2（§10.22，ADR-032 補充 E1–E12；Dev 運行觀察進行中）；FSBP 100%；下一步 **P2b-spike aisstream**（Dev 7 天）→ P2c 公開頁旅程（TRC-F-004）→ P2d IFTSTA，之後採購分析 / P0, P1, P2a, P2a-2 and P2b complete; next: P2b-spike（2026-11-23）
> 作者 Author：Chester Huang
> **優先順序 Precedence：本文件記錄實際建置結果。與 `docs/00`–`docs/14`（v0.1 初稿）衝突時，以本文件為準。**
> This document records what was actually built. Where it conflicts with the v0.1 drafts in `docs/00`–`docs/14`, this document wins.
>
> **公開版遮蔽 Public redaction**：本 repo 為公開，root Email、Identity Center 存取入口網址、break-glass 使用者名稱以 `<redacted>` 取代；完整版保存在私人文件中。帳號 ID、OU ID、政策內容依 AWS 說明不屬機密，予以保留。
> Root emails, the Identity Center access portal URL, and the break-glass user name are redacted in this public copy. Account IDs, OU IDs, and policies are kept.

---

## 1. 帳號與組織 / Accounts & Organization

| 項目 Item | ID | 備註 Notes |
|---|---|---|
| Organization | `o-3lctsv05rd` | 全部功能 All features |
| Root | `r-3oy9` | |
| OU: Security | `ou-3oy9-j0ujd8wf` | |
| OU: Workloads | `ou-3oy9-uay8f4cz` | |
| OU: Workloads › Prod | `ou-3oy9-wgtgiqg0` | **v0.1 沒有此子 OU** / not in v0.1 |
| OU: Workloads › Dev | `ou-3oy9-n4jncsis` | **v0.1 沒有此子 OU** / not in v0.1 |

| 帳號 Account | ID | Root email | OU |
|---|---|---|---|
| Management（chester huang） | `324200381393` | `<redacted>` | Root |
| brewline-security | `978684888186` | `<redacted>` | Security |
| brewline-prod | `062868712468` | `<redacted>` | Workloads › Prod |
| brewline-dev | `610935435571` | `<redacted>` | Workloads › Dev |

**為什麼拆 Prod / Dev 子 OU**：讓 SCP 能先掛 Dev OU 試套用；讓 `scp-budget-lockdown` 能分別鎖 Dev 與 Prod。

成員帳號皆有 `OrganizationAccountAccessRole`（AdministratorAccess，信任管理帳號），保留作為 Identity Center 失效時的備援進入路徑。

---

## 2. 區域 / Regions（ADR-009 已定案）

| 用途 Use | 區域 Region |
|---|---|
| 主要工作負載 Primary | **ap-east-2（台北）** |
| 全域服務 Global（CloudFront ACM、帳單） | us-east-1 |
| DR 演練 Drill | **ap-northeast-1（東京）**，僅演練時暫時開放 |
| IAM Identity Center | ap-east-2 |

- 三個成員帳號已透過 AWS Account Management 啟用 ap-east-2（opt-in 區域）。
- **台北區服務限制（ADR-009 例外）**：
  - ❌ Macie 不提供 → 不啟用（RSK-013）
  - ❌ CloudShell 不提供 → 操作時在東京開 CloudShell，指令一律加 `--region ap-east-2`
  - ❌ Security Hub CSPM 的 finding aggregator 不支援 → 不能用中央組態（ADR-015）
  - ❌ EventBridge **Pipes、Archive and replay、Schema registry／discovery、Global endpoints、API destinations** 不提供（EventBridge 各區域功能表，2026-11-13 查證）→ Streams 到 bus 用 Lambda、事件留存用 Logs 規則（ADR-026）。✅ 自訂 event bus 可建立（2026-11-13 Dev Admin 實測；Developer 權限集沒有 `events:*`）
  - ❌ AWS Config **無法記錄全域 IAM 類型**（`AWS::IAM::Role`／`Policy`／`User`／`Group`）：只有 2022 年 2 月前已提供 Config 的區域可以（AWS 文件明載，2026-11-13 實測 0 筆）
  - ❌ AWS Config 實測**未記錄 `AWS::ApiGatewayV2::Api`／`Stage`**（自 11-09 列入記錄清單，API 已存在仍為 0 筆；CSPM `APIGateway.9` 為「無資料 0/0」）→ 推論台北不支援此類型
  - ⚠️ `put-configuration-recorder` 對不支援的類型**不會報錯**，只是不記錄 → 新增類型後一律用 `list-discovered-resources` 逐一確認
  - ✅ 已確認可用：Lambda、API Gateway、DynamoDB、Step Functions、EventBridge、Scheduler、SQS、SNS、SES、Cognito、S3、Firehose、Glue、Athena、SSM、KMS、X-Ray、CloudWatch、CodeDeploy、CloudFormation、Bedrock（模型清單需另查）、GuardDuty、Security Hub、Config、CloudTrail、Access Analyzer
  - ⚠️ **服務可用 ≠ CloudFormation 支援**：CDK 內建區域資料（aws-cdk-lib 2.275.0）把 `AWS::SES::EmailIdentity`、`ConfigurationSet`、`ConfigurationSetEventDestination` 判為台北不支援（synth 錯誤 F3006）；2026-11-16 以 `aws cloudformation describe-type --region ap-east-2`（需 Admin，Developer 沒有 `cloudformation:DescribeType`）實測都存在 → 程式中 acknowledge。新增資源類型前先用 `describe-type` **初篩**；`NON_PROVISIONABLE` 或 `TypeNotFound` 只是「需要實測」的訊號 → 在 Dev 用最小測試 stack 實際 create → 讀回 → delete → 確認無殘留，再下結論（2026-11-20 判讀規則，見下方）。
  - CloudShell **沒有**台北區域：在東京開 CloudShell，指令加 `--region ap-east-2`。
  - ✅ `describe-type` 實測（2026-11-17，Dev Admin）：`AWS::Scheduler::Schedule`、`AWS::Events::EventBusPolicy` 皆 `FULLY_MUTABLE LIVE`；對照組 `AWS::Cognito::UserPoolClient` LIVE、反向 `AWS::Pipes::Pipe` → `TypeNotFoundException`（證明查的是台北）。CDK 2.275.0 對這兩種類型**沒有** F3006。
  - ✅ `describe-type` 實測（2026-11-18，Dev Admin，S2 前置）：台北與 us-east-1 的 `AWS::CloudFront::Distribution`、`AWS::CloudFront::OriginAccessControl`、`AWS::PricingPlanManager::Subscription`、`AWS::WAFv2::WebACL` 皆 `FULLY_MUTABLE LIVE`；`AWS::CertificateManager::Certificate` 在 us-east-1 `LIVE`、**台北 `NON_PROVISIONABLE`**（**2026-11-20 更正**：只是 `describe-type` 結果，**未實測建立**；`NON_PROVISIONABLE` 不代表建不出來，見下一項。不影響設計：CloudFront 本來就只接受 us-east-1 的憑證）。
  - ✅ **`describe-type`＋測試 stack 實測（2026-11-20，Dev Admin，P2 前置）**：台北 `AWS::S3::BucketPolicy`、`AWS::Athena::WorkGroup`、`AWS::Glue::DataCatalogEncryptionSettings`、`AWS::Glue::Job`、`AWS::KinesisFirehose::DeliveryStream`、`AWS::StepFunctions::StateMachine`、`AWS::Scheduler::ScheduleGroup`、`AWS::CloudWatch::CompositeAlarm`、`AWS::LakeFormation::Resource`、`AWS::S3Tables::TableBucket` 皆 `FULLY_MUTABLE LIVE`；`AWS::Athena::NamedQuery`、`AWS::LakeFormation::PrincipalPermissions` `IMMUTABLE LIVE`；**`AWS::Glue::Database`、`AWS::Glue::Table`、`AWS::Glue::Crawler`、`AWS::LakeFormation::DataLakeSettings` 為 `NON_PROVISIONABLE`**（us-east-1 的 Glue Database／Table 為 `FULLY_MUTABLE`）。對照組 `AWS::S3::Bucket` LIVE、反向 `AWS::Pipes::Pipe`、`AWS::BrewLine::NotARealType` → `TypeNotFound`。
    - 測試 stack `p2-glue-probe`（台北）：`AWS::Glue::Database`＋`AWS::Glue::Table`（`EXTERNAL_TABLE`）→ **`CREATE_COMPLETE`**；`glue get-table` 讀回正確；`delete-stack` 後 `get-database` → `EntityNotFoundException`（無殘留）。附帶：Glue 建表不檢查 `Location` 的 bucket 是否存在。
    - 結論：**台北 `NON_PROVISIONABLE` ≠ CloudFormation 建不出來**（推論：舊版類型在台北沒有登錄新的 registry handler，CloudFormation 仍以內部 provider 建立；AWS 文件未說明）。判讀規則：① `FULLY_MUTABLE`／`IMMUTABLE`＋`LIVE` → 可用（仍以首次部署驗證）；② `NON_PROVISIONABLE`／`TypeNotFound` → Dev 測試 stack 實測後再下結論；③ 每次都要有對照組（已知類型、同類型在 us-east-1）與反向組（不存在的類型）。
    - P2a 實際部署（2026-11-20，PR #78）：Glue Database ×3、Table ×1 在 Dev、Prod 皆建立成功；aws-cdk-lib 2.277.0 對這些類型**沒有** F3006（不需 acknowledge）。
  - ✅ P2b（2026-11-21，PR #83、#84）：只用既有資源類型（Lambda、`AWS::Events::Rule`〔預設 bus〕、SQS、`AWS::Glue::Table`、`AWS::Scheduler::Schedule`）；S3 → EventBridge 以 `AWS::S3::Bucket` 的 `NotificationConfiguration.EventBridgeConfiguration` 開啟（就地更新）。aws-cdk-lib 對這些類型沒有 F3006。
- **港口代碼與座標（P2b，2026-11-21，DS-09／DS-10）**：10 個 UN/LOCODE 只用種子檔列出的代碼；座標取自 **NGA World Port Index（Pub. 150）** `UpdatedPub150.csv`（美國政府作品、公有領域）。官方網站維護中（HTTP 503），由官方維護頁提供的 `https://msi.nga.mil/apology_objects/WPI.zip` 下載（Last-Modified 2026-11-20T19:40:47Z、zip 內檔案日期 2026-11-05）：zip sha256 `bd6e0eeb647d3fc79ab7d390720c60fc5d361edca9553e9ebe2c4fd8d530b53e`、csv 3,493,655 bytes／3,809 列、sha256 `8c90ee8a2bfd051b986a672fa55fcc5754f29002e95fb4f41dba46330bd5bcb8`。
  - 交叉比對：每個代碼都等於同一列 WPI 的 UN/LOCODE 欄位（WPI 有 `TW KHH` 與 `COBUN` 兩種寫法 → 去空白後比對）；WPI 編號 DJJIB 47850、KEMBA 47100、COBUN 15370、GTPRQ 15660、PABLB 15410、IDBLW 50730、BRSSZ 12970、TWKEL 57890、TWKHH 57920、VNSGN 57580（寫在 `ports.json`）。
  - 與 P2b-1 暫定座標相比移動 0.4–3.2 km（VNSGN 8.0 km，`spike_only`，模擬不使用），都小於 geofence 半徑 15 km；`coordinates_status` 由 `provisional` 改為 `wpi`。

---

## 3. 身分 / Identity

| 項目 Item | 值 Value |
|---|---|
| Identity Center instance | `ssoins-83273ce534e6d6c8`（組織執行個體、**單一區域** ap-east-2，ADR-013） |
| 存取入口網站 Access portal | `<redacted>` |
| 使用者 User | `chester`（MFA 每次登入） |
| 群組 Group | `admins` |

| 許可集 Permission set | 政策 Policy | 工作階段 Session | 指派 Assigned to |
|---|---|---|---|
| Admin | AdministratorAccess | 1 h | 全部 4 個帳號 |
| ReadOnly | ViewOnlyAccess + SecurityAudit（2026-11-11） | 4 h | 全部 4 個帳號 |
| BillingViewer | Billing | 4 h | 僅 Management |
| Developer | ViewOnlyAccess + AWSCloudShellFullAccess + 內嵌政策（見下） | 4 h | **僅 brewline-dev**（2026-11-11） |

- **Root**：管理帳號 root 有 MFA、無存取金鑰；成員帳號 root 憑證「不存在」，已啟用集中式根存取管理（根憑證管理 + 特權根動作）。
- **Break-glass**：IAM User `<redacted>`（管理帳號，AdministratorAccess，無存取金鑰，密碼存密碼管理器）。用途與流程見 §11 RB-SEC-03。
- 舊的 IAM User `developer1` 與群組 `devteam` 已刪除。
- **Developer 許可集**（2026-11-11，指派群組 `admins` → 只有 brewline-dev）：人員用來「看和測」，部署一律走 CI。
  - 內嵌政策 Allow（Resource 皆寫死帳號 610935435571、ap-east-2）：`brewline-dev-*` 資料表的資料讀寫與 Describe；KMS Decrypt／Encrypt／GenerateDataKey*／DescribeKey **僅限 `kms:ViaService=dynamodb.ap-east-2.amazonaws.com`**；Lambda invoke／Get（`brewline-dev-*`）；Logs 讀取與 Insights；Step Functions 執行（`brewline-dev-*`）；SSM 讀 `/brewline/dev/*`。
  - 內嵌政策明確 Deny：DynamoDB `DeleteTable`／`UpdateTable`／`UpdateContinuousBackups`／`UpdateTimeToLive`／`DeleteBackup`；KMS `ScheduleKeyDeletion`／`DisableKey`／`DisableKeyRotation`／`PutKeyPolicy`／`CreateGrant`／`RevokeGrant`；IAM 寫入類（`Create*`、`Delete*`、`Put*`、`Attach*`、`Detach*`、`Update*`、`Add*`、`Remove*`、`PassRole`、`Tag*`、`Untag*`、`Set*`）；CloudFormation 建立／更新／刪除／change set／終止保護；Lambda 更新程式碼與設定、刪除。
  - `AWSCloudShellFullAccess`：ViewOnlyAccess 不含 CloudShell，缺少時無法建立環境。取捨：可上傳／下載檔案；Dev 只有模擬資料，可接受。
  - IAM 角色：`arn:aws:iam::610935435571:role/aws-reserved/sso.amazonaws.com/ap-east-2/AWSReservedSSO_Developer_fa10c9f9b63adad3`
  - **2026-11-18 補權限**（管理帳號 Admin：備份 → `jq` 只新增敘述 → `diff` 只有新增 → `put-inline-policy-to-permission-set` → 讀回比對 → provision 到 Dev）：
    - `SimulatorSwitch`：`ssm:PutParameter` **只限** `/brewline/dev/simulator/state`（ARN 完全比對，ADR-030 D7）。
    - `OpsReadOnly`：Scheduler、EventBridge、Step Functions、SQS 的 `Get`／`List`／`Describe`（不含 `sqs:ReceiveMessage`）、`cloudformation:DescribeType`；`aws:RequestedRegion = ap-east-2`。
    - 已驗證（Developer 真實憑證）：正向寫 `state`（同值）、`get-schedule`、`list-rules`、DLQ 屬性、`list-state-machines`、台北 `describe-type` = `LIVE`；反向寫 `state2`、us-east-1 `describe-type` → `no identity-based policy allows`（完全比對、區域條件生效）。政策模擬（Dev Admin，`aws:RequestedRegion` context）：寫 `state` = `allowed`；寫 `config`／`credentials`、刪 `state`、`ReceiveMessage`、`PurgeQueue`、`UpdateSchedule`、`DeleteSchedule`、`PutEvents` = `implicitDeny`。
  - **2026-11-20 補權限（P2a 資料湖，規格 §4）**（同上流程：管理帳號 Admin，備份 `~/backup-devps-p2a-20261120` → `jq` 只新增 7 條 → 舊敘述變更 0、新增 7 → put → 讀回 identical（17 條）→ provision 到 Dev `SUCCEEDED`；只有 Dev）：
    - `LakeAthenaQuery`：查詢類動作**只限** workgroup `brewline-dev-analytics`（沒有 `primary`）；`LakeAthenaList`：`List*`，`aws:RequestedRegion = ap-east-2`。
    - `LakeGlueRead`：`catalog`、`database/brewline_*`、`table/brewline_*/*` 的 Get。
    - `LakeRead`：lake bucket 讀取；`LakeSmokeWrite`：`PutObject`／`DeleteObject` **只限** `raw/_smoke/*`；`AthenaResults`：結果 bucket 讀寫。
    - `LakeKmsViaS3`：`kms:Decrypt`／`GenerateDataKey` **只限** `kms:ViaService = s3.ap-east-2.amazonaws.com`（既有 `KmsOnlyViaDynamoDbDev` 不變）→ Developer 仍解不開 SSM SecureString。
    - 已驗證（Developer 真實憑證，2026-11-20）：T1 正向寫 smoke 物件（不帶加密標頭 → 預設加密套 CMK＋Bucket Key）、查詢 `SUCCEEDED`（掃描 72 bytes、結果 `2 3`、結果物件 `aws:kms`＋CMK）；反向 T2 `primary` workgroup → `AccessDeniedException`；T3 160 MB → `CANCELLED`「Bytes scanned limit was exceeded」（`scanned = 104857600`）；T4 寫 `raw/other/` → `no identity-based policy allows`；T5 `alias/aws/s3`、T5b `--sse AES256` → `explicit deny in a resource-based policy`；T6 SecureString → `kms:Decrypt … no identity-based policy allows`。附帶反向：Dev Developer `ListBucket` Prod lake → `no resource-based policy allows`（跨帳號）。
  - 已驗證：正向 SSM 讀取、DynamoDB put／get／delete item（KMS 經 DynamoDB 自動解密）；反向 `delete-table`、`iam create-user` 皆 `explicit deny in an identity-based policy`；KMS 以政策模擬器驗證（Dev Admin 執行 `simulate-principal-policy`）：`DisableKey`、`ScheduleKeyDeletion`、`PutKeyPolicy`、`DisableKeyRotation` 為 `explicitDeny`，直接 `kms:Decrypt` 為 `implicitDeny`（`kms:ViaService` 生效）；brewline-prod 無此許可集。
- **ReadOnly 許可集加上 `SecurityAudit`**（2026-11-11，重新佈建 4 個帳號）：「稽核員」組合，可讀 Config、Security Hub CSPM、IAM／S3／KMS 等安全設定，**不能讀資料內容**；不含 CloudShell（只用主控台）。
  - 已驗證（Prod ReadOnly 主控台）：正向 Config 資源清單看到 `brewline-prod-core`（合規）、Security Hub CSPM `DynamoDB.2` 通過；反向 DynamoDB 探索項目 `dynamodb:Scan` 被拒（`no identity-based policy allows the action`）。

---

## 4. 組織政策 / Organization Policies

| 政策 Policy | 類型 | ID | 掛載 Attached |
|---|---|---|---|
| FullAWSAccess | SCP（AWS 內建） | — | Root |
| `scp-baseline` | SCP | `p-jzberlon` | Root |
| `scp-deny-expensive` | SCP | `p-1iinm3yf` | Root |
| `scp-region-restrict` | SCP | `p-ru77otvs` | Root |
| `scp-budget-lockdown` | SCP | `p-mljh1epv` | **不掛**，只由 Budget Actions 掛載 |
| `rcp-data-perimeter` | RCP | `p-02ami4dm4w` | Root |

**設計決策**：每個節點最多 5 條 SCP（含 FullAWSAccess），所以 v0.1 的 leave-org、deny-root、protect-s3-bpa、protect-security-services 合併成 `scp-baseline`，以 `Sid` 區分。Root 目前 4/5。

所有政策都先掛 Dev OU 測試、驗證後再改掛 Root。**政策變更後需等 1–2 分鐘才生效（最終一致）。**

### 4.1 `scp-baseline`

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "DenyLeaveOrganization", "Effect": "Deny", "Action": "organizations:LeaveOrganization", "Resource": "*" },
    { "Sid": "DenyRootUser", "Effect": "Deny", "Action": "*", "Resource": "*",
      "Condition": { "StringLike": { "aws:PrincipalArn": "arn:aws:iam::*:root" } } },
    { "Sid": "ProtectS3AccountBlockPublicAccess", "Effect": "Deny", "Action": "s3:PutAccountPublicAccessBlock", "Resource": "*" },
    { "Sid": "DenyObjectLockBypass", "Effect": "Deny", "Action": "s3:BypassGovernanceRetention", "Resource": "*" },
    { "Sid": "ProtectAuditLogBucket", "Effect": "Deny",
      "Action": ["s3:DeleteBucket", "s3:PutBucketPolicy", "s3:DeleteBucketPolicy", "s3:PutBucketVersioning",
                 "s3:PutBucketObjectLockConfiguration", "s3:PutLifecycleConfiguration"],
      "Resource": "arn:aws:s3:::brewline-security-cloudtrail-978684888186" },
    { "Sid": "ProtectSecurityServices", "Effect": "Deny",
      "Action": ["cloudtrail:StopLogging", "cloudtrail:DeleteTrail", "cloudtrail:UpdateTrail", "cloudtrail:PutEventSelectors",
                 "guardduty:DeleteDetector", "guardduty:DisassociateFromAdministratorAccount", "guardduty:DisassociateFromMasterAccount",
                 "securityhub:DisableSecurityHub", "securityhub:DisassociateFromAdministratorAccount",
                 "securityhub:DisassociateFromMasterAccount", "securityhub:BatchDisableStandards",
                 "config:StopConfigurationRecorder", "config:DeleteConfigurationRecorder", "config:DeleteDeliveryChannel"],
      "Resource": "*" }
  ]
}
```

刻意**不**禁止：`guardduty:UpdateDetector`（委派管理員要調整自己的設定）、`config:PutConfigurationRecorder`（之後要增加記錄類型）。
前提：各帳號的 S3 帳號層級 Block Public Access 已在掛政策前全部開啟。

### 4.2 `scp-deny-expensive`

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "DenyExpensiveServices", "Effect": "Deny",
      "Action": ["ec2:CreateNatGateway", "eks:CreateCluster", "eks:CreateNodegroup",
                 "sagemaker:CreateEndpoint", "sagemaker:CreateNotebookInstance",
                 "redshift:CreateCluster", "redshift-serverless:CreateWorkgroup",
                 "es:CreateDomain", "es:CreateElasticsearchDomain", "aoss:CreateCollection",
                 "kafka:CreateCluster", "kafka:CreateClusterV2", "kinesis:CreateStream",
                 "shield:CreateSubscription"],
      "Resource": "*" },
    { "Sid": "DenyLongTermCommitments", "Effect": "Deny",
      "Action": ["ec2:PurchaseReservedInstancesOffering", "savingsplans:CreateSavingsPlan",
                 "rds:PurchaseReservedDBInstancesOffering", "dynamodb:PurchaseReservedCapacityOfferings"],
      "Resource": "*" },
    { "Sid": "DenyLargeEc2Instances", "Effect": "Deny", "Action": "ec2:RunInstances",
      "Resource": "arn:aws:ec2:*:*:instance/*",
      "Condition": { "StringNotLike": { "ec2:InstanceType": ["t4g.nano", "t4g.micro", "t4g.small", "t3.nano", "t3.micro", "t3.small"] } } }
  ]
}
```

相對 v0.1 新增：MSK、Kinesis Data Streams（對應 SHP-N-002）、Shield Advanced、長期承諾購買。

### 4.3 `scp-region-restrict`

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "DenyOutsideAllowedRegions", "Effect": "Deny",
    "NotAction": ["a4b:*", "account:*", "acm:*", "aws-marketplace-management:*", "aws-marketplace:*", "aws-portal:*",
                  "bcm-data-exports:*", "billing:*", "budgets:*", "ce:*", "chime:*", "cloudfront:*", "cloudshell:*",
                  "config:*", "cost-optimization-hub:*", "cur:*", "directconnect:*",
                  "ec2:DescribeRegions", "ec2:DescribeTransitGateways", "ec2:DescribeVpnGateways",
                  "fms:*", "freetier:*", "globalaccelerator:*", "health:*", "iam:*", "importexport:*", "invoicing:*",
                  "kms:*", "mobileanalytics:*", "networkmanager:*", "notifications:*", "organizations:*", "payments:*",
                  "pricing:*", "route53:*", "route53domains:*", "route53-recovery-cluster:*",
                  "route53-recovery-control-config:*", "route53-recovery-readiness:*",
                  "s3:GetAccountPublic*", "s3:ListAllMyBuckets", "s3:ListMultiRegionAccessPoints", "s3:PutAccountPublic*",
                  "shield:*", "sts:*", "support:*", "tax:*", "trustedadvisor:*", "waf-regional:*", "waf:*", "wafv2:*",
                  "wellarchitected:*"],
    "Resource": "*",
    "Condition": { "StringNotEquals": { "aws:RequestedRegion": ["ap-east-2", "us-east-1"] } }
  }]
}
```

- 允許 ap-east-2、us-east-1。**東京平時不允許**。
- v0.1 的「`env=drill` 標籤例外」改為：**DR 演練前暫時把 `ap-northeast-1` 加入允許清單，演練後移除**（寫入 RB-DR-01）。
- `cloudshell:*` 在 NotAction 裡，所以東京 CloudShell 環境能開，但裡面的 `aws` 指令要加 `--region ap-east-2`。

### 4.4 `scp-budget-lockdown`（平時不掛）

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "DenyNewResourcesDuringBudgetLockdown", "Effect": "Deny",
    "Action": ["cloudformation:CreateStack", "cloudformation:UpdateStack", "cloudformation:CreateChangeSet",
               "cloudformation:ExecuteChangeSet", "lambda:CreateFunction", "lambda:UpdateFunctionCode",
               "ec2:RunInstances", "s3:CreateBucket", "dynamodb:CreateTable", "states:CreateStateMachine",
               "bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream",
               "athena:StartQueryExecution", "glue:StartJobRun", "glue:StartCrawler",
               "cognito-idp:AdminInitiateAuth"],
    "Resource": "*",
    "Condition": { "ArnNotLike": { "aws:PrincipalArn": "arn:aws:iam::*:role/aws-reserved/sso.amazonaws.com/*AWSReservedSSO_Admin_*" } }
  }]
}
```

- 只擋建立與按次計費呼叫，不擋刪除；Identity Center Admin 角色豁免。
- 鎖定時 **CDK / GitHub Actions 部署會全部失敗**（錯誤訊息出現 `p-mljh1epv`）。
- ~~擋不住已經在跑的排程 Lambda~~ → **2026-11-17 加上 `cognito-idp:AdminInitiateAuth`（ADR-030 D7②）**：鎖定時模擬器（以及 Dev smoke test）無法以 IAM 身分登入 Cognito，排程雖然照常觸發，每輪都會在登入時失敗 → 模擬器實質停止。真實咖啡廳走 SRP（`InitiateAuth`，不經 IAM），不受影響。SSM 開關（SIM-N-001）仍是平時的暫停方式。
  - 已驗證（管理帳號 Admin，暫時掛到 Dev OU 約 3 分鐘）：反向：Dev `OrganizationAccountAccessRole` → `admin-initiate-auth` → `AccessDeniedException … explicit deny in a service control policy: …/p-mljh1epv`；移除後同一指令 → `NotAuthorizedException`（已通過授權、帳號不存在）；`list-targets-for-policy` = `[]`。
  - 測試選 `OrganizationAccountAccessRole` 的原因：管理帳號不受 SCP 限制、SSO Admin 被此政策豁免；這個角色有 AdministratorAccess 又不在豁免名單，被拒只可能是 SCP。

### 4.5 `rcp-data-perimeter`

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "EnforceOrgIdentities", "Effect": "Deny", "Principal": "*",
      "Action": ["s3:*", "kms:*", "sqs:*", "secretsmanager:*", "sts:AssumeRole"], "Resource": "*",
      "Condition": {
        "StringNotEqualsIfExists": { "aws:PrincipalOrgID": "o-3lctsv05rd", "aws:ResourceTag/dp:exclude:identity": "true" },
        "BoolIfExists": { "aws:PrincipalIsAWSService": "false" } } },
    { "Sid": "EnforceS3Tls", "Effect": "Deny", "Principal": "*", "Action": "s3:*", "Resource": "*",
      "Condition": { "BoolIfExists": { "aws:SecureTransport": "false" } } }
  ]
}
```

- STS 只放 `sts:AssumeRole`，**不可**改成 `sts:*`，否則 GitHub OIDC（AssumeRoleWithWebIdentity）與 SSO（AssumeRoleWithSAML）會被擋。
- S3 強制 TLS 由 RCP 統一處理 → **bucket policy 不需要再寫拒絕非 TLS**（取代 09 §3.2 該項）。
- 例外：資源貼標籤 `dp:exclude:identity=true` 可豁免組織身分限制。

---

## 5. 成本治理 / Cost Governance

| 預算 Budget | 金額 | 範圍 | 告警 |
|---|---|---|---|
| `brewline-annual-cap` | USD 300／年 | 全組織 | 實際 50%、80%；預測 100% |
| `brewline-monthly` | USD 25／月 | 全組織 | 範本預設：實際 85%、100%；預測 100% |
| `brewline-prod-monthly` | USD 15／月 | Linked account 062868712468 | 實際 80%、100%；預測 100% |
| `brewline-dev-monthly` | USD **10**／月（2026-11-20，原 5） | Linked account 610935435571 | 同上 |
| `brewline-security-monthly` | USD 5／月 | Linked account 978684888186 | 同上 |

- 分帳號預算以 **CLI 建立**（新帳號尚無帳單資料時，主控台的 Linked account 清單選不到）。
- 2026-09-30 之後新增的預算收件人**必須驗證 Email** 才收得到通知。驗證狀態**只能在主控台的預算詳細頁**查看（沒有 CLI）；5 個預算的收件人 2026-11-20 皆 **Verified**（BillingViewer）。
- **Dev 月預算 USD 5 → 10**（2026-11-20，管理帳號主控台只改金額）：11-01～11-19 Dev USD 2.17，其中 AWS Config 1.19（Dev 每日記錄，隨部署量增加；11-17 單日 0.86）、Route 53 0.50、KMS 0.24、WAF 0.12（S2b→S2c 之間，一次性）；照最近一週推算月底約 USD 5.8 → 會觸發 Dev Budget Action（實際 100% AUTOMATIC 鎖定）。12 月估 USD 4–8（Config、GuardDuty 12-09 試用結束、告警、P2）。Budget Action 與通知是百分比門檻 → 自動變成 USD 10 的 80%／100%。驗證：`describe-budget` → `10.0 USD`、動作仍 `100.0 PERCENTAGE AUTOMATIC STANDBY`、通知前後一致、其他 4 個預算金額未變。降低 Dev Config 費用（排除 Lambda 類型或關閉）留到 2026-12-04 決策點（§13）。
- **免費額度是組織層級**（2026-11-20 實測，管理帳號 BillingViewer，Free Tier 頁）：`Global-CW:AlarmMonitorUsage`、`Global-Lambda-GB-Second`、`Global-Request`、`Global-StateTransition` 整個組織各只有一列（含管理帳號）→ CloudWatch 告警的 10 個免費額度是**全組織共用**，不是每帳號。告警總數：2026-11-20 管理帳號 2 個舊告警刪除後 Dev 10＋Prod 10 = 20；P2a 後 22；**P2b 後 24**（Dev 12、Prod 12，2026-11-21 `verify-*` 實測；每月約 USD 1.4）；P2 全部完成後預估 26（約 USD 1.6／月，ADR-030 D9 修訂：告警費 ≤ USD 2／月）。Lambda、Step Functions 用量遠低於免費額度。
- 預測注意：`get-cost-forecast` 對新帳號回 `DataUnavailableException`；手動推算時固定費用（Route 53、KMS）在月初入帳、部署日 Config 尖峰，不能用線性推估。

| Budget Action | 門檻 | 動作 | 目標 | 核准 | Action ID |
|---|---|---|---|---|---|
| brewline-dev-monthly | 實際 100% | 掛 `scp-budget-lockdown` | Dev OU | AUTOMATIC | `b398ede6-399f-499c-9c41-3215facf0b5a` |
| brewline-prod-monthly | 實際 120% | 掛 `scp-budget-lockdown` | Prod OU | MANUAL | `40d648c3-6a97-4835-b168-952a4fc37ff9` |

- 執行角色：`arn:aws:iam::324200381393:role/brewline-budget-actions-role`
  - 信任 `budgets.amazonaws.com`，條件 `aws:SourceAccount=324200381393`、`aws:SourceArn=arn:aws:budgets::324200381393:budget/*`
  - 內嵌政策 `attach-lockdown-scp`：只能把 `p-mljh1epv` 掛到 / 移出 Dev、Prod OU，外加 Organizations 唯讀
- 解除：在 Budget Action 頁面按「還原」，或於管理帳號手動分離 SCP。週期重置是否自動解除**尚未實測**。

成本異常偵測：AWS 服務監控器，訂閱 `brewline-anomaly-alert`，**每日摘要**寄 Email，門檻 USD 2。之後有 SNS 主題再改為個別告警。

---

## 6. 稽核日誌 / CloudTrail

| 項目 | 值 |
|---|---|
| Trail | `brewline-org-trail`（組織 trail、多區域、主區域 ap-east-2，建在管理帳號） |
| ARN | `arn:aws:cloudtrail:ap-east-2:324200381393:trail/brewline-org-trail` |
| 事件 | 管理事件讀＋寫；無資料事件、無 Insights、無 CloudWatch Logs |
| 日誌檔驗證 | 啟用 |
| 遞迴記錄 | **關閉**（預防日後開 CloudWatch Logs + 資料事件時產生迴圈） |
| 加密 | **SSE-S3**（ADR-014，不用 KMS） |
| Bucket | `brewline-security-cloudtrail-978684888186`（Security 帳號，ap-east-2） |
| Object Lock | 啟用，預設 **GOVERNANCE 365 天**（API 顯示為 `DefaultEventHold.Days=365`，實測物件 `RetainUntilDate` 為寫入後一年） |
| 生命週期 | 目前版本 366 天過期；非目前版本 30 天刪除 |
| Bucket policy | 只允許 `cloudtrail.amazonaws.com`，`aws:SourceArn` 限定上述 trail；路徑 `AWSLogs/324200381393/*`、`AWSLogs/o-3lctsv05rd/*` |

已驗證：Security 帳號 Admin 無法永久刪除日誌（Object Lock）、無法用 bypass 刪除（SCP）、無法修改 bucket 設定（SCP）。
修改此 bucket 的流程：從管理帳號暫時移除 `scp-baseline` 的 `ProtectAuditLogBucket` → 修改 → 加回。

---

## 7. 威脅偵測 / GuardDuty

委派管理員：**brewline-security**（ap-east-2、us-east-1 各委派一次）。組織自動啟用：**新帳戶和現有帳戶**。

| 帳號 | ap-east-2 | us-east-1 |
|---|---|---|
| brewline-security | 基本偵測 + S3 保護 | 基本偵測 |
| Management | 基本偵測 + S3 保護 + **EBS Malware Protection（已知例外）** | 基本偵測 |
| brewline-prod | 基本偵測 + S3 保護 | 基本偵測 |
| brewline-dev | 基本偵測 + S3 保護 | 基本偵測 |

- 不開：EKS、Runtime Monitoring、RDS、Lambda、Malware（EC2/S3）、AI Protection（P4 再評估）。
- 只開台北與 us-east-1；其他區域由 `scp-region-restrict` 從源頭阻擋。
- **已知例外**：管理帳號 ap-east-2 偵測器由 `create-detector` 建立時套用預設值開啟了 EBS Malware Protection；成為成員後成員與委派管理員都無法停用（自動啟用「所有帳戶」時也無法取消關聯）。該帳號無 EC2，不會觸發掃描。於試用期決策點確認費用為 0。（**2026-11-20 補註**：盤點發現 BrewLine 之前的實驗留下一台停機、無 EBS 磁碟的 `ml-api-server`（t3.micro）及其 SG、IAM 角色＋instance profile、key pair、2 個 CloudWatch 告警，已依依賴順序全部清理；**自 2026-11-20 起管理帳號確實沒有 EC2**、台北與 us-east-1 告警 0 個、S3 bucket 0 個、台北 Glue 資料庫 0 個；預設 VPC 保留。教訓：停機的 instance 仍保留主要 ENI，只有 terminate 才刪除；清理前要整串盤點 instance、EBS、快照、AMI、EIP、profile、SG、key pair、告警、SNS；沒有在用但仍有權限的身分也是清理對象。）
- 教訓：成員帳號要先調好偵測器功能再加入成員；加入後設定權移交委派管理員。
- 試用期：2026-11-09 起 30 天（每帳號每區域）。

---

## 8. 設定記錄 / AWS Config

| 帳號 | 記錄 | 頻率 | 區域 |
|---|---|---|---|
| brewline-prod | ✅ | CONTINUOUS | ap-east-2 |
| brewline-dev | ✅ | DAILY | ap-east-2 |
| brewline-security、Management | ❌ | — | — |

- 記錄類型（`INCLUSION_BY_RESOURCE_TYPES`）：
  - **Dev：8 種**：`AWS::IAM::Role`、`AWS::IAM::Policy`、`AWS::S3::Bucket`、`AWS::KMS::Key`、`AWS::Lambda::Function`、`AWS::DynamoDB::Table`、`AWS::ApiGatewayV2::Api`、`AWS::ApiGatewayV2::Stage`
  - **Prod：57 種**（2026-11-13）：上述 8 種 ＋ CSPM `Config.1` 要求的 49 種（EC2 VPC／Subnet／SecurityGroup／NetworkAcl／Instance…、CloudFormation::Stack、Cognito::UserPool、Events::EventBus、Athena::WorkGroup、StepFunctions::StateMachine、SNS::Topic、SecretsManager::Secret、ACM::Certificate、RDS／ECS／EFS／ELB／MSK 等）。原因：`Config.1`（CRITICAL）要求記錄所有啟用中控制項需要的類型；缺少時對應控制項只能顯示「不明」。
  - **實際記錄到（Prod，2026-11-13 10:54）**：VPC 1、Subnet 3、SecurityGroup 1、NetworkAcl 1（預設 VPC）、CloudFormation::Stack 5、Cognito::UserPool 1、Events::EventBus 1、Athena::WorkGroup 1、Lambda::Function 6；**IAM::Role 0、ApiGatewayV2::Api／Stage 0**（台北限制，見 §2）；RDS 等 0（無資源）。
  - 費用：Config 按**記錄到的設定項目**收費，沒有資源的類型為 0 元。新增 14 個資源 ≈ USD 0.04（一次）；之後主要是每次部署的 stack 變更 ≈ USD 0.4／月。
  - 變更方式：Prod Admin，`describe-configuration-recorders` 備份 → `jq` 只合併 `resourceTypes` → `diff` 確認其他欄位不變 → `put-configuration-recorder`（整份覆寫）。`scp-baseline` 刻意允許 `PutConfigurationRecorder`（§4.1）。
- 使用服務連結角色 `AWSServiceRoleForConfig`；保留期 365 天；快照每 24 小時。
- 交付到 `brewline-security-config-978684888186`（Security 帳號；版本控制；無 Object Lock；目前版本 365 天過期、非目前版本 30 天）。Bucket policy 以 `aws:SourceAccount` 允許 062868712468、610935435571。
- **缺口**：CloudFront 設定只記錄在 us-east-1 的 Config，本專案未記錄 → 改由 CDK + cdk-nag 部署前檢查。
- **缺口（2026-11-13）**：台北無法記錄 IAM 與 ApiGatewayV2 → IAM 變更由 CloudTrail 管理事件留存（無 Config 時間軸）；HTTP API 的 access log 與授權由 `ApiGuardrailsChecker`（部署前）＋`verify-api-stack.sh`（部署後）確認。可選：之後在 us-east-1 另開只記錄 IAM 的 recorder（需評估費用）。
- `get-discovered-resource-counts` 是定期彙總、會落後；確認某類型有無記錄用 `list-discovered-resources --resource-type`。
- CLI 注意：`recordingMode` 要寫在 `--configuration-recorder` 的 JSON 內，不是獨立參數。

---

## 9. 合規檢查 / Security Hub CSPM

- 委派管理員：brewline-security（**僅 ap-east-2**）。
- 使用**本機組態**，不是中央組態（ADR-015：台北不支援 finding aggregator，無法當主區域）。
- Auto-enable accounts：**關**；Auto-enable default standards：**關**。

| 帳號 | Security Hub CSPM | 標準 |
|---|---|---|
| brewline-security | ✅（委派管理員） | **無**（預設的 FSBP、CIS v1.2.0 已停用） |
| brewline-prod | ✅ | **只有 AWS FSBP v1.0.0** |
| brewline-dev、Management | ❌ | — |

- 不用 CIS：帳號基線項目已由 SCP、Identity Center 以預防性控制達成；FSBP 涵蓋本專案實際使用的 Serverless 服務。
- 試用期：2026-11-09 起 30 天。

已處理的 finding（Prod，2026-11-13；**2026-11-19 全面整理，見下方**）：

| 控制項 | 狀態 | 處理 |
|---|---|---|
| `Config.1`（CRITICAL） | FAILED：`CONFIG_RECORDER_MISSING_REQUIRED_RESOURCE_TYPES`（49 種） | recorder 加入 49 種（§8）→ **2026-11-19 確認 `PASSED`／`RESOLVED`**：台北不支援的類型（IAM、ApiGatewayV2）不算缺少，**不需要 SUPPRESSED**（先補能補的、再看剩餘原因，而不是直接隱藏） |
| `Cognito.1`（中） | 原為「不明」（Config 未記錄 UserPool）→ 加入記錄類型後**數分鐘內**變成 FAILED | **SUPPRESSED**（`batch-update-findings`，備註引用 ADR-022：Plus 方案無免費額度；以不開放註冊、強密碼、JWT＋scope、限流緩解） |
| `APIGateway.9`（中） | 「無資料」0/0（Config 不記錄 ApiGatewayV2） | 不處理；由 `ApiGuardrailsChecker`＋驗證腳本 `Stage access logs = true` 涵蓋（同 `KMS.4` 的作法） |

- 控制項頁面的「不明」＝有資源但缺資料（WARNING）；「無資料」＝CSPM 看不到任何資源。
- 「已隱藏」只改**工作流程狀態**，finding 的合規狀態仍為 FAILED；資源設定再變動時，同一筆 finding 會更新並保留 SUPPRESSED。但**計算控制項狀態與安全分數時，SUPPRESSED 的 finding 不計入**（2026-11-20 實測：6 個控制項的 finding 全部 SUPPRESSED 後分數 100%；原先以為「隱藏不會提高分數」是錯的）→ 隱藏一定要有寫明的理由，否則就是在灌分數。

**2026-11-19 FSBP 全面整理**（Prod，起點 86%、21 個控制項失敗 → **100%**，2026-11-20 確認）：

| 處理 | 控制項 | 做法 |
|---|---|---|
| **刪除預設 VPC**（9 項） | `EC2.2`、`EC2.15`（3 個子網路）、`EC2.6`、`EC2.10`、`EC2.55`–`58` | 台北預設 VPC 沒有任何使用者（ENI、VPC 內 Lambda、endpoint、NAT、peering 皆 0）→ 拆 IGW、刪 3 個子網路、刪 VPC；**Dev 也同樣刪除**（兩個環境台北都沒有任何 VPC）。回復：`aws ec2 create-default-vpc`。BrewLine 全部是不需要 VPC 的託管服務（COST-011）→ 整類網路風險消失，而不是逐項加固（VPC endpoint 每個每月約 USD 7） |
| **帳號設定**（5 項，免費） | `SSM.7`（重大）、`EC2.7`、`IAM.7`、`Account.1`、`ECR.1` | SSM 文件公開分享 `Disable`；EBS 預設加密；IAM 密碼政策（14 字元、大小寫數字符號、重複使用 24、90 天）；安全聯絡人（`account put-alternate-contact`，個資不進 repo）；ECR **登錄檔層級** BASIC scan-on-push（repo 層級 API 已淘汰，CDK bootstrap 範本 v33 沒有開掃描，改 repo 會造成 `CDKToolkit` drift）→ `ECR.1` 通過 |
| **停用控制項**（2 項） | `Inspector.1`、`Inspector.2` | 沒有 EC2（COST-011、`scp-deny-expensive`）、沒有容器映像檔（Lambda 用 zip）；`batch-update-standards-control-associations` 附理由 |
| **SUPPRESSED**（6 項 7 筆，各附理由） | `CloudTrail.2`（ADR-014）、`CloudTrail.5`（成本）、`Cognito.4`（ADR-022，Plus）、`Cognito.5`（ADR-022，MFA OPTIONAL）、`CloudFormation.4`（只有 `CDKToolkit`）、`S3.9`（溯源 bucket；CDK assets bucket） | 理由**針對資源**而不是控制項：同一個 `S3.9` 的兩個 bucket 理由不同 |

- 教訓（2026-11-19）：批次隱藏時以為 `S3.9` 只有 1 筆，實際 2 筆（另一筆是 CDK assets bucket），迴圈把兩筆都套上溯源 bucket 的理由 → 逐筆列出資源後改正備註。批次修改後一定要列出**實際影響到的資源**。
- 教訓（2026-11-19）：`batch-update-findings` 回報 `UnprocessedFindings = 0` 後立刻讀回仍是舊備註；先確認 finding ID 只有 1 筆且正確，等 30 秒再讀就是新的 → **最終一致**，不需要重做寫入。
- CLI：`--note` 的文字含逗號時不可用簡寫語法（會被切成 list）→ 用 `jq -n` 產生 JSON。

---

## 10. CI/CD 基礎 / GitHub & CDK

### 10.1 GitHub

| 項目 | 值 |
|---|---|
| Repo | `chesteran321/brewline`（**公開**） |
| Ruleset `protect-main` | 預設分支；禁止刪除；必須 PR（核准數 0，單人無法自我核准）；禁止 force push；**required status check：`checks`**（`PR checks` workflow，2026-11-10 加入） |
| Environment `production` | Required reviewers：chesteran321；Prevent self-review 關；**不允許管理員繞過**；部署分支只有 `main` |
| Advanced Security | Dependency graph、Dependabot alerts、Dependabot security updates、Secret scanning、Push protection |
| Actions | Workflow permissions 預設**唯讀**；不允許 Actions 建立或核准 PR |
| Secrets | **不存任何 AWS 金鑰**（用 OIDC） |
| Dependabot version updates | `.github/dependabot.yml`：npm（`/infra/app`，CDK 相關套件分組）＋ github-actions；每週一（Asia/Taipei） |

### 10.2 OIDC 角色

OIDC provider：`token.actions.githubusercontent.com`，audience `sts.amazonaws.com`（Dev、Prod 各一個）。

| 帳號 | 角色 | 信任 `sub` | 權限 |
|---|---|---|---|
| Dev | `gha-deploy-dev` | `repo:chesteran321@219534971/brewline@1451431799:ref:refs/heads/main` | `sts:AssumeRole` on `cdk-hnb659fds-*` |
| Dev | `gha-readonly` | `repo:chesteran321@219534971/brewline@1451431799:pull_request` | `sts:AssumeRole` on `cdk-hnb659fds-lookup-role-*` |
| Prod | `gha-deploy-prod` | `repo:chesteran321@219534971/brewline@1451431799:environment:production` | `sts:AssumeRole` on `cdk-hnb659fds-*` |
| Prod | `gha-readonly` | `repo:chesteran321@219534971/brewline@1451431799:pull_request` | `sts:AssumeRole` on `cdk-hnb659fds-lookup-role-*` |

最長工作階段 1 小時。Workflow 需宣告 `permissions: id-token: write`。

**`sub` 格式（2026-11-10 實測修正）**：GitHub 簽發的 `sub` 含不可變的帳號 ID 與 repo ID：`repo:chesteran321@219534971/brewline@1451431799:<suffix>`。原本以舊格式 `repo:chesteran321/brewline:<suffix>` 建立的信任政策全部被拒（`AccessDenied`，CloudTrail `principalId` 可看到實際值），4 個角色已改用新格式。好處：repo 改名或被他人以同名重建時，信任政策不會誤放行。

### 10.3 CDK bootstrap

| 帳號 | 區域 | Stack | 終止保護 |
|---|---|---|---|
| Dev | ap-east-2、us-east-1 | `CDKToolkit` | ✅ |
| Prod | ap-east-2、us-east-1 | `CDKToolkit` | ✅ |

- Qualifier 預設 `hnb659fds`；每帳號 10 個 `cdk-hnb659fds-*` 角色。
- `cfn-exec-role` 使用預設 AdministratorAccess（ADR-016），仍受 SCP 限制。
- us-east-1 是為了 CloudFront ACM 憑證（edge-stack）。
- 執行時 CDK CLI 版本 2.1148.0。**本機與 CI 用 Node 24 LTS；Lambda 用 `Runtime.NODEJS_24_X`**（ADR-023，2026-11-12；原為 Node 22，nodejs22.x 於 2027-04-30 淘汰）。

### 10.4 CI/CD 管線 / Pipeline（P1，2026-11-10）

| Workflow | 觸發 | Job | OIDC 角色 | 做什麼 |
|---|---|---|---|---|
| `pr.yml`（PR checks） | PR → `main` | `checks` | `gha-readonly`（Dev） | typecheck → Jest → `cdk synth` dev/prod（cdk-nag）→ `cdk diff --no-change-set`（Dev），diff 寫入 Job Summary；fork PR 跳過 AWS 步驟 |
| `deploy.yml`（Deploy） | push → `main` | `Deploy Dev` | `gha-deploy-dev` → 驗證時 role chaining 至 `cdk-hnb659fds-lookup-role-*` | `cdk deploy`（明列 stack：pipeline-check、data）→ 驗證 SSM 值 = commit SHA → 以 lookup role（ReadOnlyAccess）執行 `scripts/verify-data-stack.sh`，結果寫入 Job Summary |
| | | `Deploy Prod`（`environment: production`，需核准） | `gha-deploy-prod` | 同上 |

| CDK app `infra/app` | 值 |
|---|---|
| 工具鏈 | TypeScript 7（`noEmit`）、tsx、Jest + swc、Node 24（`.nvmrc`，ADR-023） |
| 環境選擇 | `-c env=dev\|prod` **必填**，缺漏或拼錯 synth 失敗；帳號與 ap-east-2 寫在 `lib/config.ts` |
| cdk-nag | **v3**：`Validations.of(app).addPlugins(new AwsSolutionsChecks(app))`，違規 synth 失敗；例外用 `Validations.of(construct).acknowledge()`（v2 的 `NagSuppressions` 已移除） |
| 標籤 | `project`、`env`、`module`、`owner`；資料資源（DynamoDB、S3）另需 `data-class`（`public`／`internal`／`pii`）；`RequiredTagsChecker`（READONLY Aspect）缺標籤即報錯，**含 GlobalTable 的 `Replicas[].Tags`** |
| 資料保護 | `DataProtectionChecker`（READONLY Aspect）：DynamoDB 必須 PITR、SSE-KMS 客戶管理金鑰；Prod 必須刪除保護。補 cdk-nag DDB3 不檢查 `CfnGlobalTable` 的缺口 |
| 並行控制 | 每個環境一把鎖（`deploy-dev`、`deploy-prod`，PR #5）：Prod 等待核准時不擋後續 Dev 部署；不取消進行中的部署 |
| 測試 | 36 項（2026-11-11），含反向：不安全 S3 bucket、缺標籤、env 缺漏、PITR 關閉、DynamoDB owned／AWS managed key、Prod 無刪除保護、缺或無效 `data-class` |

| Stack | 帳號 | 資源 | 終止保護 | 首次部署 commit |
|---|---|---|---|---|
| `brewline-dev-pipeline-check` | Dev | SSM `/brewline/dev/pipeline-check`（Standard，免費），值 = 部署的 commit SHA | 否 | `237fb3d` ✅ |
| `brewline-prod-pipeline-check` | Prod | SSM `/brewline/prod/pipeline-check` | **是** | `237fb3d` ✅（核准後） |
| `brewline-dev-data` | Dev | KMS CMK、DynamoDB `brewline-dev-core`、3 個 SSM 參數（§10.5） | 否 | `31293f7` ✅（PR #6） |
| `brewline-prod-data` | Prod | KMS CMK、DynamoDB `brewline-prod-core`、3 個 SSM 參數（§10.5） | **是** | `31293f7` ✅（核准後） |

已驗證（正向＋反向）：
- PR：`gha-readonly` 成功扮演並跑 `cdk diff`；合併前 Dev 查無參數 → PR 無法部署。
- Dev：合併後自動部署，參數值 = `main` 的 commit。
- Prod：核准前查無 stack → 核准關卡有效；核准後參數值與 Dev 相同、終止保護 `true`。

教訓 / Lessons：
- `Deploy Dev` job **不可**宣告 `environment`，否則 `sub` 變成 `environment:...`，對不上 `gha-deploy-dev`。
- 唯讀角色跑 `cdk diff` 要加 `--no-change-set`（建立 change set 需要 deploy-role）。
- OIDC `AccessDenied` 時，CloudTrail `AssumeRoleWithWebIdentity` 事件的 `principalId` 會顯示 GitHub 實際送來的 `sub`（見 §10.2）。
- （2026-11-11）`gha-deploy-*` 可用 role chaining 扮演 CDK lookup role 做部署後驗證；`configure-aws-credentials` 需設 `role-chaining: true`、`role-skip-session-tagging: true`。不需修改任何 IAM。
- （2026-11-11）Annotation error 不會讓 `app.synth()` 丟例外；是 CDK CLI 看到 error 後 exit 1。Jest 測試要用 `Annotations.fromStack().findError()` 斷言。
- （2026-11-11）需要核准的舊部署要先 Reject，避免核准錯 commit（`29a2f75` 已 Reject）。
- （2026-11-12）Deploy job `timeout-minutes` 由 20 調為 **40**（PR #16）：新增 GSI 時驗證要等索引回填（見 §10.5）。
- （2026-11-12）Node 24 升級（PR #12，ADR-023）走完整條管線：CI `setup-node` 讀 `.nvmrc` → 24.22.2；Dev、Prod `brewline-*-data (no changes)`，驗證 11/11。

### 10.5 共用資料層 / Shared Data Layer（P1，2026-11-11，ADR-018）

| 項目 | Dev | Prod |
|---|---|---|
| Stack | `brewline-dev-data` | `brewline-prod-data`（終止保護） |
| KMS CMK alias | `alias/brewline-dev-data` | `alias/brewline-prod-data` |
| KMS key ID | `6819595c-cdc5-4a2c-8226-e9035d3f05ae` | `c288f7e2-e5df-4fb9-8f74-cc2076e6364d` |
| 輪替 | 365 天 | 365 天 |
| 金鑰等待期／刪除政策 | 7 天／Delete | 30 天／**Retain** |
| DynamoDB | `brewline-dev-core` | `brewline-prod-core` |
| CloudFormation 類型 | `AWS::DynamoDB::GlobalTable`（CDK `TableV2`，單一 replica ap-east-2） | 同左 |
| 鍵 | `pk`（S）／`sk`（S） | 同左 |
| Streams | `NEW_AND_OLD_IMAGES`（A3a，PR #27；stream 標籤 `2026-11-13T07:37:06.700`） | 同左（`2026-11-13T07:41:58.933`） |
| GSI | `gsi1`（多用途）：`gsi1pk`（S）／`gsi1sk`（S），projection ALL，sparse；max 50 RRU／25 WRU（與表相同） | 同左；max 200 RRU／100 WRU |
| 容量 | On-demand，max 50 RRU／25 WRU | On-demand，max 200 RRU／100 WRU |
| 加密 | SSE-KMS（上述 CMK） | 同左 |
| PITR | 35 天（ADR-019） | 35 天 |
| 刪除保護／刪除政策 | 否／Delete | **是／Retain** |
| TTL | `expires_at` | `expires_at` |
| 標籤 | `module=core`、`data-class=pii` | 同左 |
| SSM（Standard） | `/brewline/dev/data/{table-name,table-arn,kms-key-arn,table-stream-arn}` | `/brewline/prod/data/...` |

- Key policy 為 CDK 預設（`kms:*` 給帳號 root → 交由 IAM 決定）；RCP `EnforceOrgIdentities` 另限制只有組織內身分可用 `kms:*`。
- 其他 stack 一律由 SSM 參數取得名稱／ARN，不使用 CloudFormation Export。
- 加密為**表層級**；聯絡人欄位層級加密於訂貨模組（A2）決定。
- **Key policy（A4a，2026-11-16，PR #36，ADR-029）**：新增 `AllowAwsServicesToPublishToEncryptedTopics`：`cloudwatch`、`events`、`ses` 服務主體只有 `kms:Decrypt`、`kms:GenerateDataKey*`，條件 `StringEqualsIfExists aws:SourceAccount = <本帳號>`。RCP `EnforceOrgIdentities` 對 AWS 服務主體不生效（`aws:PrincipalIsAWSService`）。Dev／Prod `verify-data-stack.sh` 新增 4 項 ✅（含反向：沒有服務主體有 `kms:*`）。
- 費用：約 USD 1／月／帳號（KMS key）；DynamoDB 與 PITR 目前約 0。一年後第一次輪替每把 +USD 1／月（上限 USD 3／月）。

已驗證（2026-11-11，Deploy run #5，`scripts/verify-data-stack.sh`，身分 `cdk-hnb659fds-lookup-role-*`）：
- Dev、Prod 各 11 項全部 ✅：ACTIVE、SSE=KMS／ENABLED、SSE key = stack CMK、鍵 `pk`/`sk`、PITR ENABLED、TTL `expires_at`、KMS 輪替 True、SSM 表名正確；刪除保護與終止保護 Dev `false`、Prod `true`。
- 反向（本機）：Dev 關閉 PITR → `cdk synth` 輸出 `[DataProtection] ... must enable point-in-time recovery`，exit 1。
- 反向（Jest）：cdk-nag 單獨使用時**不會**擋下 TableV2 關閉 PITR（記錄缺口）；自訂檢查會擋。
- （2026-11-13，A3a）Streams：Dev、Prod 新增 5 項全部 ✅：enabled、`NEW_AND_OLD_IMAGES`、`ENABLED`、SSM = `LatestStreamArn`、**表的建立時間比 stream 早（沒有被取代）**；API smoke test 41/41 照常。
- ✅（2026-11-11 22:42，Prod Admin 主控台）Config 已將 `brewline-prod-core` 記錄為 `AWS::DynamoDB::Table`，合規狀態「合規」→ `TableV2`（GlobalTable）不影響 Config 記錄。
- ✅（2026-11-11 22:53，Security Hub CSPM 控制項頁）`DynamoDB.2`（PITR）通過、`DynamoDB.6`（刪除保護）通過，失敗的檢查皆 0／1。
- `KMS.4`（金鑰輪替）顯示「已停用」：它不屬於 FSBP（屬 CIS、NIST 等），Prod 只開 FSBP 所以不評估。輪替已由 cdk-nag `AwsSolutions-KMS5`（部署前）與驗證腳本 `KMS rotation = True`（部署後）確認，不另開標準。

GSI1（2026-11-12，訂貨 A1a，PR #13、#16）：
- 用途由值決定：商品目錄 `gsi1pk=CATALOG`／`gsi1sk=PRODUCT#<id>`（A1）；訂單狀態 `STATUS#<status>`／`<ts>`（A2）。
- 最大吞吐量**明確**設為與表相同：CDK `TableV2` 的 GSI 不設時 template 不帶上限（= 不受 COST-005 限制）。寫入上限放在 GlobalTable 頂層 `WriteOnDemandThroughputSettings`（全域），讀取上限在 `Replicas[].GlobalSecondaryIndexes[]`（每個 replica）。
- CI `cdk diff`：`[~] AWS::DynamoDB::GlobalTable`（`AttributeDefinitions` 加 `gsi1pk`／`gsi1sk`、`[+] GlobalSecondaryIndexes`、`Replicas` 加讀取上限），**無 replacement**。
- 已驗證：`verify-data-stack.sh` 新增 5 項 → Dev、Prod 各 **16 項全部 ✅**（GSI count 1、ACTIVE、鍵、ALL、寫入上限 Dev 25／Prod 100）。Prod 驗證時等了 29 × 15 秒（約 7 分鐘）索引才 ACTIVE。
- 手動（Dev，Developer 許可集）：正向 `query --index-name gsi1`（`gsi1pk=CATALOG`）→ `Count: 0`；反向 `--index-name gsi2` → `ValidationException: The table does not have the specified index`。Developer 的資料讀取權限涵蓋索引，不需修改許可集。

教訓 / Lessons：
- （2026-11-12）**`AWS::DynamoDB::GlobalTable` 在新 GSI 仍是 `CREATING`（`Backfilling=True`）時就回報 `UPDATE_COMPLETE`。** 第一次部署 #13 時驗證失敗（`GSI1 status = CREATING`），部署本身成功、Prod 因 Dev 失敗而未部署。實測空表：Dev CloudFormation 完成後約 8 分鐘、Prod 約 7 分鐘才 ACTIVE。修正：驗證腳本先輪詢等所有 GSI ACTIVE（每 15 秒、最多 20 分鐘，PR #16）。**DR 一次重建所有 stack 時，依賴 GSI 的步驟（例如 smoke test）要等索引 ACTIVE。**
- cdk-nag `AwsSolutions-DDB3` 只檢查 `CfnTable`；`TableV2` 產生 `CfnGlobalTable`，被視為不適用。
- `CfnGlobalTable` 不是 ITaggable（標籤在 `Replicas[].Tags`），只用 `TagManager.isTaggable()` 的檢查會默默跳過。
- CMK 加密的 `TableV2` 必須在有明確區域的 stack 中（測試的 Stack 也要給 `env`）。

### 10.6 身分層 / Identity Layer（P1，2026-11-13，ADR-022，PR #14、#20）

| 項目 | Dev | Prod |
|---|---|---|
| Stack | `brewline-dev-auth`（module `identity`） | `brewline-prod-auth`（**終止保護**） |
| User pool | `brewline-dev-users`，**Essentials** | `brewline-prod-users`，Essentials |
| 刪除保護／刪除政策 | INACTIVE／Delete | **ACTIVE／Retain** |
| 註冊 | 僅管理員建立（`AllowAdminCreateUserOnly`）；Email 登入 | 同左 |
| 密碼 | ≥ 12，大小寫、數字、符號；歷史 5 組 | 同左 |
| MFA | OPTIONAL，只開 TOTP；無 SMS 設定 | 同左 |
| 自訂屬性 | `custom:tenant_id`（String 1–64，mutable；**任何 app client 都不能寫**；不可刪除或改名） | 同左 |
| 群組 | `cafe`、`simulator`、`staff`、`simulator-roastery`（S2a） | 同左 |
| App client | `web`（SRP＋refresh、無 OAuth、token 撤銷、access／ID **15 分**（A2a，原 60 分）／refresh 7 天）；`smoke-test`（`ADMIN_USER_PASSWORD_AUTH`）；**`simulator`**（S1a，`ADMIN_USER_PASSWORD_AUTH`＋refresh、無 secret、15 分） | `web`、**`simulator`** |
| pre token 觸發器 | `brewline-dev-identity-pre-token`（V2_0，Node 24 arm64，保留併發 5，log 7 天） | `…-prod-…`（保留併發 10，log 30 天） |
| SSM | `/brewline/dev/auth/{user-pool-id,user-pool-arn,web-client-id,issuer,smoke-test-client-id,simulator-client-id}` | 除 `smoke-test-client-id` 以外 |

- Scope 對照（`services/identity/src/scopes.ts`）：`cafe`／`simulator` → `brewline/catalog.read`、`brewline/orders.read`、`brewline/orders.write`（訂單 scope 於 A2a 加入）；`staff` → `brewline/catalog.read`、`brewline/admin`、`brewline/roastery`（S2a；**沒有訂單 scope**：staff 不屬於任何租戶）；`simulator-roastery` → `brewline/catalog.read`、`brewline/roastery`＋`synthetic`（S2a，§10.17）。操作員群組（staff、simulator-roastery）與租戶群組同時存在、操作員群組超過一個、缺 tenant 或格式錯誤 → 不加任何 scope（fail closed）。
- **模擬器（S1a，ADR-030 D2／D6）**：pre token 觸發器在冷啟動時從 SSM 讀 `simulator-client-id`（用環境變數會造成 pool → 觸發器 → client → pool 的循環依賴），讀取失敗即登入失敗（fail closed，不快取失敗）。經由 `simulator` client 登入時，**只有 `simulator` 群組**拿得到 scope（其他 → `client-not-allowed`，無 scope）。`simulator` 群組的 access token 另有 `synthetic: "true"` claim（不論經由哪個 client）。觸發器角色只有該參數的 `ssm:GetParameter`。
- cdk-nag 例外：`AwsSolutions-COG2`（MFA 只能整個 pool 設定）、`AwsSolutions-COG8`（Plus 無免費額度）、`AwsSolutions-IAM5[Resource::*]`（X-Ray）。
- 費用：約 0（10,000 MAU 免費額度以 organization 計）。

已驗證（2026-11-13）：
- `scripts/verify-auth-stack.sh`：Dev、Prod 各 **25 項全部 ✅**（A2a 後 27 項，新增 access／ID token = `15 minutes`）；反向（`--no-sign-request`）：`sign-up` → `NotAuthorizedException`、`USER_PASSWORD_AUTH` → `InvalidParameterException`。
- 手動（Dev Admin）：cafe 帳號 access token `scope = aws.cognito.signin.user.admin brewline/catalog.read`、`tenant_id = t_…`；反向：同一帳號加入 `staff` → 重新登入後 scope 只剩 `aws.cognito.signin.user.admin`、`tenant_id = null`。測試帳號已刪除（`list-users` = 0）。
- 帳號層級：`UnreservedConcurrentExecutions` Dev 1000 → 995。

### 10.7 訂貨 API A1 / Ordering API A1（P1，2026-11-13，ADR-020、ADR-021，PR #15、#18）

| 項目 | Dev | Prod |
|---|---|---|
| Stack | `brewline-dev-api`（module `ordering`） | `brewline-prod-api`（**終止保護**） |
| HTTP API | `brewline-dev-api`，`$default` stage，無 CORS | `brewline-prod-api` |
| 限流 | 10／20 req/s | 50／100 req/s |
| Authorizer | Cognito JWT（issuer、audience 來自 SSM；audience 含 `web`＋`simulator`＋`smoke-test`） | audience `web`＋`simulator` |
| 路由 | `GET /products`、`GET /products/{id}`（`brewline/catalog.read`）；`GET /admin/products/{id}/stock`（`brewline/admin`） | 同左 |
| Lambda | `brewline-dev-ordering-{list-products,get-product,get-product-stock}`：Node 24 arm64、X-Ray、保留併發 5、log 7 天 | 保留併發 10、log 30 天 |
| Access log | `/aws/apigateway/brewline-dev-api`（JSON，不記錄 token／標頭／query） | 30 天 |
| 種子 | 8 個虛構商品（`services/ordering/seed/products.json`）；META 每次覆寫、STOCK 只寫一次 | 同左 |
| Smoke test | 每次部署執行（custom resource，失敗即 rollback）：**18 項** | 無 |

- IAM：每個函數一個角色；DynamoDB 以 `dynamodb:LeadingKeys` 限定 `PRODUCT#*`（GSI 查詢限定 `CATALOG`）；KMS 限 `kms:ViaService = dynamodb.ap-east-2.amazonaws.com`；**明確 Deny `dynamodb:Scan`**（表與 `/index/*`）；API Gateway 呼叫權限的 `SourceArn` 限定到單一路由。
- 新增 `ApiGuardrailsChecker`：每條路由 JWT＋至少一個 scope；每個 stage 必須有 access log 與限流。
- 合約：`api/openapi.yaml`。
- SSM `/brewline/<env>/api/endpoint`（S1a）：API 位址，給模擬器讀取。
- 費用：Dev 約 USD 0.2、Prod 約 USD 0.3／月（以 us-east-1 單價估算）。

已驗證（2026-11-13，`scripts/verify-api-stack.sh`）：
- Dev、Prod **全部 ✅**：路由、`Routes without JWT/scope = 0`、admin scope、issuer = user pool、audience 含 web、限流、access log、無 CORS、3 個 Lambda 的設定、種子 ≥ 8、終止保護。
- **Dev smoke test 18/18 passed**（兩次部署）：未登入 401；cafe 讀目錄 200 且 DTO 無內部欄位；staff 讀庫存 200；cafe、simulator 讀 admin → 403；cafe＋staff → 403；cafe ID token → 401/403；`p-9999` → 404；`DROP-TABLE` → 400；token claims。**GSI 上的 `LeadingKeys = CATALOG` 條件實際可用。**
- HTTP 反向：無 token、亂碼 token、**自簽 admin JWT** → 401；未定義路由與 `POST /products` → 404。
- 唯讀角色（ReadOnlyAccess）`get-item` 讀商品 → **denied**（表層 CMK：無 `kms:Decrypt`）。
- 帳號層級：`UnreservedConcurrentExecutions` Dev **978**、Prod **959**（與保留併發合計一致）。

教訓 / Lessons：
- （2026-11-13）新帳號 Lambda 併發配額只有 **10**，任何保留併發都會讓部署失敗 → 先 `get-account-settings` 確認；申請轉 Support 案件，隔夜核准（§13、§14）。
- （2026-11-13）`apigatewayv2 get-stage` 的 `ThrottlingRateLimit` 是浮點數（`10.0`），字串比對失敗 → jq `floor` 後再比（PR #18）。**部署本身與 smoke test 全部通過**，Prod 因 Dev 失敗而延後一次部署。
- （2026-11-13）驗證步驟原本在失敗時不會寫入 Job Summary（`-e -o pipefail` 跳過後續指令）→ 改為 `set +e`、`PIPESTATUS[0]`，先寫 summary 再 `exit $rc`（6 個驗證步驟）。
- `cdk diff` 對含中文的 Cognito 邀請信會顯示 `Omitted … mangled non-ASCII characters`，實際內容未變。

---

### 10.8 租戶存取角色 / Tenant Access Role（P1，2026-11-13，ADR-024，PR #20、#21）

| 項目 | Dev | Prod |
|---|---|---|
| 角色 | `brewline-dev-tenant-access`（api stack，output `TenantAccessRoleArn`） | `brewline-prod-tenant-access` |
| 信任 | 呼叫端 `aws:PrincipalArn` = `arn:aws:iam::<帳號>:role/brewline-<env>-orders-*`；`aws:RequestTag/tenant_id` = `t_` ＋ 26 個 `?`；`aws:TagKeys` 只能是 `tenant_id`；動作 `sts:AssumeRole`＋`sts:TagSession`；最長 1 小時 | 同左 |
| 自己的租戶 | `GetItem`／`Query`／`PutItem`／`ConditionCheckItem`，`LeadingKeys` **完全等於** `TENANT#${aws:PrincipalTag/tenant_id}` | 同左 |
| 商品 | 讀 `PRODUCT#*`；`UpdateItem` 只能動 `pk, sk, available_kg, reserved_kg, version, updated_at`，`ReturnValues` 不可為 `ALL_*` | 同左 |
| 其他 | 明確 Deny `Scan`（表＋索引）；KMS 限 `kms:ViaService`；沒有 `DeleteItem` | 同左 |

- 目前沒有任何呼叫端（A2b 的訂單函數才會使用）。費用 0。
- 修正 v0.1 03 §5：`TENANT#${tag}*` 的前綴比對 → `StringEquals` 完全比對＋信任政策限制 tag 長度。

已驗證（2026-11-13，`scripts/verify-tenant-access.sh`，CI lookup role）：
- Dev、Prod 各 **19 項全部 ✅**：6 項設定＋13 項 `simulate-principal-policy`。
  - allowed：讀／寫自己的訂單、讀商品、只動庫存欄位扣庫存。
  - implicitDeny：讀 B 的訂單、寫進 B、前綴攻擊（tag `t_1` → `TENANT#t_1…`）、沒有 session tag、改價格、扣庫存但 `ReturnValues=ALL_NEW`、新增商品、刪除自己的訂單。
  - explicitDeny：`Scan`。
- `cdk-hnb659fds-lookup-role`（ReadOnlyAccess）可以執行 `iam:SimulatePrincipalPolicy`。
- 手動反向（Dev，SSO Admin，帶 `tenant_id` tag 呼叫 `sts assume-role`）→ **`AccessDenied ... not authorized to perform: sts:TagSession`**：Admin 的身分政策允許，但信任政策的 `aws:PrincipalArn` 不符。帶 tag 的請求會同時檢查 `AssumeRole` 與 `TagSession`，錯誤訊息顯示其中一個被拒的動作。

教訓 / Lessons：
- （2026-11-13）IAM `get-role` 會把**只有一個值的條件陣列**回傳成字串（部署 `["tenant_id"]` → 讀回 `"tenant_id"`），驗證腳本誤判失敗、Prod 延後一次 → jq `[.] | flatten` 正規化後比對（PR #21）。

### 10.9 訂單 API / Orders API（P1，2026-11-13，ADR-025、ADR-027，PR #23、#25、#31）

| 項目 | Dev | Prod |
|---|---|---|
| 路由 | `POST /orders`（`brewline/orders.write`，必填 `Idempotency-Key`）、`GET /orders`、`GET /orders/{id}`（`brewline/orders.read`） | 同左 |
| `POST /orders` 路由限流 | 2／5 req/s（stage `RouteSettings`） | 10／20 req/s |
| Lambda | `brewline-dev-ordering-{create-order,list-orders,get-order}`，保留併發 5 | 保留併發 10 |
| 函數角色 | `brewline-dev-orders-{create,list,get}`：**沒有任何 DynamoDB／KMS 權限**，只能 `sts:AssumeRole`＋`sts:TagSession` 租戶角色（§10.8） | 同左 |
| 交易 | 一個 `TransactWriteItems`：`IDEMP#<key>`（TTL 24h）＋`ORDER#<ULID>`＋每個商品扣 `STOCK`；伺服器端定價（價格快照）；`PAID_MOCK` | 同左 |
| 輸入上限 | 每筆 ≤ 25 個商品、每個 1–500 kg、商品不重複、body ≤ 16 KB | 同左 |
| 測試商品 | `p-9001`（併發，10 kg）、`p-9002`（smoke，每次重設 100 kg）；**不設 `gsi1pk`** → 不在目錄 | 無 |
| Smoke test | **57 項**（A1 18＋訂單 23＋staff 16） | 無 |
| staff 端點（A3c） | `GET /admin/orders?status=`、`GET`／`PATCH /admin/tenants/{tenantId}/orders/{orderId}`（`brewline/admin`）；函數 `brewline-dev-ordering-admin-{list-orders,get-order,update-order}`，角色由 CloudFormation 命名（**不能**扮演租戶角色）；只能 Query GSI1 `STATUS#*`、Get／Update `TENANT#*`、商品只改庫存欄位；無 Put／Delete／Batch | 同左，保留併發 10 |
| 狀態機 | `CREATED → CONFIRMED → ROASTING_SCHEDULED → ROASTED → SHIPPED → COMPLETED`；`CREATED`／`CONFIRMED → CANCELLED`；一個交易＝訂單（條件：原狀態）＋庫存（SHIPPED 消耗、CANCELLED 釋放，`reserved >= q`） | 同左 |
| 訂單測試（手動） | `brewline-dev-ordering-order-tests`（角色 `brewline-dev-orders-tests`，保留併發 1）；`infra/app/scripts/run-order-tests.sh`；夾具權限只限 `PRODUCT#p-9001` 與兩個 `TENANT#t_01CNCRTST…` | 無 |

- **`synthetic`（S1a，ADR-030 D6）**：`create-order` 只依已驗證 JWT 的 `synthetic` claim（值必須是字串 `"true"`）在訂單項目寫入 `synthetic: true`；body 帶 `synthetic` → 400（不信任用戶端）。staff DTO 有 `synthetic`（true／false），咖啡廳的 DTO 沒有；`OrderCreated`／`OrderStatusChanged` 的 detail 只在模擬訂單帶 `synthetic: true`。補貨執行函數下的單不標記（S1 模擬器不建補貨）。
- 回應：201 建立；200 同一個 key 重送（回原訂單）；422 同一個 key 不同內容；409 庫存不足（什麼都沒扣）；400 輸入錯誤／商品不存在；503 交易衝突或 throttle（同一個 key 重試）；別的租戶的訂單 → 404。
- 費用：STS 免費；每筆訂單 6–54 WRU；smoke test 規模每月 < USD 0.1。帳號保留併發：Dev 新增 15、Prod 新增 30。

已驗證（2026-11-13，commit `75ac24b`）：
- **Dev smoke test 41/41 passed**：
  - 正向：下單 201（`CREATED`／`PAID_MOCK`，金額 = 價格 × 數量）、重送 200 同一個 `order_id`、simulator 下單、列表與明細。
  - 反向：沒 token 401、缺 key 400、數量 0 → 400、26 個商品 → 400、不存在的商品 400；同 key 不同內容 422；500 kg → 409 且**庫存仍為 97／3**；staff 下單與查詢 403；ID token 被拒；**租戶 B 讀 A 的訂單 404、B 的列表為空**。
- `verify-api-stack.sh` Dev、Prod 全部 ✅：6 條路由、訂單 scope、路由限流（Dev 2／5、Prod 10／20）、6 個函數設定；HTTP 反向 `POST /orders`、`GET /orders` 沒 token、`POST /orders` 偽造 JWT → 401。
- `verify-tenant-access.sh` Dev、Prod 各 **37 項全部 ✅**：原 19 項＋3 個呼叫端角色 × 6 項（存在、沒有 managed policy、**DynamoDB／KMS Allow = []**、`AssumeRole`／`TagSession` 租戶角色 allowed、直接讀表 implicitDeny）。
- **Dev 訂單測試 17/17 passed**（2026-11-13，Developer 權限集 `lambda invoke`）：
  - 冪等風暴：同一個 key 同時 10 次 → `created 1`、`replayed 9`，資料表 1 筆訂單，只扣 1 kg。**03 §11「重送 10 次只產生 1 筆」達成。**
  - 搶庫存：100 個請求搶 10 kg（約 4.1 秒）→ `created 10`、`insufficient_stock 58`、`busy 32`；`available 0`、`reserved 1 → 11`，資料表 10 筆訂單。**03 §11「100 個並發搶最後 10 kg 不超賣」達成。**
  - IAM 探測（租戶 A 的真實臨時憑證）：讀自己的訂單成功；讀 B、Query B、寫進 B、改價格、Query GSI1、Scan、刪除自己的訂單 → 全部 `AccessDeniedException`。**ORD-N-001「跨租戶存取 100% 失敗」在資料層達成。**
  - 清理 22 個項目（11 筆訂單＋11 筆冪等記錄）。

- **A3c（2026-11-13，commit `3692008`）**：Dev smoke **57/57**：staff 依序推進到 `COMPLETED`、出貨後庫存 **95／2**、取消後釋放回 **97／0**；反向：cafe PATCH 403、無 token 401、未知狀態 400、跳級 409（附 allowed）、錯誤租戶 404、排程烘焙後取消 409、**重複取消 409 且庫存不變**；咖啡廳看到 5 筆 `status_history`、**不含 `by`**。`verify-api-stack.sh` Dev／Prod：9 條路由、3 個 admin scope、9 個函數、偽造 admin JWT 的 PATCH 401。Events（Dev）：`OrderStatusChanged → COMPLETED` 已寫入 log。

教訓 / Lessons：
- （2026-11-13）搶庫存時 32 筆是 `busy`（`TransactionConflict` 重試 3 次後放棄）而不是 throttle：多個交易同時更新**同一個 STOCK 項目**，DynamoDB 直接取消衝突的交易，不會排隊等待。對 client 而言是 503，用同一個 Idempotency-Key 重試即可。熱門商品的單一庫存項目是寫入熱點（hot key）；正式流量若需要更高併發，可考慮庫存分片或佇列化下單（A3 之後評估）。
- （2026-11-13）`CfnStage.routeSettings` 是 Json 型別，CDK 不會把 camelCase 轉成 PascalCase → 必須直接寫 `ThrottlingRateLimit`；單元測試在部署前發現。route key 必須先存在 → stage 依賴路由。

### 10.10 事件層 / Event Layer（P1，2026-11-13，ADR-026，PR #28、#29）

| 項目 | Dev | Prod |
|---|---|---|
| Stack | `brewline-dev-events`（module `events`） | `brewline-prod-events`（**終止保護**） |
| Bus | `brewline-dev`（SSM `/brewline/dev/events/{bus-name,bus-arn}`） | `brewline-prod` |
| 發布函數 | `brewline-dev-events-stream-publisher`：Node 24 arm64、X-Ray、保留併發 2；只有讀 stream、`kms:Decrypt`（ViaService DynamoDB）、`events:PutEvents`（此 bus）、送 DLQ | 同左 |
| 事件來源對應 | `LATEST`、batch 25、過濾（`entity=Order`；`sk=STOCK` 的 MODIFY）、`ReportBatchItemFailures`、bisect、重試 3、最長 1 小時、失敗 → `brewline-dev-events-stream-dlq` | 同左 |
| 事件 | `source=brewline.ordering`：`OrderCreated`、`OrderStatusChanged`、`StockLow`；detail 白名單、`event_id` = stream eventID | 同左 |
| 稽核 log | 規則 `brewline-dev-audit-log`（`brewline.*`）→ `/aws/events/brewline-dev`（7 天）；原生 `AWS::Logs::ResourcePolicy`，`aws:SourceArn` = 規則 | 30 天 |
| DLQ | `events-stream-dlq`、`events-rule-dlq`：SSE-SQS、僅 TLS、14 天 | 同左 |
| 告警（無通知目標，A4 接上） | `…-events-stream-iterator-age`（> 5 分）、`…-events-stream-dlq-not-empty`、`…-events-rule-dlq-not-empty` | 同左 |
| Bus 資源政策（RSK-017，S0） | `AWS::Events::EventBusPolicy`：**Deny** `events:PutEvents`，`Principal *`，`ArnNotLike aws:PrincipalArn` 白名單＝發布函數角色、`brewline-dev-orders-replenish`、`brewline-dev-orders-tests`（只有 Dev）、SSO `AWSReservedSSO_Admin_*`；沒有任何 Allow（不開放跨帳號） | 同左（無 `orders-tests`） |

- 部署順序 data → events → api（api 依賴 events，Dev smoke test 下的單才會產生事件）。
- **Bus 資源政策（2026-11-17，S0，PR #52，commit `1f0085c`）**：同帳號內身分政策的 Allow 就能發布，資源政策的明確 Deny 會蓋過它 → 即使之後某個角色被誤給 `events:PutEvents`，也無法偽造 `brewline.*` 事件。白名單用**固定角色名稱**（補貨、測試角色在之後部署的 api stack）；新增發布者時要同時改 `EventsStack.publisherRoleNames()`，否則新函數 `PutEvents` 會收到 `AccessDeniedException`（explicit deny in a resource-based policy）。SSO Admin 保留，供手動測試與事故處理。
- 費用：Lambda 觸發器讀 Streams 免費；自訂事件 USD 1／百萬；其餘在免費額度內 → 約 0。

已驗證（2026-11-17，S0）：
- CI `cdk diff`：只有 `[+] AWS::Events::EventBusPolicy`，bus **無 replacement**（政策是獨立資源）。
- `verify-events-stack.sh` 新增 5 項：Dev、Prod 全部 ✅：Deny 敘述 `cdk-DenyPutEventsExceptKnownPublishers`、Principal `*`、白名單＝實際的發布函數角色 ARN（含 CloudFormation 後綴）＋`orders-replenish`＋SSO Admin（Dev 另有 `orders-tests`；Prod 3 個，無 `orders-tests`）、Allow = 0、沒有 `orders-*`。
- Dev smoke test **78/78**；政策生效後 smoke 訂單仍產生 `OrderCreated`、`OrderStatusChanged → COMPLETED` → 發布函數沒有被誤擋。
- **反向（真實憑證）**：管理帳號 Admin 扮演 Dev `OrganizationAccountAccessRole`（AdministratorAccess）→ `put-events` → `AccessDeniedException … with an explicit deny in a resource-based policy`。
- **正向**：Dev SSO Admin `put-events`（`source=brewline.verify`、`BusPolicyProbe`）→ `FailedEntryCount: 0`，稽核 log 查得到。
- 附帶：Dev 自己的 SSO Admin 扮演 `OrganizationAccountAccessRole` → `AccessDenied … sts:AssumeRole`（信任政策只信任管理帳號，§1 設計如預期）。

已驗證（2026-11-13，`scripts/verify-events-stack.sh`，commit `55c4799`）：
- Dev 28 項、Prod 26 項全部 ✅：bus、SSM、對應 `Enabled`／來源 = SSM stream ARN／部分失敗／重試 3／bisect／on-failure DLQ／2 個過濾、函數設定、規則與 pattern、log 保留、DLQ SSE-SQS 且 0 則訊息、3 個告警且無 ALARM、終止保護。
- **端到端（Dev）**：smoke test 下單 → Streams → 發布函數 → bus → 規則 → Logs，最近 1 小時找到 smoke 租戶 A 的 `OrderCreated`（2 筆）。
- 反向：事件 log 中 `created_by`、`idempotency_key`、`TENANT#` 出現次數 = 0（Dev、Prod）。

教訓 / Lessons：
- （2026-11-13）`targets.CloudWatchLogGroup` 會部署一個 AwsCustomResource Lambda 寫 log 資源政策（不符 Lambda 標準）→ 改用原生 `AWS::Logs::ResourcePolicy`。
- （2026-11-13）`aws logs filter-log-events` 自動分頁，`--query` 逐頁套用：`length(events)` 印出 `2⏎0` → 驗證誤判、Prod 延後一次 → 改列 `eventId` 再 `wc -w`（PR #29）。同次另修正 DLQ ARN 的 regex。

### 10.11 逾時取消工作流 / Order Timeout Workflow（P1，2026-11-13～16，ADR-028，PR #33、#34）

| 項目 | Dev | Prod |
|---|---|---|
| 規則 | `brewline-dev-order-timeout`（bus `brewline-dev`，`source=brewline.ordering`、`OrderCreated`）；input 只有 `tenant_id`、`order_id`、`event_id`；DLQ `brewline-dev-order-timeout-dlq`（SSE-SQS），重試 3 次、最長 2 小時 | 同左 |
| 狀態機 | `brewline-dev-order-lifecycle`（**Standard**）：`WaitForConfirmation` **600 秒** → `CancelIfStillCreated` → `Done`；`RetryableError` 重試 3 次（10 秒起、×2）；其他錯誤 → `CancelFailed`；X-Ray；log ALL、不含執行資料；整體逾時 = 等待 + 1 小時 | 等待 **172800 秒（48 小時）** |
| 取消函數 | `brewline-dev-ordering-order-timeout`：重用 `AdminOrderRepo.transition`（`onlyFrom: CREATED`、`actor: system:timeout`）；角色由 CloudFormation 命名（不扮演租戶角色）；Get／Update `TENANT#*`、商品只改庫存欄位；無 Put／Delete／Query | 同左 |
| 告警（無通知目標） | `brewline-dev-order-lifecycle-failed`、`brewline-dev-order-timeout-dlq-not-empty` | 同左 |

- **冪等靠條件寫入，不靠執行名稱**：EventBridge 的 Step Functions 目標無法指定執行名稱（實際執行名稱為 EventBridge 產生的 UUID）。
- 費用：Standard 每筆訂單約 4 次轉換（每月 4,000 次免費），`Wait` 期間不計費 → 約 0。

已驗證：
- CI（`verify-api-stack.sh`，PR #33 部署）：工作流類型、等待秒數、重試、logging、tracing、規則、DLQ 為空、24 小時內沒有 FAILED 的執行；Dev 有 smoke 訂單啟動的執行。
- **端到端（Dev，2026-11-16，`order-tests` 的 `timeout-setup`／`timeout-check`）**：測試租戶 B 建立 X、Y，確認 Y（庫存 8／2）→ 10 分鐘後 **X = `CANCELLED`（`system:timeout`）、Y 仍是 `CONFIRMED`、庫存 9／1**，`passed: true`。
- 附帶驗證（第一次嘗試）：工作流在建立後**剛好 10 分鐘**（01:39:56 → 01:49:58 UTC）執行；訂單已被刪除時回報 `not_found`，執行 `SUCCEEDED`，沒有失敗或重試。

教訓 / Lessons：
- （2026-11-16）第一次端到端測試時，`timeout-check` 在 setup 後 1 分鐘就被執行，失敗後在 `finally` **刪除了測試資料** → 真正的檢查讀不到資料。修正（PR #34）：逾時前執行回報 `too_early`、資料不存在回報 `data_missing`，兩種情況都不寫入；**只有全部通過才清理**，失敗時保留資料。原則：測試的清理不要放在 `finally`。

### 10.12 維運通知 / Ops Notifications（P1，2026-11-16，ADR-029，PR #37）

| 項目 | Dev | Prod |
|---|---|---|
| Stack | `brewline-dev-ops`（module `ops`） | `brewline-prod-ops`（**終止保護**） |
| 主題 | `brewline-dev-ops-alerts`：CMK 加密（A4a key policy）、僅 TLS、只有本帳號 `cloudwatch`／`events` 可 `sns:Publish`；SSM `/brewline/dev/ops/alerts-topic-arn` | `brewline-prod-ops-alerts` |
| 告警 | 5 個（events 3、workflow 2）的 ALARM 與 OK 都通知主題（`notifyAlarms()`） | 同左 |
| StockLow | 規則 `brewline-dev-stock-low` → 主題（input transformer 產生可讀訊息；DLQ 為 events-rule-dlq） | 同左 |
| 訂閱 | Email 1 筆，**手動** CLI 訂閱並確認（2026-11-16）；Email 不在 repo／CI summary | 同左 |
| 部署順序 | data → auth → **ops** → events → api | 同左 |

已驗證（2026-11-16）：
- CI `verify-ops-stack.sh`（Dev、Prod）：主題 KMS = 帳號 CMK、TLS deny、發布者與 SourceAccount、**5 個告警都接上（ALARM＋OK）**、StockLow 規則目標、終止保護；反向：沒有公開 Allow。
- **端到端（Dev）**：`set-alarm-state ALARM` → 告警歷程 `Successfully executed action …ops-alerts`（ALARM 與 OK 各一次）→ 收到 ALARM 與 OK 兩封信；`put-events` 測試的 `StockLow` → 收到 `Stock low: p-9002 …` 信；規則 DLQ = 0。

教訓 / Lessons：
- （2026-11-16）SNS「發布成功」≠「送達」：訂閱在 `PendingConfirmation` 時發布照樣成功，但不會寄信、也不會補寄。排查順序：告警歷程（有沒有發布）→ 訂閱狀態（有沒有人收）。
- （2026-11-16）多帳號 CLI：在 Prod 帳號設了 `ENV=dev` → 改由帳號 ID 推算環境；`--notification-endpoint "$EMAIL"文字` 會黏成一個參數 → 固定值直接用單引號。
- 已知風險：任何有 `events:PutEvents` 的同帳號身分都能偽造 `brewline.ordering` 事件（測試 B 即是）。之後以 bus 資源政策限定發布者（RSK-017）。

### 10.13 租戶聯絡人與欄位層級加密 / Tenant Contact & Field-Level Encryption（P1，2026-11-16，ADR-029 D2／D4，PR #39）

| 項目 | Dev | Prod |
|---|---|---|
| 路由 | `GET`／`PUT /tenant/contact`（`brewline/profile.read`／`profile.write`，**只有 cafe**） | 同左 |
| 函數 | `brewline-dev-ordering-{get,put}-contact`；角色 `brewline-dev-orders-contact-{get,put}`（沒有 DynamoDB／KMS 權限，只能扮演租戶角色） | 同左（prod） |
| 資料 | `TENANT#<t>`／`CONTACT#primary`：`enc.{name,email,phone,address}` 為 KMS 密文（base64），沒有明文欄位；Streams 事件過濾不處理此項目 | 同左 |
| KMS | 資料層 CMK，直接 `Encrypt`／`Decrypt`（每欄 ≤ 4 KB）；encryption context `{tenant_id, field}` | 同左 |
| 租戶角色 | Sid `ContactFieldsOwnTenant`：context `tenant_id` = `${aws:PrincipalTag/tenant_id}`、`field` ∈ 4 欄、context 鍵只能是 `tenant_id`／`field`、`SYMMETRIC_DEFAULT`；沒有直接 `GenerateDataKey` | 同左 |

已驗證（2026-11-16）：
- **Dev smoke test 68/68**（新增：PUT→GET 往返；B 讀 A → 404；simulator → 403；staff PUT → 403；email 無效 → 400；body 帶 `tenant_id` → 400；**DynamoDB 項目找不到 email／姓名／電話明文**；token scope）。
- CI `verify-tenant-access.sh`（Dev、Prod）：9 個 KMS 政策模擬（2 allowed、7 implicitDeny），5 個訂單／聯絡人函數角色 `→ key directly = implicitDeny`；`verify-api-stack.sh`：11 條路由、11 個函數。
- **Dev `run-order-tests.sh` 25/25**：新增 8 個 KMS 探測，以租戶 A 的**真實憑證**呼叫 KMS（經 key policy、SCP、RCP 實際評估）：自己的 context 加解密成功；B 的 context、多餘的鍵、未知欄位、沒有 context、直接 `GenerateDataKey` → `AccessDeniedException`。

教訓 / Lessons：
- （2026-11-16）CloudShell 的 `AWS_REGION` 跟著主控台右上角的區域；在東京區域開 CloudShell 時，腳本的 `${AWS_REGION:-ap-east-2}` 會用東京 → 先 `export AWS_REGION=ap-east-2` 或切換主控台區域。
- 政策模擬（`simulate-principal-policy`）只算身分政策；真實憑證探測才涵蓋 key policy／SCP／RCP，兩者互補。

### 10.14 訂單通知信 / Order E-mail（P1，2026-11-16，ADR-029 D1／D5，PR #41、#42、#43）

| 項目 | Dev | Prod |
|---|---|---|
| 網域 | `dev.brewline-demo.click`（Dev 帳號 zone `Z00697733VLK1TK9WUYKL`，CDK 建立、Retain） | `brewline-demo.click`（Route 53 註冊：1 年、自動續約、隱私保護，到期 2027-11-16；zone `Z039360620HRFCTYO5R5J`） |
| 委派 | — | NS `dev.brewline-demo.click` → Dev zone 4 個名稱伺服器（config `mail.delegations`，ADR-029 E2 兩階段） |
| Stack | `brewline-dev-notify`（module `notifications`） | `brewline-prod-notify`（**終止保護**） |
| SES 身分 | 網域、Easy DKIM 2048、MAIL FROM `mail.<網域>`（MX 失敗拒寄）；DMARC `p=quarantine; adkim=s; aspf=r` | 同左 |
| Configuration set | `brewline-<env>-mail`：TLS REQUIRE、抑制 bounce／complaint；bounce／complaint／reject／rendering failure／delivery delay → `ops-alerts` | 同左 |
| 通知函數 | `brewline-dev-notifications-order-notifier`，角色 `brewline-dev-orders-notify`（扮演租戶角色讀聯絡人＋KMS 解密；本身無 DynamoDB／KMS 權限）；`ses:SendEmail` 以 `ses:FromAddress` 鎖定；保留併發 1；非同步重試 2 次 → `notify-dlq`（告警） | 同左 |
| 規則 | `mail-order-created`（`OrderCreated`）、`mail-order-status`（`status ∈ CONFIRMED/SHIPPED/CANCELLED`） | 同左 |
| 沙盒 | 是；收件信箱手動驗證（Dev、Prod 各一次，不進 repo） | 是 |

已驗證（2026-11-16）：
- CI `verify-notify-stack.sh`：Prod DKIM／MAIL FROM `SUCCESS`、Verified for sending、公開 DNS 查得到 DMARC、`dev.` 委派記錄存在；Dev 在委派後 MAIL FROM 先 `SUCCESS`、DKIM 約 25 分鐘後 `SUCCESS`。
- 手動：`dig` NS／DKIM CNAME（`…dkim.ap-east-2.amazonses.com`）查得到；收件信箱驗證前 `VerifiedForSendingStatus = false`、點連結後 `true`；格式錯誤的地址 → `BadRequestException`。
- **端到端（Dev，`order-tests` 模式 `notify-setup`＋`timeout-check`）**：測試租戶 B 寫入聯絡人並下 2 筆單 → 收到 **4 封信**（已建立 ×2、已確認 ×1、10 分鐘後已取消 ×1，寄件人 `BrewLine (Demo) <orders@dev.brewline-demo.click>`）；逾時檢查 4/4（`system:timeout` 取消、已確認訂單不變、庫存 9/1），測試資料自動清除。
- **Gmail「顯示原始郵件」（已確認通知信）**：SPF `PASS`、DKIM `'PASS'`（網域 `dev.brewline-demo.click`）、DMARC `'PASS'`；傳輸 2 秒；Message-ID 網域 `ap-east-2.amazonses.com`。

教訓 / Lessons：
- （2026-11-16）**Lambda 節流變成工作流失敗**：訂單測試一次建立 11 筆訂單，10 分鐘後逾時工作流同時到期；取消函數保留併發 2 → 7 筆 `Lambda.TooManyRequestsException`，CDK `retryOnServiceExceptions` 不含此錯誤 → 被 `Catch States.ALL` 變成 FAILED（訂單已刪除，無資料影響）。修正：對它重試 6 次＋full jitter（PR #42）。查證據用 `get-execution-history`；這種整合的事件是 `LambdaFunctionFailed`，不是 `TaskFailed`。
- （2026-11-16）**CI 驗證範圍**：「24 小時內 FAILED = 0」會讓一次事件卡住之後 24 小時的每次部署 → 改為「這次部署之後」判定，24 小時只顯示；部署之間由告警負責。
- （2026-11-16）**唯讀驗證角色讀不到 Lambda 環境變數值**（null）→ 驗證真正的控管（IAM `ses:FromAddress` 條件），環境變數交給單元測試（PR #43）。
- （2026-11-16）DMARC：MAIL FROM 用子網域時要 `aspf=r`，`aspf=s` 會讓 SPF 永遠不一致。
- （2026-11-16）SES DKIM：身分先建立、DNS 後補 → 首次檢查失敗後重試間隔拉長（Dev 約 25 分鐘）；建議先準備 DNS。
- （2026-11-16）CloudShell：互動式 `read` 時剪貼簿的指令被貼進變數 → 用 `echo "[$VAR]"` 檢查；憑證服務偶爾回 500 → 重新整理或重新登入。

### 10.15 定期補貨 / Recurring Replenishment（P1，2026-11-16，ADR-029 D6，PR #46、#47）

| 項目 | Dev | Prod |
|---|---|---|
| 路由 | `POST`／`GET /replenishments`、`DELETE /replenishments/{id}`（`orders.write`／`orders.read`） | 同左 |
| 資料 | `TENANT#<t>`／`REPL#<ULID>`（正本）；刪除＝軟刪除（`status=deleted`＋TTL 30 天） | 同左 |
| 排程 | 群組 `brewline-dev-replenish`；排程 `<tenant_id>-<replenishment_id>`，`Asia/Taipei` 09:00，`FlexibleTimeWindow OFF`，重試 2 次＋DLQ | `brewline-prod-replenish` |
| Scheduler 角色 | `brewline-dev-replenish-scheduler`：信任 `scheduler.amazonaws.com`，`aws:SourceAccount`＋`aws:SourceArn = schedule-group/brewline-dev-replenish`；只能 invoke 執行函數、寫 DLQ | 同左（prod） |
| 函數 | API：角色 `orders-repl-{create,list,delete}`；執行：`brewline-dev-ordering-replenish`（角色 `orders-replenish`，`events:PutEvents` 只限 `ReplenishmentFailed`）；全部經租戶角色存取資料 | 同左 |
| 告警 | `brewline-dev-replenish-dlq-not-empty` → `ops-alerts`（告警總數 7） | 同左 |

已驗證（2026-11-16）：
- **Dev smoke test 78/78**（新增 10 項：建立 201、排程存在且 `Asia/Taipei`／`cron(0 9 ? * MON *)`、列出、31 日 → 400、未知商品 → 400、staff → 403、B 看不到也刪不掉 A 的、第 6 筆 → 409、刪除後排程與項目都消失）。
- CI（Dev、Prod）：14 條路由／14 個函數、排程群組 ACTIVE、Scheduler 角色信任、執行函數 DLQ、排程名稱格式、4 個新呼叫端角色只能經租戶角色、`mail-replenish-failed` 規則。
- CloudTrail：修正前 6 次 `CreateSchedule` 全為 `ValidationException`，修正後全為成功。
- **Dev `order-tests replenish-check` 10/10**（模擬觸發，租戶 B 真實憑證）：觸發下單、重送回同一張訂單（冪等）、庫存只預留一次（8/2）、已刪除與雙週休息週不下單、庫存不足 → `ReplenishmentFailed` 一次且不預留；`cleanup` 清除 9 個項目（含 3 筆 `NOTIFY#` 寄送記錄）。收到 3 封信：訂單已建立、**定期補貨未下單**（庫存不足）、訂單已取消（逾時）。

教訓 / Lessons：
- （2026-11-16）**Scheduler 執行角色的 `aws:SourceArn` 必須是排程群組 ARN**（`schedule-group/<group>`），寫成 `schedule/<group>/*` 時 `CreateSchedule` 一律 `ValidationException: The execution role you provide must allow AWS EventBridge Scheduler to assume the role`。單元測試只比對自己寫的值，抓不到；Dev smoke test 失敗即 rollback 擋下，CloudTrail 提供確切錯誤（rollback 後函數日誌已隨 log group 刪除，CloudTrail 仍在）。
- （2026-11-16）先查證據再修：第一個推測（IAM 傳播延遲）是錯的；若照推測加重試，只會讓每次失敗多等幾秒。
- （2026-11-16）`aws lambda invoke` 只要呼叫成功就回 0；函數錯誤在輸出檔 → 加 `--query FunctionError`。
- （2026-11-16）CloudShell `read` 與下一行一起貼上會把下一行讀進變數（今天 2 次）→ 個人環境直接賦值，並 `echo "[$VAR]"` 確認；測試函數的錯誤訊息拆成「缺 KMS_KEY_ARN」與「email 格式錯」。

### 10.16 模擬器 S1b／S1c：帳號、開關、排程、訂單產生器 / Simulator S1b–S1c（P1，2026-11-17，ADR-030，PR #57、#58、#60）

| 項目 | Dev | Prod |
|---|---|---|
| Stack | `brewline-dev-simulator`（module `simulator`；部署在 api 之後） | `brewline-prod-simulator`（**終止保護**） |
| 帳號（D3） | custom resource `Custom::BrewlineSimulatorAccounts`（函數 `brewline-dev-simulator-provision`）：`sim-001`…`sim-040@example.com`、群組 `simulator`、`custom:tenant_id` 由種子決定（`brewline-dev-sim-2026`）；每次部署都檢查（自我修復缺少的帳號或密碼）；tenant_id 不符 → 部署失敗，不自動修正；刪除 stack 時刪除帳號 | 種子 `brewline-prod-sim-2026`；刪除 stack 時**保留**帳號與參數 |
| 密碼（D2） | SSM `/brewline/dev/simulator/credentials`：SecureString（資料層 CMK，Standard），`{ username: password }`；由 custom resource 以 SDK 建立（CloudFormation 不能建 SecureString）；不寫日誌、不回傳給 CloudFormation | 同左 |
| 開關（D7） | SSM `/brewline/dev/simulator/state`：`paused`／`running`；**只在不存在時建立為 `paused`**，部署不覆蓋；不認得的值、讀取失敗都當成 `paused` | 同左 |
| 設定 | SSM `/brewline/dev/simulator/config`（CDK 管理）：`poolSize 40`、`initialActive 30`、每日 2–6 筆、每筆 1–3 個商品 × 1–5 kg、重複下單 2% | 每日 5–40 筆 |
| 排程（D8） | 群組 `brewline-dev-simulator`，排程 `brewline-dev-simulator-tick`：`cron(5 8-19 * * ? *)` `Asia/Taipei`、`FlexibleTimeWindow OFF`、不重試、DLQ；角色 `brewline-dev-simulator-scheduler`（`aws:SourceArn` = 排程**群組** ARN） | 同左 |
| 執行函數 | `brewline-dev-simulator-run`（保留併發 1、逾時 2 分、非同步重試 0 → DLQ）：先讀 `state`，不是 `running` 就結束；**S1b 只做探測**（`sim-001` 經由 simulator client 登入 → `GET /products`，不寫資料）；手動 `{"probe": true}` 不論開關都探測一次 | 同左 |
| 執行角色 | `cognito-idp:AdminInitiateAuth`（pool）＋`ssm:GetParameter`（3 個參數）＋`kms:Decrypt`（`kms:ViaService = ssm`、`kms:EncryptionContext:PARAMETER_ARN = credentials`）；**不能**建立／修改帳號、寫參數、碰 DynamoDB | 同左 |
| 告警（D9） | `brewline-dev-simulator-run-errors`（≥ 1）、`…-simulator-dlq-not-empty` → `ops-alerts`；帳號告警總數 9（當時上限 10；2026-11-20 起每環境 ≤ 13，ADR-030 D9 修訂） | 同左 |
| **產生器（S1c）** | 每日 2–6 筆 | 每日 5–40 筆（docs/07 §2） |

**S1c 訂單產生器**（`services/simulator/src/generator.ts`，純函數）：
- 每日筆數＝範圍中點 × 季節（12 個月；12 月 1.15、7 月 0.9）× 星期（週一 1.4、週日 0.3）× 雜訊 ±25%，夾在最小／最大值之間；依每小時權重分配到 08–19 時（10 點最多）。
- 每筆 1–3 個不同商品、每個 1–5 kg；從**完整目錄**（種子檔的 8 個商品）挑選，執行時拿掉 `stock_status` 不是 `in_stock` 的商品，全部拿掉就跳過（`skipped_no_stock`）。
- 冪等鍵＝`sim-` ＋ sha256(種子│日期│小時│序號) 前 32 個十六進位字元 → 重跑同一小時只會重播（200）；2% 的請求用同一個 key 重送，必須 200 且同一個 `order_id`（SIM-F-008）。
- 啟用中的帳號：`initialActive` 30，`activationStartMonth`（2026-11）之後每月由種子決定多 1 或 2 家，上限 40（SIM-F-001）。
- 執行：每一小時依台北日期與小時產生計畫；各帳號經由 simulator client 登入（每輪每帳號一次）；請求間隔 ≥ 1 秒（SIM-N-002）；503 用同一個 key 重試一次。201／200／409 都正常，422（重跑時庫存狀態改變）記為 `key_conflict` 並警告；其他狀態或重送不符 → 跑完這一小時後丟錯 → `run-errors` 告警。日誌只記數量與參考編號（`<日期>T<小時>#<序號>`），不記帳號或 token。
- 手動事件：`{"dryRun": true, "date": "YYYY-MM-DD"}` 回傳當天計畫的筆數、每小時分布與雜湊（不看開關、不登入、不呼叫 API）→ SIM-F-009 驗收。
- 模擬訂單在 Dev 10 分／Prod 48 小時後由逾時工作流取消（D5）；模擬帳號沒有聯絡人 → 通知函數 `skipped_no_contact`，不寄信。

- 費用：沒有新的固定費用（SecureString Standard 免費、排程在免費額度內、告警 ≤ 10）。S1b 只有探測，`paused` 時每輪只有 1 次 SSM 讀取。
- 新 CloudFormation 類型：`AWS::Scheduler::Schedule`（2026-11-17 `describe-type` 實測 LIVE，§2）。

已驗證（2026-11-17，S1a PR #54／#56、S1b PR #57／#58；Deploy run #52、#54）：
- `verify-simulator-stack.sh` Dev、Prod 全部 ✅（Prod 整體 401 項、0 ❌）：帳號 40、`simulator` 群組 40 人且**沒有人在 staff**、`state = paused`、密碼參數 `SecureString`＋CMK＋Standard、**唯讀角色解不開**、排程（`ENABLED`、cron、`Asia/Taipei`、不重試、DLQ、角色信任排程群組 ARN）、函數標準設定、非同步重試 0 → DLQ、告警 2（帳號總數 9）、Prod 終止保護。
- 政策模擬（執行角色）：正向 `AdminInitiateAuth`、讀密碼參數 = `allowed`；反向 `AdminCreateUser`、`AdminSetUserPassword`、寫 `state`、讀其他參數、DynamoDB `PutItem` = `implicitDeny`。
- **Dev 手動開關測試**（Admin）：`paused` → `{"outcome":"paused"}`；`running` → `probe_ok`（`status 200`、`products 8`、`synthetic true`）；`RUNNING`（不認得的值）→ `paused`；`paused`＋`{"probe": true}` → `probe_ok`；最後恢復 `paused`。
- **S1d：Prod 開啟（2026-11-18 16:00，Prod Admin）**：dry run 今天 29 筆（08–19 時 `[4,3,4,3,1,2,3,7,2,0,0,0]`）；反向：`paused` 時手動執行 → `paused`；`state` 改 `running` 後 `probe_ok`（200、8 個商品、`synthetic`）。**刻意不手動下單**，由 16:05 排程觸發第一批：`hour 16`、`planned 2`、`created 2`、沒有 violation；事件 2 筆 `OrderCreated CREATED synthetic=true`；DLQ 0。開啟前的時段（08–15 時）不補跑（下一輪生效，SIM-N-001）。Prod 逾時 48 小時，模擬訂單停在 `CREATED` 直到自動取消（S1 D5；S2d 後由模擬烘焙廠推進）；模擬帳號是 `example.com`，不寄信。
- **Prod 手動探測**（Admin，`state = paused`）：`{"probe": true}` → `probe_ok`（`status 200`、`products 8`、`synthetic true`）；`{"source":"manual"}` → `paused`（S1d 開啟前）。
- 一個 `probe_ok` 同時驗證：SSM 讀密碼（CMK、`kms:EncryptionContext:PARAMETER_ARN`）→ simulator client 登入 → token 的 `synthetic` claim（S1a）→ authorizer audience → 目錄 API。

已驗證 S1c（2026-11-17，PR #60；之後 #61、#48、#55 部署後重驗：Dev 406 項 ✅、smoke 92/92，Prod 403 項 ✅）：
- **重現性（SIM-F-009）**：Dev `{"dryRun": true, "date": "2026-11-17"}` → 4 筆、每小時 `[0,0,0,1,0,1,0,0,0,1,1,0]`、雜湊 `01658fc9f7b61ec3…`，與本機用同一份程式碼算出的**完全相同**；反向：`2026-11-18` → 雜湊 `088545e2e101a52e…`（不同）、分布 10 時 2 筆、11 時 1 筆、14 時 1 筆，也與本機相同。
- **執行一小時**（Dev，`running`，17 時手動）：`simulated`、`planned 1`、`created 1`、`violations []`；**同一小時重跑** → `replayed 1`、`created 0`（冪等，沒有多下單）。
- **事件標記**：bus 日誌 `synthetic IS TRUE` 只有 1 筆 `OrderCreated CREATED`（重播不產生事件）；10 分鐘後多 1 筆 `OrderStatusChanged CANCELLED`——逾時工作流（`system:timeout`）取消的訂單也帶 `synthetic`，因為事件 detail 來自 Streams 的 NewImage，標記屬於訂單本身。
- **排程**：18:05 由 Scheduler 觸發 → `hour 18`、`planned 1`、`created 1`；19:05 → `planned 0`、沒有下單（反向）；20 時以後沒有執行（反向，cron `8-19`）；DLQ 0。
- **Dev、Prod 都是 `running`**（2026-11-18 起；Dev 每天 2–6 筆、Prod 5–40 筆）。

教訓 / Lessons：
- 驗證腳本也會有 bug：唯讀角色讀不到 Lambda 環境變數的值（#56，§10.14 #8 再犯一次）、寫死的告警總數（#58）。兩次都是「系統正常、驗證失敗」，管線因此跳過 Prod，沒有讓問題上線。驗證要檢查**不變條件**（全部接上、在上限內、只允許這些），不檢查某個時間點的數量或看不到的值。
- `state`／`credentials` 刻意不交給 CloudFormation：CloudFormation 不能建 SecureString，而由 CloudFormation 管理的開關會在部署時被覆蓋回預設值。
- 決定性的產生器讓驗收變簡單：不必比對每一筆訂單，只比對一個雜湊；本機（單元測試）與 Lambda 的結果相同，就代表計畫只由（種子、日期）決定。
- Dependabot（#48、#55）：main 前進後 PR 的 `checks` 會過期，要 rebase 或 update branch 重跑。#48 把 aws-cdk-lib 升到 2.277.0，新版認得 `nodejs26.x`，cdk-nag `AwsSolutions-L1` 因此對 24 個函數報錯 → 先合併 #61（acknowledge，ADR-023 修訂），再更新 #48。依賴更新**一次只合併、部署一個**，出問題時容易判斷是哪個變更造成的。

### 10.17 溯源 S2a：生豆批次、烘焙批次、烘焙廠角色 / Traceability S2a（P1，2026-11-18，ADR-031，PR #65、#66）

| 項目 | Dev | Prod |
|---|---|---|
| 資料（D5，單表、鄰接清單、**沒有新 GSI**） | `LOT#<lot_id>/META`（種子 `seed/lots.json`，每次部署覆寫；生產者名稱虛構）、`LOT#<lot>/ROAST#<日期>#<roast_id>`（邊）、`ROAST#<roast_id>/META`、`ROAST#<r>/ORDER#<tenant>#<order>`（邊，含 kg）；訂單品項加 `allocated_kg`、`roast_ids` | 同左（Dev 另有測試批次 `L-9999-00x`） |
| 身分（D6） | 新 scope `brewline/roastery`（staff 也有）；新群組 `simulator-roastery`（`catalog.read`＋`roastery`、`synthetic`、沒有租戶、沒有 admin、可經由 simulator client）；操作員群組（staff、simulator-roastery）最多一個且不能與租戶群組並存 → 模擬帳號永遠不會是 staff（RSK-018 不變條件） | 同左 |
| 新路由（皆 JWT＋scope） | `POST /admin/roasts`、`PATCH /admin/roasts/{id}`、`POST /admin/products/{id}/restock`（roastery）；`POST /admin/roasts/{id}/recall`（**只有 admin**）；`GET /admin/trace`（admin 或 roastery）；既有 `/admin/orders*`、`/admin/products/{id}/stock` 改為 admin 或 roastery | 同左 |
| 規則 | 只在 `ROASTING_SCHEDULED` 分配；每批 ≤ 15 kg、分配總和 ≤ 批次、每品項不超量（條件寫入）；批次 ID 由 Idempotency-Key 決定（重送 200、內容不同 422）；`→ROASTED` 需全數分配且批次已烘焙（批次狀態只會往前，先檢查後轉換是安全的）；QR token 128-bit，`ROASTED` 時產生一次；召回一次、公開文字不含 `<>`；補貨用 `version` 樂觀鎖（重送 409）、上限 2000 kg | 同左 |
| synthetic 保護 | 帶 `synthetic` 的呼叫者：只看得到、改得到模擬訂單與批次（真實的回 404／403 `synthetic_only`）；模擬批次只能分配模擬訂單，反之亦然 | 同左 |
| 函數（5 個，角色由 CloudFormation 命名，不扮演租戶角色） | `create-roast`：Get（PRODUCT／LOT／ROAST／TENANT）、Put 只在 `ROAST#`／`LOT#`、訂單 UpdateItem 只能動 `items`（`dynamodb:Attributes`）；`update-roast`／`recall-roast`：只有 `ROAST#`；`restock`：庫存欄位；`trace`：唯讀；全部明確 Deny Scan、沒有 Delete | 同左 |

- 費用：每批次數個 WRU，約 0；沒有新的固定費用。
已驗證（2026-11-18，commit `feda4c5`，Deploy run `44256253715`）：
- **Dev smoke test 129/129**（新增 37 項）：模擬烘焙廠經由 simulator client 拿到 roastery、沒有 admin／租戶；改真實訂單 → 403 `synthetic_only`、讀真實訂單 → 404、列表只有模擬訂單、可確認模擬訂單；未分配就 ROASTED → 409 `not_fully_allocated`；建立批次 201（批次在商品的生豆批次上）、同 key 重送 200、內容不同 422、超量 409（`remaining_kg`）、> 15 kg 400、沒有 key 400；批次未烘焙時訂單 ROASTED → 409 `roast_not_roasted`；批次 ROASTED 產生 22 字元 token、再烘焙 409；訂單 ROASTED → SHIPPED（95/2）→ COMPLETED；雙向追溯（訂單 → 批次 → 生豆批次含生產者、批次 → 訂單、生豆批次 → 批次）；召回 admin only、拒絕 markup、只能一次；補貨 +5（102）、重送 409（不重複）、模擬烘焙廠 +1（103）；咖啡廳的訂單 DTO 沒有分配資訊。
- **`dynamodb:Attributes` 在交易內更新巢狀欄位**（`items[i].allocated_kg`）比對頂層名稱 `items`：分配與後續 ROASTED 都成功，函數只能改訂單的 `items`。
- CI：Dev ✅ 442、Prod ✅ 439、0 ❌；19 條路由與 scope（召回只有 admin）、19 個函數、HTTP 反向（無 token／偽造 admin JWT → 401）、`SeededLots` Dev 10／Prod 8；租戶角色讀 `ROAST#`、`LOT#` → `implicitDeny`。

- 尚未包含（S2b–S2d）：公開溯源頁（S3 投影＋CloudFront Free 方案）、事件（`RoastBatchRoasted`／`Recalled`）、模擬烘焙廠的排程。

教訓 / Lessons：
- （2026-11-18）**第一次部署被 Dev smoke test 擋下並 rollback（Prod 未部署）**：種子寫入的 `LOT#…/META` 帶 `updated_at`，但讀取用的 `LotItemSchema` 由 strict 的 `SeedLotSchema.extend()` 而來 → 每個批次都 parse 失敗、被當成不存在 → 所有 `POST /admin/roasts` 回 409 `lot_not_found`，後續 ROASTED／SHIPPED 檢查連鎖失敗。單元測試的假資料沒有 `updated_at`，所以沒抓到。修正：讀取 schema 不用 strict（種子檔維持 strict 擋打錯的欄位），並加回歸測試「`getLot` 讀得到 `seedLots()` 實際寫入的項目」（還原舊 schema 時此測試失敗）。原則：**寫入端與讀取端的測試要用同一份資料**，不要各自手寫假資料。

### 10.18 溯源 S2b：us-east-1 edge stack / Traceability S2b（P1，2026-11-18，ADR-031 D3／D4，PR #69、#70）

| 項目 | Dev | Prod |
|---|---|---|
| Stack | `brewline-dev-edge`（**us-east-1**，module `traceability`） | `brewline-prod-edge`（**終止保護**） |
| ACM 憑證 | `trace.dev.brewline-demo.click`：DNS 驗證，記錄寫入 Dev zone `Z00697733VLK1TK9WUYKL`（原生 CloudFormation，沒有 Lambda） | `trace.brewline-demo.click`：Prod zone `Z039360620HRFCTYO5R5J` |
| WAF web ACL | `brewline-dev-trace`（scope `CLOUDFRONT`，預設 Allow）：① `RateLimitPerIp` 每 IP 每 5 分鐘 300 次 → Block；② `AWSManagedRulesAmazonIpReputationList`；③ `AWSManagedRulesCommonRuleSet`；3 條（Free 方案上限 5）、全部生效、CloudWatch 指標 | `brewline-prod-trace` |
| SSM（us-east-1，參考用） | `/brewline/dev/edge/{trace-certificate-arn,trace-web-acl-arn}` | `/brewline/prod/edge/...` |

- **兩階段**（與 ADR-029 E2 相同）：部署後把輸出 `TraceCertificateArn`、`TraceWebAclArn` 填進 `lib/config.ts` 的 `trace.edge`，S2c 的台北 `trace` stack 才會建立 distribution。不用 `crossRegionReferences`（會多兩個 custom resource Lambda、兩個 stack 強耦合）。
- **Free 方案的條件**（2026-11-18 查證）：一個訂閱＝剛好 1 個 distribution＋1 個 web ACL（可選加 Route 53 hosted zone）；distribution 本身必須先設定 `WebACLId`；最多 5 條 WAF 規則；沒有存取日誌、沒有自訂快取／回應標頭政策（用 managed 政策＋S3 `Cache-Control`）；方案涵蓋 web ACL、規則、請求費。
- ACM 只會自動續約**使用中**的憑證：S2c 掛上 CloudFront 之前 `RenewalEligibility = INELIGIBLE` 是正常的（驗證腳本依 `InUseBy` 判斷；掛上後必須是 `ELIGIBLE`）。憑證有效期 13 個月，S2c 不會晚到過期。
- **費用**：S2c 訂閱之前，web ACL 是 pay-as-you-go（每月 USD 5＋每條規則 USD 1，按時間比例；2 個環境約 USD 0.5／天）→ **S2c 要緊接著做**；訂閱後 0 元。ACM 公開憑證免費。
已驗證（2026-11-18，commit `734b83d`／#70，Deploy run `44275865419`）：Dev、Prod 各 20 項 ✅、0 ❌——憑證 `ISSUED`、DNS 驗證、只有一個名稱、`AMAZON_ISSUED`；web ACL global、預設 Allow、3 條規則名稱正確、沒有 Count 模式、速率規則 Block／IP／300 秒／300 次、每條規則都有指標；SSM 與輸出一致；Prod 終止保護 `true`。Prod 憑證在部署過程中就完成 DNS 驗證（zone 與憑證同帳號）。ARN 已填入 config `trace.edge`（S2c）。

教訓 / Lessons：
- （2026-11-18）**第一次 Dev 驗證失敗 1 項，Prod 被跳過**：`RenewalEligibility = INELIGIBLE`。ACM 只續約**使用中**的憑證，S2c 掛上 CloudFront 前就是 `INELIGIBLE`，是驗證腳本的預期值寫錯，資源正常。修正（#70）：依 `InUseBy` 判斷——沒人使用時預期 `INELIGIBLE`、使用中必須 `ELIGIBLE`。原則：**驗證的預期值要把前提條件一起寫進去**，不要寫死。

- 將來可評估：把 hosted zone 加入方案（Free 上限 50 筆記錄），由方案負擔 zone 費用（目前 2 個 zone 約 USD 12／年）。

### 10.19 溯源 S2c：公開溯源頁 / Traceability S2c（P1，2026-11-19，ADR-031 D2–D4，PR #71–#73）

| 項目 | Dev | Prod |
|---|---|---|
| Stack | `brewline-dev-trace`（台北，module `traceability`） | `brewline-prod-trace`（**終止保護**） |
| 網址 | `https://trace.dev.brewline-demo.click/#<qr_token>` | `https://trace.brewline-demo.click/#<qr_token>` |
| S3 | `brewline-<env>-trace-<帳號>`：封鎖公開存取、SSE-S3、只允許 TLS ≥ 1.2、Bucket owner enforced、**保留**、`data-class=public`；bucket policy 只有一條 Allow：`cloudfront.amazonaws.com` 的 `s3:GetObject`，條件 `AWS:SourceArn` = 這個 distribution（OAC）；**沒有 ListBucket** → 不存在的 token 是 403 | 同左 |
| CloudFront | 別名 `trace.<網域>`、edge stack 的 us-east-1 憑證（TLSv1.2_2021、SNI）與 web ACL、OAC、HTTPS 轉址、只有 GET／HEAD、managed `CachingOptimized`（遵守原點 `Cache-Control: max-age=300`）＋ managed `SecurityHeadersPolicy`、HTTP/2＋3、IPv6；403／404 → 一律 404 `/404.html`（快取 60 秒）；沒有存取日誌（Free 方案不支援） | 同左 |
| Free 方案 | `AWS::PricingPlanManager::Subscription`：`CloudFront`／`FREE`／`DEFAULT`，ResourceArns＝distribution＋web ACL | 同左 |
| DNS | A／AAAA alias → distribution（Dev zone） | Prod zone |
| 投影函數 | `brewline-<env>-traceability-trace-projector`：規則 `brewline-<env>-trace-project`（`source=brewline.traceability`，`RoastBatchRoasted`／`RoastBatchRecalled`）→ 強一致讀 `ROAST#`／`LOT#`／`PRODUCT#` 的 `META`（只有 `GetItem`、`LeadingKeys` 限定、明確 Deny Scan）→ `PutObject v1/<qr_token>.json`（只能寫 `v1/*`）；DLQ＋DLQ 告警（不另設 Errors 告警：免費額度 10 個，見教訓） | 同左 |
| 靜態頁 | custom resource `Custom::BrewlineTraceSite`（函數 `…-traceability-site-publisher`，只能寫 5 個固定檔名）：`index.html`、`app.js`、`app.css`、`404.html`、`robots.txt`（`Disallow: /`） | 同左 |
| 事件（events stack） | stream publisher 的過濾多一條 `entity = RoastBatch`（MODIFY）；`ROASTED` → `RoastBatchRoasted`，第一次召回 → `RoastBatchRecalled`；detail 只有 `roast_id`、`product_id`、`lot_id`（＋`synthetic`），**不含 QR token** | 同左 |

- **讀取路徑沒有 Lambda／API／DynamoDB**（D2）：列舉 token 只會打到 CloudFront＋S3，回應一律相同的 404，再被 WAF 每 IP 速率規則擋下（TRC-N-004）。
- **投影是白名單「建構」**（`services/traceability/src/projection.ts`）：只從允許的欄位組新物件，不複製再刪減 → 資料表新增欄位也不會出現在公開頁（RSK-019）。內容：商品名稱、生豆批次（生產者〔虛構〕、國家、產區、海拔、品種、處理法、杯測、採收季）、烘焙日期與烘焙度、召回提醒、`demo`（模擬資料）。沒有批次 ID、公斤數、租戶、訂單、建立者。
- **token 放在 URL fragment（`#`）**：瀏覽器不會把它送到 CloudFront，也不會放進 Referer；頁面另有 `no-referrer`、嚴格 CSP（只允許同源 script／style／fetch，沒有 inline）、所有資料用 `textContent` 輸出。
- 冪等：重投影只是覆寫同一個物件。批次已被 Dev smoke test 清掉 → 略過（不重試）；生豆批次或商品找不到 → 丟錯 → 重試 → DLQ 告警。
- 召回後最多 5 分鐘（快取）公開頁才顯示提醒（ADR-031 D3 已接受）。
- 費用：Free 方案 0 元（涵蓋 CloudFront、web ACL 與規則、請求）；S3 幾 KB；Lambda 每批次 1 次呼叫。訂閱後 S2b 的 web ACL 不再按時計費。
已驗證（2026-11-19，commit #73，Deploy run `44443589350`）：**Dev ✅ 507、Prod ✅ 498、0 ❌**——
- Free 方案層級 `FREE`（Dev、Prod）→ web ACL 不再按時計費；憑證被 distribution 使用、`RenewalEligibility = ELIGIBLE`。
- 從網際網路：`/`、`app.js`、`robots.txt` 200；HSTS、`nosniff`、`SAMEORIGIN`、`Cache-Control: public, max-age=300`；反向：亂數 token、未知路徑、POST 都是**同一個** 404、HTTP → 301、直連 S3 403、TLS 1.1 被拒。
- **Dev 端到端**：smoke test 烘焙的批次已自動投影；經 CloudFront 讀取 200，欄位剛好是白名單、沒有租戶／訂單／Email。Prod 尚無烘焙批次（`⏭`，S2d 之後才有）。
- 告警：Dev、Prod 都是 **10 個**（當時以為是每帳號的免費額度上限；2026-11-20 確認免費額度是**全組織**共用，§5、ADR-030 D9 修訂）。
- **Free 方案帳單證據**（2026-11-20，管理帳號 Cost Explorer，`SERVICE = AWS WAF`，每日＋`USAGE_TYPE`）：Dev 11-18 USD 0.165、11-19 USD 0.011、11-20 **0**；Prod 11-18 USD 0.160、11-19 USD 0.022、11-20 **0**。用 `UsageQuantity` 反推：11-19 的 `Global-WebACLV2` Dev 0.00139 月（× 720 ≈ **1 小時**）、Prod 0.00278 月（≈ 2 小時，Prod 晚 1 小時訂閱，與 #73 部署順序一致）；`Global-RuleV2` 3 條 × 1/720 同樣是 1 小時。→ 訂閱後 web ACL 與規則**不再按時計費**；訂閱前的一次性費用兩個環境合計約 USD 0.36。Cost Explorer 的日期是 **UTC**，且會回頭補前幾天的金額（`Estimated: True` 表示尚未結算）。

- 教訓（2026-11-19）：**第一次 Dev 部署成功，但 `verify-ops-stack.sh` 擋下：Dev 告警 11 個（免費額度 10，ADR-030 D9）**，Prod 被跳過。原本投影函數有 DLQ 與 Errors 兩個告警；失敗重試後一定進 DLQ，Errors 告警是重複的 → 移除。Dev 現在剛好 10 個：**之後新增告警前要先合併或移除既有的**（status §13）。
- 教訓（2026-11-19）：第二次 Dev 部署 **trace 驗證 39 項中 38 ✅、1 ❌**：`POST rejected = 404 (expected 403)`。CloudFront 對只允許 GET／HEAD 的行為回 403，但我們設定的「403 → 404」錯誤回應同樣套用在它上面 → 回 404。這是期望的行為（所有拒絕都長得一樣），是驗證的預期值寫錯；改成檢查 404 且內容與亂數 token 相同。
- 驗證：`scripts/verify-trace-stack.sh`（CI，lookup role 唯讀）＝ distribution 設定、Free 方案層級、憑證使用中、bucket 私有，以及**從網際網路實測**：`/` 200＋安全標頭＋`Cache-Control`；反向：3 個亂數 token 都 404 且內容相同、未知路徑 404、POST 也是同一個 404（CloudFront 的 403 經自訂錯誤回應統一）、HTTP → 301、直連 S3 403、TLS 1.1 被拒；若 bucket 已有投影，檢查欄位剛好是白名單。

### 10.20 溯源 S2d：模擬烘焙廠 / Traceability S2d（P1，2026-11-19，ADR-031 D8，方案 A）

| 項目 | Dev | Prod |
|---|---|---|
| 帳號 | `sim-roaster@example.com`：群組 `simulator-roastery`、**沒有 tenant_id**、token 帶 `synthetic`；由既有的帳號 custom resource 建立，密碼存在同一個 SecureString（`AccountCount` 仍是咖啡廳數 40，另有 `Roasters` = 1） | 同左 |
| 執行 | **同一個** `brewline-<env>-simulator-run`、同一個排程（08:05–19:05）、同一個開關；先跑咖啡廳下單，再跑烘焙廠（`services/simulator/src/roastery.ts`）；逾時 2 → **5 分鐘** | 同左 |
| 節奏（台北） | 每小時 confirm：CREATED → CONFIRMED **90%**（依訂單 ID 雜湊；其餘 10% 交給逾時工作流取消）｜16 時 schedule：CONFIRMED → ROASTING_SCHEDULED＋依商品裝箱成烘焙批次（≤ 15 kg、≤ 15 張訂單、烘焙日期＝明天）；restock：低於門檻的商品補回初始量（`expected_version`，衝突重讀一次）｜09 時 roast：被引用的批次 → ROASTED（**產生 QR → 公開頁**）、全數分配的訂單 → ROASTED｜14 時 ship：→ SHIPPED｜10 時 complete：出貨滿 2 個台北日 → COMPLETED | 同左 |
| 冪等 | 每一步「讀目前狀態 → 只做還沒做的」；批次 Idempotency-Key＝`simroast-` ＋ sha256（烘焙日期、商品、公斤、分配）→ 重跑得到 200；改狀態遇到 409 `invalid_transition`／批次 409 `invalid_state` 算「已完成」 | 同左 |
| 錯誤 | 咖啡廳與烘焙廠的違規分開記錄（log `roastery[]`），烘焙廠出錯不擋下單；最後一起丟錯 → 既有的 `simulator-run-errors` 告警（**不新增告警**，仍是 10 個） | 同左 |
| 手動 | `{"roastery": "confirm\|schedule\|restock\|roast\|ship\|complete"}`：不看時段、不論開關，只執行該步驟（Admin 呼叫；未知步驟 → 丟錯、不登入） | 同左 |

- **方案 A 的理由**（2026-11-19 討論）：模擬咖啡廳與模擬烘焙廠同屬「合成流量產生器」這個失敗領域，處理方式相同（看 log、暫停模擬器），所以共用一個函數與告警。**不採用**共用 DLQ（方案 B）：告警是「狀態」，一個 DLQ 告警在 ALARM 時，其他來源的新失敗不會再通知；訊息格式不同、權限變寬。之後若真的需要第 11 個告警，選擇付費（每個 USD 0.10／月，修訂 ADR-030 D9），不合併 DLQ。
- 教訓（2026-11-19）：第一次 Dev 部署成功（帳號 custom resource 有執行），但驗證 1 項 ❌：`Roaster account in simulator-roastery = 0`。user pool 以 **email 當登入別名**（`UsernameAttributes`），Cognito 的 `Username` 是 UUID，不是 email；我用 email 比對 `Username` → 找不到。更糟的是「不在 staff／不在咖啡廳群組」兩項也是拿 email 比 UUID，**因為錯的原因而通過**。修正：先用 `email` 屬性找到帳號，再用它的 `Username` 比對各群組。原則：**反向檢查也要確認它真的有能力失敗**。
- 只走公開 API（ADR-011）；伺服器端 synthetic 保護（S2a）保證烘焙廠只看得到、改得到模擬訂單與模擬批次。
- 費用：每天約多 50–150 次 API 呼叫與幾次 Lambda 執行，約 0。

已驗證（2026-11-19～20，PR #75、#76，Deploy run `44452958914`）：
- CI：Dev ✅ 512、Prod ✅ 503、0 ❌；roaster 在 `simulator-roastery`、沒有 tenant_id、不在 staff／咖啡廳群組（用真正的 `Username` 比對）；函數逾時 300 秒；告警仍是 10 個。
- **Dev 端到端（2026-11-19 12:18，手動步驟）**：`schedule` → 1 筆訂單排烘、2 個批次（訂單有 2 個商品，一批只能烘一種豆）；`roast` → 2 批 `ROASTED`、訂單 `ROASTED`；S3 出現投影，公開頁可開啟；改掉最後一個字元 → 「找不到」。
- **Prod 16:05 排烘（2026-11-19，排程自動）**：`confirm` 看到 4 筆 CREATED、確認 1 筆、3 筆留給逾時（前幾輪被雜湊判定不確認、累積到 48 小時取消）；`schedule` 22 筆訂單 → **9 個批次**（`batches_created` 9、沒有重播）；`restock` 1 個商品 +14 kg；沒有 `roast`／`ship`（反向）；違規 0。
- **Prod 09:05 烘焙（2026-11-20，排程自動）**：`roast` → `batches_roasted` 9、訂單 `advanced` 22、`not_fully_allocated` 0、違規 0；S3 **9 個投影** → **Prod 第一批公開溯源頁**（`https://trace.brewline-demo.click/#<token>`）：商品「山脊雙重水洗」、肯亞 Nyeri、1800 m、SL28、水洗、杯測 87、烘焙日期 2026-11-20、淺焙、示範資料提示。從 16:05 排烘到 09:05 烘焙相隔 17 小時，狀態全在 DynamoDB，Lambda 無狀態。
- **溯源模組 S2 完成**（ADR-031 D1–D9 全部實作；TRC-F-004 海運旅程等 P2 海運追蹤）。

### 10.21 資料湖基礎 / Data Lake Foundation（P2a，2026-11-20，ADR-032，PR #78）

| 項目 | Dev | Prod |
|---|---|---|
| Stack | `brewline-dev-lake`（module `data-lake`；部署清單最後，依賴 data、ops；**沒有任何 Lambda**） | `brewline-prod-lake`（**終止保護**） |
| Lake bucket | `brewline-dev-lake-610935435571`：SSE-KMS（資料層 CMK，SSM）＋**Bucket Key**、BPA、Bucket owner enforced、TLS ≥ 1.2（bucket policy＋RCP）、版本控制、`data-class=internal`、`DESTROY`（**不用** `autoDeleteObjects`：會多一個 custom resource Lambda；刪 stack 前手動清空） | `brewline-prod-lake-062868712468`、**Retain** |
| 生命週期（lake） | `raw/` 30 天刪除；`curated/`、`analytics/` 730 天；`quarantine/` 90 天；所有前綴：舊版本 30 天、multipart 7 天 | `raw/` **90 天轉 Glacier IR、730 天刪除**；其餘同左 |
| Lake bucket policy | `DenyWrongKmsKey`：`PutObject` 帶 `x-amz-server-side-encryption-aws-kms-key-id` 且不等於 CMK ARN → Deny；`DenyNonKmsSse`：帶 `x-amz-server-side-encryption` 且不是 `aws:kms` → Deny；兩者都是 `Null = false`（標頭存在）＋`StringNotEquals`。**沒帶標頭的上傳由預設加密套用 CMK** | 同左 |
| Athena 結果 bucket | `brewline-dev-athena-results-610935435571`：加密／存取同上、不開版本控制、全部 7 天過期、multipart 1 天 | 同左（Retain） |
| Glue（`CfnDatabase`） | `brewline_raw`、`brewline_curated`、`brewline_analytics`（`LocationUri` = lake 的 `raw/`、`curated/`、`analytics/`）；不開目錄加密、不用 crawler、不開 Lake Formation | 同左 |
| Smoke 表 | `brewline_raw.lake_smoke`：JSON SerDe、`dt` partition projection（`2026-11-01,NOW`）、`synthetic=true` 等出處屬性 | **不建** |
| Workgroup | `brewline-dev-analytics`：`EnforceWorkGroupConfiguration`、單次掃描上限 **100 MB**、engine v3、結果 `s3://<results>/athena/`＋SSE_KMS（CMK）＋`ExpectedBucketOwner`、CloudWatch 指標；`RecursiveDeleteOption` true | 上限 **1 GB**；`RecursiveDeleteOption` false |
| DLQ＋告警 | `brewline-dev-lake-dlq`（SSE-SQS、TLS、14 天；P2a 沒有生產者，P2a-2 Firehose 規則、curate 工作流使用）；告警 `brewline-dev-lake-dlq-not-empty` → `ops-alerts`（ALARM＋OK） | 同左 |
| SSM（Standard） | `/brewline/dev/lake/{bucket-name,bucket-arn,results-bucket-name,workgroup-name,db-raw,db-curated,db-analytics,dlq-arn,dlq-url}`（＋同名 output）；前綴慣例寫在 `bucket-name` 的說明與 README | `/brewline/prod/lake/…` |

- 前綴慣例：`raw/<source>/dt=YYYY-MM-DD/`、`curated/<table>/…`、`analytics/<table>/…`、`analytics/serving/`、`quarantine/<source>/dt=…/`、`edi/{inbound,archive,quarantine}/`、`raw/_smoke/`（Dev）。
- 告警：每環境 10 → **11**；`verify-ops-stack.sh`（`brewline-<env>-*`）與 `verify-simulator-stack.sh`（帳號全部）上限改為 **≤ 13**（ADR-030 D9 修訂，同一個 PR，#72 教訓）。
- 人員查詢：只有 Dev 的 Developer 許可集（§3）；Prod 只有 Admin，沒有人員查詢路徑。
- 費用：告警 +USD 0.10／月／環境；S3、Glue、Athena 在目前資料量約 0（Athena 每次查詢最低 10 MB 計費）。

已驗證（2026-11-20，merge `b6a5e38`，Deploy run `44670215079`）：**Dev ✅ 559、Prod ✅ 553、0 ❌**——
- CI `cdk diff`：只有 `brewline-dev-lake` 的 `[+]`；既有 stack 只有每次部署都會變的 commit 欄位（pipeline-check、smoke test、模擬器帳號），沒有其他變更。
- `verify-lake-stack.sh`：兩個 bucket 的加密（`aws:kms`＋CMK＋Bucket Key `True`）、BPA、ownership、`data-class`、TLS Deny、公開 Allow 0；lake 版本控制、results 未開；生命週期（Dev raw 30／不轉層，Prod raw 730／`GLACIER_IR 90`）；`DenyWrongKmsKey`、`DenyNonKmsSse` 的 `Null` 條件與 CMK；3 個 Glue DB；Dev smoke 表 projection／template／`synthetic`、**Prod smoke 表不存在**；workgroup（Dev 104857600／Prod 1073741824、SSE_KMS＋CMK、engine v3）；DLQ 與告警接上；SSM 9/9；終止保護；反向：stack 沒有 Lambda、唯讀角色 `StartQueryExecution` → denied；唯讀角色讀物件 → ⏭（當時沒有物件，T1 後下次部署會實測）。
- `verify-ops-stack.sh`：`within budget (1-13) = true (11)`、11 個告警都接上（Dev、Prod）；`verify-simulator-stack.sh`：帳號告警 `≤ 13 = true (11)`。
- 手動 T1–T6、T5b（Dev，Developer）：見 §3 2026-11-20 補權限。T7（Prod Admin，只讀）：workgroup 上限 `1073741824`、`True ENABLED`、smoke 表 `absent`、lake 0 物件、Developer 角色 0。

教訓 / Lessons：
- （2026-11-20）**`…IfExists` 在條件鍵不存在時為 true**。規格原本寫 `StringNotEqualsIfExists`（意圖是「標頭存在且不等於」），放在 Deny 裡會擋掉**所有不帶加密標頭**的上傳（預設加密、T1）。「存在且不等於」要寫成 `Null: false`＋`StringNotEquals`（同一敘述內 AND）；單元測試斷言 policy 不含 `IfExists`，T1（沒帶標頭可通過）與 T5（錯的金鑰被拒）成對驗證。代價：以金鑰 ID（UUID）指定同一把 CMK 也會被拒 → 寫入者一律用 SSM 的 ARN。
- （2026-11-20）改不變條件時要 `grep` 所有寫死該值的腳本：規格只列 `verify-ops-stack.sh`，但 `verify-simulator-stack.sh` 也檢查帳號告警 ≤ 10；同一個 PR 一起改，Dev 驗證一次通過、Prod 沒被跳過。
- （2026-11-20）驗證腳本在雲端以離線 AWS CLI 替身先跑過（正向全 ✅、錯誤值 → ❌），抓到 `pipefail` 下 `aws … | grep` 會回傳 aws 的失敗碼而誤判「表存在」→ 先取錯誤訊息再判斷。
- （2026-11-20）Athena 的 AccessDenied 不會說明是 identity-based 還是 explicit deny（只有 `not authorized`）；S3 會。T4（沒有 Allow）與 T5（bucket policy 明確 Deny）錯誤訊息不同，可分辨是哪一層擋下。
- （2026-11-20）CloudShell 屬於開啟它的主控台工作階段：入口網站切換帳號後，舊分頁仍是原身分 → T7 第一次在 Dev 執行；之後指令區塊一律先比對帳號 ID，不符就停止。

#### P2a-2 訂單事件進資料湖 / Order Events to the Lake（2026-11-20，ADR-032 D6，PR #80、#81）

| 項目 | Dev | Prod |
|---|---|---|
| 規則 | `brewline-dev-lake-order-events`（bus `brewline-dev`）：`source=brewline.ordering`、**只有** `OrderCreated`、`OrderStatusChanged`（E2）；重試 3 次／2 小時；DLQ＝`lake-dlq`（不新增告警，E4） | `brewline-prod-lake-order-events` |
| Input transformer（E1-A） | `{"id":<id>,"detail_type":<detail_type>,"source":<source>,"time":<time>,"detail":<detail>}` ＋ **`\n`**：Firehose 不會在記錄之間加換行，由規則輸出一行一筆；`detail-type` 改名 `detail_type`（Athena 欄位不能有 `-`）；不用 `<aws.events.event.json>`（文件規定只能當 JSON 欄位值） | 同左 |
| Firehose | `brewline-dev-order-events`：DirectPut、串流 AWS 擁有的金鑰（免費）、`raw/events/dt=!{timestamp:yyyy-MM-dd}/`（UTC）、錯誤前綴 `raw/events-errors/…`、GZIP、5 MiB／300 秒、物件以資料層 CMK 加密（通過 `DenyWrongKmsKey`）、錯誤日誌 `/aws/kinesisfirehose/…`（7 天）；**沒有資料處理、沒有 Lambda** | 錯誤日誌 30 天 |
| Firehose 角色 | `brewline-dev-order-events-firehose`：信任 `firehose.amazonaws.com`＋`aws:SourceAccount`＋`aws:SourceArn`；`PutObject` 只限 `raw/events/*`、`raw/events-errors/*`；KMS 只限 `kms:ViaService = s3`＋`kms:EncryptionContext:aws:s3:arn = <bucket ARN>`；沒有 Get／Delete | 同左（prod） |
| Glue 表（E5） | `brewline_raw.order_events`：JSON SerDe（`ignore.malformed.json=false`）、`detail` 為 struct、projection `2026-11-20,NOW`、`synthetic=mixed` | 同左 |
| SSM | 新增 `order-events-stream-{name,arn}`（共 11 個） | 同左 |

- 規則與 Firehose 放在 lake stack（E3）：lake 新增依賴 events（SSM bus 名稱）；規則的 DLQ 權限在同一個 stack 產生。Bus 資源政策不需改（規則投遞不是 `PutEvents`）。
- Developer 許可集**不需要改**：`LakeRead` 已涵蓋 `raw/events/`、`LakeGlueRead` 已涵蓋 `brewline_*`。
- 費用（估）：每環境每月 < USD 0.05（Firehose 以 5 KB 計、S3 PUT 依「有資料的 5 分鐘時段」數）；告警 0。

已驗證（2026-11-20，Deploy run `44701904005`，merge `b99aa04`）：**Dev ✅ 595、Prod ✅ 587、0 ❌**——
- CI `cdk diff`（#80）：lake 11 個 `[+]`、2 個就地 `[~]`（`lake-dlq` queue policy 加 1 條、SSM `bucket-name` 說明），其他 stack 只有 commit 欄位。
- `verify-lake-stack.sh` 新增 30 項：Firehose 設定、規則與 input transformer（以 `}\n` 結尾）、Glue 表、Firehose 角色政策模擬（正向 2：寫 `raw/events/`、`raw/events-errors/`；反向 6：`raw/other/`、`curated/`、Get、Delete、KMS 沒有 ViaService、KMS 別的 bucket）、信任政策、錯誤前綴 0 個物件、`DeliveryToS3.Success`（Dev = 1；Prod 部署當下尚無事件 → ⏭）。
- **手動 M1–M4（Dev，Developer，16:01 的物件）**：**`wc -l` 14 ＝ `jq` 14 ＝ Athena 14**（`OrderCreated` 2、`OrderStatusChanged` 12）→ E1 的結尾換行在執行時有保留；`synthetic = true` 8 筆（其餘是 smoke test 租戶）；內容 `@`／`TENANT#`／`idempotency`／`created_by` 皆 0；`detail_type` 以外的類型 0；Developer 寫 `raw/events/` → `AccessDenied`（`no identity-based policy allows`）。
- **M5（Prod，Admin，只讀，不跑 Athena）**：2026-11-20 17:05 那一輪計畫 0 筆（dry-run `[0,2,4,7,1,2,5,2,2,0,2,0]`，17 時＝0），烘焙廠 `confirm` 的 7 筆 CREATED 依雜湊全部留給逾時 → bus、規則（`Invocations 0`／`FailedInvocations 0`）、Firehose（`IncomingRecords 0`）、`lake-dlq`（0）**一致為 0**，不是故障。2026-11-21 12:36 檢查 `dt=2026-11-21`：**5 個物件**（台北 08:05–12:05 每個整點一個，各在 :10 寫出＝300 秒緩衝）；**`wc -l` 31 ＝ `jq` 31**；**`synthetic = true` 31 ／ 31**（Prod 只有模擬流量）；`OrderCreated` 4、`OrderStatusChanged` 27；`@`／`TENANT#`／`idempotency` 皆 0；錯誤前綴 0 個物件。

教訓 / Lessons：
- （2026-11-20）**開了 S3 Bucket Key 之後，KMS 加密內容（`kms:EncryptionContext:aws:s3:arn`）是 bucket ARN，不是物件 ARN**。寫成物件 ARN 時 `GenerateDataKey` 被拒，Firehose 會重試 24 小時後**丟棄資料**；單元測試（故意改成物件 ARN → 失敗）與部署驗證（政策模擬）一起把關。
- （2026-11-20）「服務執行時的行為」只能在真實環境驗證：單元測試只能確認 template 有 `\n`，EventBridge 會不會保留要用 M1 兩種對換行反應不同的數法（`wc -l` 只數換行、`jq` 不管換行）＋Athena 交叉比對 → 因此 Dev 驗證前先不核准 Prod。
- （2026-11-20）**驗證腳本不要用 `--output text` 做比對**（#81）：空結果印 `None`（`KeyCount`）；`--max-items 1` 在有第二個物件時多印一行 `None`（分頁），鍵名被污染 → `NoSuchKey` 被誤判成「允許」。#79 時 lake 只有 1 個物件所以沒出現。一律 `--output json`＋`jq`；反向檢查只有 `AccessDenied` 算通過，`NoSuchKey` 是腳本錯誤。離線替身也要模擬這些 CLI 行為（修正前重現 2 個 ❌）。
- （2026-11-20）驗證失敗 → Prod 自動跳過 → 修驗證的 PR 合併後的部署**一併**把功能送到 Prod，不需要手動補部署（#80 → #81）。
- （2026-11-20）Firehose 用 L1：L2 的 S3 目的地會給角色整個 bucket 的讀寫；規則 ARN 以名稱組出，避免「規則 ↔ 角色信任政策」循環依賴。
- （2026-11-20）資料流沒有結果時，**依序看每一關的計數**（bus 稽核日誌 → 規則 `Invocations`／`FailedInvocations` → Firehose `IncomingRecords`／`DeliveryToS3.Records` → DLQ）：「全部為 0」是源頭沒有事件，「前一關有、後一關 0」才是斷掉。決定性的模擬器可以用 dry-run 事先算出下一個事件的時段，不必碰運氣等待。

### 10.22 海運追蹤 P2b：訂艙、模擬航程、航程偵測 / Shipment Tracking P2b（P2，2026-11-21，ADR-032 補充 E1–E12，PR #83、#84、#85）

| 項目 | Dev | Prod |
|---|---|---|
| 訂艙 API（P2b-1，api stack） | `POST /admin/shipments`（`brewline/roastery`、`Idempotency-Key`；201／重送 200／內容不同 422；TW 批次 400 `no_sea_route`）、`GET /admin/shipments?lot=`、`GET /admin/shipments/{id}`（`brewline/admin` 或 `roastery`）；函數 `brewline-dev-ordering-{create-shipment,get-shipment,list-shipments}`；路由、函數 19 → **22** | 同左 |
| 資料（單表，**不加 GSI**） | `SHIP#<id>/META`（`entity=Shipment`、POL／POD、`planned_departure`／`planned_arrival`、`eta`／`atd`／`ata`、`status` `PLANNED`→`DEPARTED`→`ARRIVED`、`tracking`、`version`）、`SHIP#<id>/EVT#<時間>#<eventID>`（DCSA T&T 2.2.0 運輸事件 `DEPA`／`ARRI`，ACT）、`SHIP#<id>/TRACK`（≤ 200 點）、邊 `LOT#<lot>/SHIP#<出發>#<id>`、`VESSEL#<船>/VOY#<出發>#<id>`；META 不放 `product_id` | 同左 |
| 訂艙函數 IAM | `PutShipment`（`SHIP#*`）＋`PutEdgesOnly`（`LOT#*`、`VESSEL#*`，`dynamodb:Attributes` 限 9 個邊欄位，清單在 `services/shipment/src/edge-attributes.ts`，CDK 共用）→ 寫不了 `LOT#…/META`；讀取函數沒有寫入；Scan 明確 Deny | 同左 |
| 種子（`services/shipment/seed/`） | 港口 10 個（E1）：DJJIB、KEMBA、COBUN、GTPRQ、PABLB、IDBLW、BRSSZ（Dev 測試批次）、TWKEL、TWKHH、VNSGN（`spike_only`）；座標 **World Port Index**（§2）；geofence 進 15 km／出 20 km；航線 8 條（自訂航點，直航，E8）；批次每 **28 天**一櫃（E2）；TW 批次沒有海運 | 同左 |
| 虛構識別碼（E10） | 船 `SIMV-01`～`24`、`Demo <鳥名>`；訂艙號 `BLDEMO…`；航次號 `D<nnn>E`；貨櫃號 `DMQU`＋6 碼＋ISO 6346 檢查碼（備用 `XBWU`）；smoke 船 `SIMV-98`／`99` | 同左 |
| Stack `brewline-dev-shipment`（P2b-2，module `shipment`） | 偵測函數 `brewline-dev-shipment-voyage-detector`（`BrewlineFunction`、保留併發 **1**、60 秒；非同步重試 2 → `shipment-dlq`）；規則 `brewline-dev-shipment-positions`（**預設 bus**：`aws.s3` `Object Created`、lake bucket、前綴 `raw/positions/`；重試 3／2 小時、DLQ＝`shipment-dlq`）；`shipment-dlq`（SSE-SQS、TLS、14 天）＋告警 `brewline-dev-shipment-dlq-not-empty` → `ops-alerts`；Glue 表 `brewline_raw.positions`（JSON SerDe、`ignore.malformed.json=false`、projection `source`〔`sim,ais`〕× `dt`〔`2026-11-21,NOW`〕、`synthetic=mixed`）；SSM `/brewline/dev/shipment/{dlq-arn,dlq-url,detector-function-name}` | `brewline-prod-shipment`（**終止保護**） |
| 偵測函數 IAM | `GetObject` 只限 `raw/positions/*`；KMS `Decrypt` 經 S3（加密內容＝bucket ARN）與經 DynamoDB；`Query` `VESSEL#*`；`GetItem`／`PutItem`／`UpdateItem` `SHIP#*`；邊（`LOT#*`、`VESSEL#*`）`UpdateItem` 且 `dynamodb:Attributes` 只限 `pk`、`sk`、`status`；Scan 明確 Deny；沒有 Delete、沒有 `events:PutEvents` | 同左 |
| Lake（E5） | bucket 以 L1 `NotificationConfiguration.EventBridgeConfiguration` 開啟（就地更新；**沒有** `Custom::S3BucketNotifications` Lambda） | 同左 |
| Events（E6） | stream 過濾 3 → **4**（`MODIFY`＋`entity=Shipment`）；既有發布函數把 `PLANNED→DEPARTED`、`DEPARTED→ARRIVED` 發成 `VesselDeparted`／`VesselArrived`（`source=brewline.shipment`）；detail 白名單 `event_id`、`occurred_at`、`shipment_id`、`lot_id`、`pol`、`pod`、`at`、`synthetic`（**不含**貨櫃號、訂艙號、船 ID）；bus 白名單不變 | 同左 |
| 模擬器（E3、E4） | 同一個 `simulator-run`：每小時那一輪加 `shipments` 段（`sim-roaster` 呼叫 `POST /admin/shipments`）；新排程 `brewline-dev-simulator-voyages` `cron(20,50 * * * ? *)` Asia/Taipei、payload `{"segment":"positions"}`、重試 0、DLQ＝`simulator-dlq`；寫入上一個 30 分鐘時間窗 `raw/positions/source=sim/dt=YYYY-MM-DD/HHmm.jsonl.gz`（空時間窗不寫）；`coordinates_status = provisional` 時拒絕訂艙與寫檔 | 同左 |
| 模擬器執行角色（新增） | `s3:PutObject` **只限** `raw/positions/source=sim/*`；`kms:GenerateDataKey` 經 S3＋加密內容＝lake bucket ARN；沒有 Get／Delete、不能寫 `source=ais/` | 同左 |
| 時間（E9、E12） | ×**24**（停泊 12 小時不壓縮）、`startDate 2026-11-23` | ×1、`startDate 2026-11-23`（不回補） |

- 部署順序：… → api → **lake** → **shipment** → simulator → trace（simulator 新增依賴 lake；`deploy.yml` 清單與驗證步驟一起改）。
- 偵測邏輯（`services/shipment/src/detector-core.ts`，純函數 `advance()`）：`PLANNED` 時在 POL 15 km 內 → `at_pol_seen`；之後超過 20 km → `DEPA`，`atd`＝最後一筆在 POL 內且航速 < 1 節的時間（沒有就用偵測時間）；`DEPARTED` 時在 POD 15 km 內且航速 < 1 節 → `ARRI`；ETA＝沿航點剩餘距離 ÷ 最近 6 小時平均航速（< 5 節用計畫航速）；航跡 Douglas–Peucker ≤ 200 點；以 `tracking.last_position_at` 去重；船對應貨運的時間窗＝計畫出發前 2 天到計畫抵達後 2 天。日誌不記座標。
- 一個交易：META（`version` 條件）＋事件項目（`attribute_not_exists`）＋`TRACK`＋狀態改變時的兩條邊。格式錯誤的檔案（任一行）→ 丟錯 → 重試 → `shipment-dlq`；沒有對應貨運的船 → 只計數。
- 航程（14–18 節，實際航點長度）：IDBLW→TWKEL 5.1–6.6 天、DJJIB→TWKHH 12.5–16.1、DJJIB→TWKEL 13.0–16.8、KEMBA→TWKEL 13.9–17.8、GTPRQ→TWKEL 20.1–25.8、PABLB→TWKHH 22.1–28.4、COBUN→TWKHH 22.2–28.5、BRSSZ→TWKHH（Dev 測試）25.7–33.0 天（規格原寫 15–40 天）。
- 告警：每環境 11 → **12**；組織合計 **24**（§5）。
- 費用（估）：每環境每月約 USD 0.15（告警 0.10；S3 PUT／GET、Lambda、DynamoDB 在免費額度內或 < USD 0.05）。

已驗證：
- **P2b-1**（2026-11-21，merge `b655e7a`，Deploy run `44873959222`）：**Dev ✅ 625、Prod ✅ 619、0 ❌**；Dev smoke 147/147（新增 19 項訂艙檢查）；`verify-api-stack.sh` 22 條路由、訂艙函數政策模擬 9 項（含覆寫 `LOT#` META → `implicitDeny`）。V1 dry-run（Developer／Admin）：Dev 2026-11-30 → 6 筆訂艙、508 個位置點；Prod 2026-12-15 → 1、192；雜湊＝本機計算值。
- **P2b-2**（merge `56f8787`，run `44914048557`）：Dev ✅ 689、**❌ 1**（`Detector env LAKE_BUCKET = null`，見教訓）→ Prod 自動跳過。**#85**（merge `915ad92`，run `44916510338`）：**Dev ✅ 689、Prod ✅ 683、0 ❌**（環境變數改為 ℹ️）。
  - `verify-shipment-stack.sh`（新）：函數設定、保留併發 1、非同步重試 2 → DLQ；規則在預設 bus、pattern（bucket、前綴）、目標、DLQ、重試 3；DLQ SSE-SQS／TLS／0；告警接上；帳號告警 ≤ 13（12）；Glue 表；政策模擬正向 6（讀位置檔、KMS 經 S3、`Query VESSEL#`、`SHIP#` 讀寫、邊只改 `status`）、反向 10（讀 `raw/events/`／`curated/`、寫位置檔、KMS 直接解密、`Query TENANT#`、改邊的其他欄位、`PutItem LOT#`、`DeleteItem`、Scan〔explicitDeny〕、`PutEvents`）。
  - `verify-lake-stack.sh`：`EventBridge notifications = true`；`verify-events-stack.sh`：過濾 4、`Shipment filter present`；`verify-simulator-stack.sh`：新排程 7 項、執行角色正向 1（`source=sim`）＋反向 4（`source=ais`、`raw/events/`、Get、Delete）。
  - 手動（Dev Admin，2026-11-21 23:3x）：環境變數 `LAKE_BUCKET`＝lake bucket（反向：不存在的變數 → `None`）；V1 dry-run 改用 WPI 座標後 Dev `711e4977…ac1b`（6、508）、Prod `3003ebf2…eb45`（1、192）＝本機計算值（訂艙與筆數同 P2b-1，只有座標改變）；手動 `{"segment":"positions"}` → `records 0`、`written false`（`startDate` 之前）；`raw/positions/` 0 個物件；`shipment-dlq`、`simulator-dlq` 皆 0（Dev、Prod）。
  - 2026-11-23 09:40（Dev Admin）：當天 08:05、09:05 兩輪 `shipments` 皆 `due 0`、`created 0`、`violations []`；`VESSEL#SIMV-15` 0 筆（第一筆 17:32 才開放訂艙）。
  - **V8**（2026-11-23 09:51，Dev Developer）：寫 `raw/positions/source=sim/…` → `AccessDenied`（`no identity-based policy allows`）；對照組寫 `raw/_smoke/…` → 成功。
  - **V7**（2026-11-23，Dev Admin）：09:51:58 上傳第 2 行不是 JSON 的 `…/dt=2026-11-23/v7-bad-test.jsonl.gz`（第 1 行是沒有貨運的 `SIMV-97`）→ 偵測函數 3 次錯誤 `line 2 is not JSON`（09:51:59、09:52:57、09:54:48，同一個 requestId＝非同步重試 2 次）→ `shipment-dlq` 1 → 約 10:05 告警 `ALARM`、收到 ALARM 信 → `purge-queue`、刪除測試檔（`raw/positions/` 目前版本 0 個）→ 10:21 `OK`。從上傳到告警約 13 分鐘（重試約 3 分鐘＋SQS 指標與 5 分鐘評估）；錯誤日誌不含內容。

#### 運行觀察 / Operational Observation（Dev，進行中）

| 里程碑 | 計畫（台北時間，產生器計算） | 實際 |
|---|---|---|
| 第一筆訂艙 | 11-23 18:05（L-2026-004、SIMV-15）、19:05（L-2026-001、SIMV-06） | ⏳ |
| 第一個位置檔 | 11-24 約 18:20（SIMV-15 進港停泊） | ⏳ |
| 第一個 `DEPA`／`VesselDeparted` | 11-25 約 06:20（SIMV-15，ETD 05:32） | ⏳ |
| 第一個 `ARRI`／`VesselArrived` | 11-25 約 20:20（SIMV-06，ETA 19:45） | ⏳ |
| Prod 第一筆訂艙（P1） | 11-29 08:05（L-2026-004、SIMV-14，11-28 22:31 開放，夜間沒有輪次） | ⏳ |
| Prod 第一個 `DEPA`／`ARRI` | 12-06 約 11:20（SIMV-14，ETD 10:31）／12-27 約 02:20（SIMV-05，ETA 02:03） | ⏳ |

教訓 / Lessons：
- （2026-11-21）**唯讀驗證角色看不到 Lambda 環境變數的值**（回傳 `null`）。A4d 的 `verify-notify-stack.sh` 已有同樣處理，新腳本沒有沿用 → Dev 驗證失敗、Prod 跳過（#84 → #85）。驗證「強制的控制」（IAM 政策模擬）而不是「設定值」；設定值只在看得到時判定，看不到印 ℹ️。新寫驗證腳本前先 `grep` 既有腳本的同類檢查。
- （2026-11-21）**冪等鍵不含座標，但內容（`planned_arrival`）由座標決定**：開始訂艙後改座標 → 同一個鍵內容不同 → 422 → 違規告警。因此暫定座標時模擬器拒絕訂艙與寫檔（`coordinates_status`），換成 WPI 後才啟動。
- （2026-11-21）設定 schema 變嚴格時注意部署順序：SSM `config` 多了 `voyages` → `configParam.node.addDependency(runFn)`（函數先更新，舊程式不會讀到新設定）；單元測試斷言依賴存在。
- （2026-11-21）回放測試的離港時間：「第一筆在 20 km 外」比實際離港晚 40–90 分鐘（Prod 只有 70% 在 1 小時內）→ `atd` 改用最後一筆停泊在 POL 內的時間 → Prod 24/24、Dev ×24 57/60 在 1 小時內。
- （2026-11-21）CDK L2 `eventBridgeEnabled` 會加 custom resource Lambda → 用 L1 屬性；單元測試斷言沒有 `Custom::S3BucketNotifications`。
- （2026-11-21）WPI 網站維護中（HTTP 503），但官方維護頁仍提供完整檔案 → 以 Chester 的瀏覽器下載、記錄 Last-Modified 與 sha256；工作區的 shell 被代理擋下時不改用其他方法繞過。
- （2026-11-21）航線用粗略陸地框抽樣檢查，抓到初版蘇門答臘北端航點穿過陸地。
- （2026-11-21）asset hash 依整個 `services/` 計算 → 每個 Lambda 在 diff 都顯示 `S3Key` 變更；比較 template 時把 64 位十六進位雜湊正規化，只看真正的資源差異。

## 11. 新增與修訂的決策 / New & Revised ADRs

| ADR | 標題 | 狀態 | 決策摘要 |
|---|---|---|---|
| ADR-008 | 安全服務範圍 | Proposed → 待 2026-12-04 定案 | GuardDuty 全帳號（台北＋us-east-1，只開 S3 保護於台北）；Security Hub CSPM 只 Prod（FSBP）；Config 只 Prod（連續）＋ Dev（每日）、8 種類型；管理帳號 EBS Malware 例外（§7） |
| ADR-009 | 主要區域 | **Accepted** | ap-east-2；28 項服務 27 項可用；例外見 §2 |
| ADR-013 | Identity Center 單一區域 | Accepted | 不用多區域（需多區域 KMS CMK，約 USD 24/年）；區域故障時以 break-glass 登入 |
| ADR-014 | CloudTrail 用 SSE-S3 | Accepted | KMS 每檔一次請求持續計費；保護來自跨帳號存放＋Object Lock＋SCP |
| ADR-015 | Security Hub CSPM 用本機組態 | Accepted | 台北不支援 finding aggregator；改用 us-east-1 當主區域會把政策套到 us-east-1、造成 Config 未啟用的失敗項 |
| ADR-016 | CDK cfn-exec 使用預設 Admin | Accepted | 作品集取捨；SCP 為防護欄；正式環境應改自訂最小權限 |
| ADR-017 | 步驟 5–12 以主控台／CLI 手動建置 | Accepted | 為學習目的偏離 P-04；未來可再以 CDK 匯入或重建 |
| ADR-018 | 共用資料層：每帳號 1 把 CMK + DynamoDB 單表（TableV2） | Accepted（2026-11-11） | 見 §10.5 與 docs/14；鍵 `pk`/`sk`；GSI 逐一新增、Streams 於 A3a 開啟；SSM 取代 Export；自訂 `DataProtectionChecker` 補 cdk-nag 缺口 |
| ADR-019 | Dev 也開 PITR | Accepted（2026-11-11） | 費用約 0、不需例外、可在 Dev 練習還原；取代 02 §3 |
| ADR-020 | A1 不掛 WAF，改以分層限流 | Accepted（2026-11-12） | 登入／註冊走 Cognito 端點、execute-api 可繞過 CloudFront → CloudFront WAF 無效；regional WAF 每年約 USD 190。改以不開放註冊、JWT、scope、限流、保留併發、DynamoDB 上限、Budget Actions；前端時改 CloudFront＋WAF（§10.7） |
| ADR-021 | API 類型：HTTP API | Accepted（2026-11-12） | 較便宜、內建 JWT＋scope；無法直接掛 WAF、無每租戶限流（ORD-N-003 待 A2）（§10.7） |
| ADR-022 | 身分層：Cognito Essentials、scope 授權、`custom:tenant_id` | Accepted（2026-11-12） | pre token V2 群組→scope、tenant_id claim；MFA OPTIONAL＋TOTP；不開放註冊（§10.6） |
| ADR-023 | Node 24：本機、CI、Lambda 一致 | Accepted（2026-11-12；**2026-11-17 修訂**） | Lambda `nodejs24.x`（淘汰 2028-04-30）；`.nvmrc`、`engines`、`@types/node` 改 24；取代 status §10.3 的 Node 22。**修訂**：aws-cdk-lib 2.277.0 認得 `nodejs26.x`，cdk-nag `AwsSolutions-L1` 因此判定 Node 24 違規；`nodejs26.x` 在 Lambda 仍是公開預覽版（無 SLA、不建議正式環境，GA 須等 Node 26 進入 Active LTS）→ 維持 Node 24，以 `LATEST_RUNTIME_ACK` acknowledge（`BrewlineFunction` 與 CDK provider 框架函數）；GA 後評估升級並移除例外 |
| ADR-024 | 租戶隔離：STS session tag ＋ `LeadingKeys` 完全比對 | Accepted（2026-11-13） | 訂單函數（`brewline-<env>-orders-*`）帶 `tenant_id` 扮演 `brewline-<env>-tenant-access`；商品只能改庫存欄位；Scan 明確 Deny（§10.8） |
| ADR-025 | 下單交易與冪等 | Accepted（2026-11-13） | 冪等記錄＋訂單＋扣庫存在同一個交易；sk `ORDER#<ULID>`；伺服器端定價；≤ 25 個商品、1–500 kg；路由限流（§10.9） |
| ADR-029 | 通知、聯絡人與定期補貨（A4 決策） | Accepted（2026-11-16） | Route 53 網域＋SES DKIM／MAIL FROM／DMARC；聯絡人欄位以 KMS＋encryption context 加密；SNS 用 CMK（key policy 授權服務）；每租戶一位聯絡人；只在建立／確認／出貨／取消寄信；Scheduler 定期補貨（§10.12–§10.15）；**A4 全部完成** |
| ADR-028 | 未確認訂單的逾時取消（Step Functions） | Accepted（2026-11-13） | OrderCreated → Standard 工作流等待（Dev 10 分／Prod 48 小時）→ 仍是 CREATED 就取消並釋放；冪等靠條件寫入（§10.11） |
| ADR-027 | 訂單狀態機與 staff 端點 | Accepted（2026-11-13） | 狀態以 DynamoDB 為準；一個交易＝訂單（樂觀鎖：原狀態）＋庫存；staff 函數不扮演租戶角色、無 Put／Delete（§10.9） |
| ADR-026 | 事件層：Streams → Lambda → EventBridge | Accepted（2026-11-13） | 台北沒有 Pipes／Archive；自訂 bus、白名單 detail、`event_id` 去重、Logs 規則留存、DLQ SSE-SQS（§10.10） |
| ADR-031 | 溯源（docs/04）範圍與設計（S2 決策 D1–D9） | Accepted（2026-11-18） | D1 S2＝生豆批次（8 個種子）＋烘焙批次＋QR＋公開頁＋staff 追溯＋召回＋模擬烘焙廠；航程（SHP）、天氣（PRC）、換批、召回寄信延後。D2 公開頁＝S3 預先產生的白名單 JSON 投影（事件觸發），讀取路徑沒有 Lambda／API／DynamoDB。D3 CloudFront 統一費率 **Free 方案**（WAF＋IP 速率限制＋DDoS，`AWS::PricingPlanManager::Subscription`）；快取用 `Cache-Control: max-age=300`；不合格時退回 pay-as-you-go 不掛 WAF。D4 us-east-1 `edge`（ACM、CLOUDFRONT web ACL）→ config → 台北 `trace`（bucket、OAC、distribution、方案訂閱）；describe-type 實測台北可建 Distribution／Subscription、不能建 ACM。D5 鄰接清單，不加 GSI2。D6 `brewline/roastery` scope＋`simulator-roastery` 群組，伺服器端 synthetic 保護。D7 補貨（樂觀鎖）。D8 模擬操作員節奏（同一輪確認 90%、16:05 排烘、隔天烘焙／出貨、2 天後完成）。D9 QR 128-bit、召回 admin only（§10.17）。**2026-11-20 全部實作完成**（S2a–S2d，§10.17–§10.20） |
| ADR-032 | P2 資料設計（D1–D12）與資料湖基礎 | Accepted（2026-11-20；P2a、P2a-2、P2b 已實作） | D1 公開頁海運旅程用模擬航程（真實港口、虛構船名與貨櫃號、`demo`）；D2 aisstream 只在 Dev spike 7 天、不進 Prod；D3 raw → curated 用 Athena UNLOAD（Step Functions Standard，先清分區）；D4 Glue 由 CDK 定義、partition projection、不用 crawler、不開 Lake Formation；D5 SSE-KMS 沿用資料層 CMK＋Bucket Key；D6 訂單事件經 Firehose 進 `raw/events/`；D7 專用 workgroup（強制設定、Prod 1 GB／Dev 100 MB）；**D8（修訂）每模組一個 DLQ＋告警**（lake／shipment／procurement）；D9 aisstream spike 每 30 分、256 MB、120 秒；D10 儀表板預先計算；D11 溯源頁航跡同源 SVG；D12 EDI（IFTSTA）依 UNECE 公開目錄自行設計。另：Glue 目錄不加密（帳號層級單例）；bucket policy 用 `Null`＋`StringNotEquals`；`describe-type` 判讀規則（§2）。P2a-2：input transformer 結尾 `\n`（Dev 實測通過）、只收兩種訂單事件、不新增告警、Bucket Key 的 KMS 加密內容＝bucket ARN。**P2b 補充 E1–E12（2026-11-21，已實作）**：港口依批次補為 10 個（TW 沒有海運）、只做直航、每批次 28 天一櫃、訂艙走公開 API、位置寫 `raw/positions/source=sim/`、同一個 run 函數＋30 分排程、S3 → EventBridge（L1）、Streams 發布 `Vessel*`、DCSA T&T 2.2.0 只做 `DEPA`／`ARRI`、Dev ×24、虛構識別碼（`DMQU`）、ETA、不回補。詳見 docs/14（§10.21、§10.22） |
| ADR-030 | 模擬器（docs/07）範圍與設計（S1 決策 D1–D9） | Accepted（2026-11-17） | D1 S1＝租戶＋訂單＋重複下單異常；生豆／烘焙批次 → S2（溯源），貨櫃／DCSA／IFTSTA／EDI 異常 → S3（P2）。D2 專用 `simulator` app client（`ADMIN_USER_PASSWORD_AUTH`）＋每人隨機密碼存 SSM SecureString（CMK）；pre token 限制此 client 只發 scope 給 `simulator` 群組。D3 部署時 custom resource 建 40 個使用者（先啟用 30，每月依日期啟用 1–2）；執行函數只有 `AdminInitiateAuth`。D4 Dev、Prod 都跑（Prod 每天 5–40、Dev 2–6；每筆 1–3 個商品 × 1–5 kg；跳過庫存偏低）；首次部署 `paused`。D5 S1 不推進訂單（逾時取消），S2 再設計烘焙廠操作員。D6 `synthetic: true` 由伺服器依 `cognito:groups` 標記於訂單與事件。D7 `state` 參數只在首次建立時寫入（Dev 可由 Developer 切換）、`config` 由 CDK 管理；`scp-budget-lockdown` 加 `cognito-idp:AdminInitiateAuth`。D8 台北 08:05–19:05 每小時；冪等鍵＝hash(種子, 日期, 小時, 序號)；重現性以 dry-run 計畫雜湊驗證。D9 不建自訂指標；預期失敗即函數錯誤 → `Errors` 告警；每帳號告警 ≤ 10。前置：S0（RSK-017）完成。**D9 修訂（2026-11-20）**：CloudWatch 告警免費額度 10 個是**全組織**共用（含管理帳號；Free Tier 頁 `Global-CW:AlarmMonitorUsage` 實測），每帳號 ≤ 10 的前提不成立 → 改為管控組織總數、告警費預算 ≤ USD 2／月、每環境 ≤ 13（P2 每模組一個 DLQ 告警，ADR-032 D8）；**不合併 DLQ**（§10.20） |

| 風險 | 內容 | L | I | 緩解 |
|---|---|---|---|---|
| RSK-014 | 無 WAF，惡意流量只能靠限流與預算控制；execute-api 網址可被直接呼叫 | M | L | ADR-020 的分層控制；前端上線時加 CloudFront＋WAF，評估關閉 execute-api 預設端點 |
| RSK-015 | 撤銷的帳號在 access token 到期前（≤ 15 分）仍可呼叫 API；staff MFA 無法由 Cognito 強制 | M | M | Token **15 分鐘**（A2a，原 60 分）；部署後驗證偵測 staff 未設 TOTP；A2 起高風險操作在 Lambda 再查使用者狀態 |
| RSK-016 | A3 之前已預留的庫存不會自動釋放；單筆最多預留 500 kg，可能佔滿某商品 | M | M | 不開放註冊；路由限流；**A3c staff 可取消、A3d 未確認訂單自動取消並釋放（Dev 10 分／Prod 48 小時）**；剩餘：48 小時內仍可佔住庫存 |
| RSK-017 | 自訂 bus 沒有資源政策：同帳號內有 `events:PutEvents` 的身分可偽造 `brewline.ordering` 事件（例如假的 `OrderCreated` 會啟動逾時工作流，但取消前會讀 DynamoDB，影響有限） | L | M | **已緩解（S0，2026-11-17）**：bus 資源政策 Deny 白名單以外的 `PutEvents`（§10.10）。剩餘：SSO Admin 與 CloudFormation 執行角色（可改政策）仍可發布 |
| RSK-018 | 模擬器帳號 custom resource 有 `AdminCreateUser`／`AdminSetUserPassword`／`AdminAddUserToGroup`（IAM 無法依群組或使用者限制）：能修改此函數或其角色的身分，理論上可以重設 staff 密碼或把帳號加進 staff | L | M | 函數只由 CloudFormation provider 呼叫；修改需要 CI 部署或 Admin；Developer 只在 Dev 且不能改 Lambda／IAM；執行中的模擬器函數**只有** `AdminInitiateAuth`（S1b，政策模擬驗證）；P2b 起另有 `s3:PutObject` 只限 `raw/positions/source=sim/*`（不影響 Cognito 權限，政策模擬驗證不能寫 `source=ais/`、`raw/events/`，不能讀或刪）；`verify-simulator-stack.sh` 檢查模擬帳號不在 staff 群組 |
| RSK-019 | 公開溯源頁若輸出錯誤欄位，可能洩漏租戶或訂單資訊 | L | M | 公開資料只來自寫入時的白名單投影（S2c，以建構而非刪減實作、單元測試搜尋內部欄位）；租戶角色讀不到 `ROAST#`／`LOT#`；公開讀取路徑沒有資料庫權限；驗收搜尋租戶 ID、Email 結果為 0 |
| RSK-013 | 主要區域無 Macie，無法自動偵測 S3 中的個資 | L | L | 個資只存 DynamoDB；DATA-011/012 設計層預防；資料湖 DQ 檢查加入 Email／電話格式偵測 |

---

## 12. v0.1 文件需要修改的地方 / Required Updates to v0.1 Docs

| 文件 | 修改 |
|---|---|
| 01 §3 | 帳號結構加入 Workloads › Prod、Dev 子 OU |
| 01 §8 | 主要區域改 ap-east-2；DR 改 ap-northeast-1；刪除「台北列為評估項目」 |
| 02 §1 | 步驟 5–12 改為主控台／CLI 手動（ADR-017）；步驟順序 9 → 10 → 9b（Security Hub 在 Config 之後） |
| 02 §7 | 演練區改 ap-northeast-1，加入「演練前暫時修改 `scp-region-restrict`」 |
| 09 §3.2 | 「Bucket policy 拒絕非 TLS」改為「由 RCP `EnforceS3Tls` 統一處理」 |
| 09 §5 | GuardDuty、Security Hub、Config 依 §7–§9 更新；Macie 改「不啟用」；Access Analyzer 可用 |
| 10 §4.2 | 改為 §4 的實際政策；合併 `scp-baseline`；Root 4/5 |
| 11 §3.2 | COST-020 告警閾值依實際；分帳號預算以 CLI 建立；Email 驗證要求 |
| 11 §3.3 | Budget Actions 實際設定；「下週期自動解除」改為待實測 |
| 12 §2 | `pii` 控制移除「Macie 一次性掃描」 |
| 13 §4 | 新增 RB-SEC-03 break-glass；RB-COST-01 解除方式；RB-DR-01 區域 SCP 調整 |
| 13 §6 | 每季加入 break-glass 測試 |
| 14 | 加入 §11 的 ADR 與 RSK-013（ADR-018、ADR-019 已加入，PR #6；ADR-030、ADR-031、ADR-032 於 2026-11-20 加入） |
| 02 §3 | Dev PITR 改為開啟（ADR-019） |
| 02 §4 | CDK 結構改為 `infra/app/{bin,lib/stacks,lib/aspects,scripts,test}` |
| 09 §3.1 | 加註：使用 `TableV2`；Streams `NEW_AND_OLD_IMAGES`（A3a）；GSI 依模組逐一新增 |
| 09 §2.4 | 台北沒有 **Archive and replay** → 以 Logs 規則留存；DLQ 用 SSE-SQS（ADR-026） |
| 01 §5 | Streams → EventBridge 改為 **Lambda 發布**（台北沒有 Pipes，ADR-026） |
| 09 §4.2 | SNS 主題改為每環境 `brewline-<env>-ops-alerts`（CMK 加密）；Email 訂閱手動建立、不進 IaC（A4b） |
| 09 §2.3 | Step Functions「Catch 後發布 `WorkflowFailed`」→ `Fail` 狀態＋失敗告警＋規則 DLQ（A3d，ADR-028） |
| 03 §3 | ORD-F-005 狀態流轉由 staff API 推進（ADR-027），Step Functions 只負責逾時取消（ADR-028），不是整個流程都在 Step Functions |
| 03 §6 | GSI1 改為**多用途**（`gsi1pk`／`gsi1sk`）：商品 `CATALOG`／`PRODUCT#<id>`、訂單 `STATUS#<status>`／`<created_at>#<order_id>`（ADR-018 修訂）；訂單 sk `ORDER#<ts>#<id>` → **`ORDER#<ULID>`**；新增冪等項目 `IDEMP#<key>`（ADR-025） |
| 03 §3 | ORD-F-004 不使用 Lambda Powertools Idempotency，改為同一交易內的冪等記錄（ADR-025） |
| 03 §11 | 跨租戶存取回 **404**（不是 403），證據為應用層日誌＋IAM 探測（A2 決策 D4），不依賴 CloudTrail 資料事件 |
| 09 §5、11 §2 | KMS 輪替費用：第一、二次輪替各 +USD 1／月，每把上限 USD 3／月 |
| 03 §10 | 「聯絡人欄位以 CMK 加密」釐清為表層級 SSE（已完成）＋欄位層級（A2 決定） |
| 03 §10、09 §1.2 | API Gateway **HTTP API 不能直接掛 WAF**；登入／註冊限流改由 CloudFront 或 Cognito user pool WAF（A1 決定） |
| 03 §5 | 租戶角色另需 `dynamodb:ConditionCheckItem`（TransactWriteItems）；信任政策需 `sts:TagSession`；`LeadingKeys` 範例的 `TENANT#${tenant_id}*` 結尾 `*` 會讓 `t_1` 存取 `t_12…` → 改 `StringEquals` 完全比對（**已完成**，ADR-024、§10.8） |
| 03 §4 | ORD-N-003「每租戶 10 req/s」HTTP API 無法原生達成（ADR-021）→ A2 決定 |
| 03 §7 | 新增 `GET /admin/products/{id}/stock`（staff）；cafe 回應只有 `stock_status`，不含公斤數；`api/openapi.yaml` 已建立 |
| 09 §1.2、03 §10、10 SEC-050 | 「登入與註冊 WAF 速率規則」改為 ADR-020 的分層控制 |
| 09 §1.3 | Lite → **Essentials**；「staff 強制 TOTP」→ OPTIONAL＋偵測性檢查；威脅防護不開（需 Plus，FSBP `Cognito.1` 預期失敗） |
| 09 §2.1 | CORS：A1 不開；前端改走 CloudFront 同網域 |
| 09 §2.2 | Node 24（ADR-023）；保留併發 Dev 5／Prod 10（API）；CodeDeploy canary 延後 |
| 04 | 依 ADR-031：公開頁改 S3 靜態投影（不經 API Gateway／Lambda）；WAF 來自 CloudFront Free 方案；GSI2 改鄰接清單；QR 對應不另存 `QR#`（存在批次上）；TRC-F-004／005 延後；新增 `/admin/roasts*`、`/admin/products/{id}/restock`、`GET /admin/trace?…`（取代 `/admin/trace/{type}/{id}`） |
| 06 §4、§7 | aisstream 取樣改為每 30 分、256 MB、連線 120 秒（ADR-032 D9）；SHP-N-003 新鮮度 ≤ 35 分；公開頁旅程改用模擬航程（D1）；aisstream 只在 Dev spike（D2） |
| 05 PRC-F-002 | raw → curated 改用 **Athena UNLOAD**（Step Functions），取代 pyarrow（ADR-032 D3） |
| 09 §3.4 | Firehose 只用於訂單事件（ADR-032 D6）；Glue 由 CDK 定義＋partition projection，不用 crawler（D4） |
| 12 DS-01、DS-09、DS-10 | DS-01 aisstream 改「部分查證」：官方 2023 留言表示目前無使用限制、無 SLA、無正式條款；只有岸基 AIS，非洲／南美覆蓋弱；DS-09 UN/LOCODE 授權不明確 → 只用 7 個代碼並註明出處；DS-10 World Port Index 為美國政府作品、公有領域 |
| 11 COST-021 | Dev 月預算 USD 5 → **10**（2026-11-20，§5） |
| 11、ADR-030 D9 | 「每帳號告警 ≤ 10 免費」改為「免費 10 個是全組織共用；告警費 ≤ USD 2／月、每環境 ≤ 13」 |
| 07 | 依 ADR-030 分階段：S1 租戶＋訂單＋重複下單；生豆／烘焙批次 → S2（溯源）；貨櫃、DCSA、IFTSTA、EDI 異常、`S3 edi/inbound` → S3（P2）。SIM-F-001 不建聯絡人（simulator 沒有 profile scope）；帳號部署時建立、依日期啟用（取代執行時新增）；SIM-F-010 改為訂單項目的 `synthetic: true`（伺服器依 JWT 判定）；SIM-N-001 開關「下一輪生效」；docs/11「預測 100% 自動暫停」改為 `scp-budget-lockdown` 擋 `AdminInitiateAuth`；服務清單去掉 S3／DynamoDB 直接寫入（S1） |
| 06 §3 | 港口改為 10 個（ADR-032 補充 E1）：出口 DJJIB、KEMBA、COBUN、**GTPRQ**、**PABLB**、**IDBLW**（依生豆批次產地）、BRSSZ（只給 Dev 測試批次）；進口 TWKEL、TWKHH；VNSGN 只給 P2b-spike；TW 批次沒有海運；座標取自 WPI（§2） |
| 06 §4 | 流程改為：模擬器每 30 分寫 `raw/positions/source=sim/`（真實 AIS 只在 P2b-spike 寫 `source=ais/`）→ S3 → EventBridge（預設 bus）→ 偵測函數**直接讀 raw JSON**（沒有 Transform Lambda、Parquet 等 P2e 的 curate 工作流）→ DynamoDB → Streams → `VesselDeparted`／`VesselArrived`（§10.22）；SHP-F-001 每 15 分 → 30 分（D9）、SHP-F-003 去重改由偵測器的 `last_position_at` |
| 06 §8 | `SHIP#<voyage_id>` 改為 `SHIP#<shipment_id>`（**貨運**＝一筆訂艙搭一個航次；航次號是屬性）；不用 MMSI，改 `vessel_id = SIMV-nn`；新增邊 `LOT#…/SHIP#…`、`VESSEL#…/VOY#…`（不加 GSI）；運輸事件依 DCSA T&T 2.2.0（只有 `DEPA`／`ARRI`）；航程 **5–30 天**（直航實際值，規格原寫 15–40 天） |
| 07 SIM-F-004–006 | SIM-F-004 改為「模擬航程」：虛構船名、決定性種子、每批次 28 天一櫃，訂艙經公開 API（不是附在真實航次上，ADR-032 D1）；SIM-F-005 擁有者代碼 `DMQU`（BIC 公開查詢查無）；SIM-F-006 P2b 只產生位置，偵測器產生 `DEPA`／`ARRI`，設備事件（gate-in、裝船、卸船、gate-out）延到 P2d（IFTSTA） |
| 12 DS-09、DS-10 | DS-09 UN/LOCODE：只用種子檔的 10 個代碼，並以 WPI 的 UN/LOCODE 欄位交叉比對；DS-10 WPI：實際取得版本與 sha256 記在 §2 與 `ports.json` |

---

## 13. 待辦 / Open Items

| 時間 | 事項 |
|---|---|
| ✅ 2026-11-20 | 確認 5 個預算收件人 Email 皆為 Verified（主控台預算詳細頁，§5） |
| ✅ 2026-11-19 | 查看 Prod FSBP 分數：86% → 整理後 **100%**（§9） |
| ✅ 2026-11-20 | 管理帳號舊資源盤點與清理：S3 bucket 0、台北 Glue 資料庫 0；終止停機的 `ml-api-server` 並清理 SG、IAM 角色／profile、key pair、2 個告警（§7） |
| ✅ 2026-11-20 | Dev 月預算 USD 5 → 10（§5） |
| ✅ 2026-11-20 | P2a 資料湖基礎部署 Dev、Prod；Developer 許可集新增 Athena／Glue／lake；手動 T1–T7 通過（§3、§10.21，PR #78） |
| ✅ 2026-11-20 | P2a-2 訂單事件 → Firehose → `raw/events/` 部署 Dev、Prod；Dev M1–M4（換行 14＝14＝14）、Prod M5（31＝31，全部 synthetic）通過；驗證腳本修正 #81（§10.21，PR #80、#81） |
| ✅ 2026-11-20 | WAF 帳單確認：Free 方案訂閱後不再按時計費（§10.19） |
| 有空時 | break-glass 第二個 MFA 裝置、紙本備份 |
| 有空時 | 手動建立的預算日後改由 CDK 管理（或匯入） |
| **2026-12-04** | 試用期決策點：GuardDuty、Security Hub CSPM 用量頁；確認管理帳號 EBS Malware 費用為 0；依 11 §7 定案 ADR-008；**依 12 月實際費用評估降低 Dev AWS Config 費用**（排除 `AWS::Lambda::Function` 或關閉 Dev Config） |
| ✅ 2026-11-10 | `.gitignore` 補強；`infra/app` 初始化；PR／Deploy workflow；pipeline-check stack 驗證 Dev、Prod 整條管線（§10.4，PR #1） |
| ✅ 2026-11-10 | ruleset required status check `checks`；`.github/dependabot.yml` |
| ✅ 2026-11-10 | 本機 `D:\brewline` 改為 `git clone` GitHub repo |
| ✅ 2026-11-17 | 處理 Dependabot 更新 PR：#48（aws-cdk 群組）、#55（aws-sdk 群組），逐一合併並部署 Dev、Prod（§10.16 教訓）；之後每週照同樣方式處理 |
| ✅ 2026-11-11 | 共用資料基礎：`brewline-<env>-data` 部署 Dev、Prod 並驗證（§10.5，PR #6） |
| ✅ 2026-11-11 | 決定：OIDC 角色**不**由 workload app／CI 管理；之後另建 `infra/landing-zone` app，以 `cdk import` 匯入，由 Admin 本機部署（可選：`scp-baseline` 加 Sid 禁止非 SSO Admin 修改 `gha-*` 角色） |
| ✅ 2026-11-11 | Prod Config 記錄 `brewline-prod-core`（`AWS::DynamoDB::Table`，合規） |
| ✅ 2026-11-11 | FSBP `DynamoDB.2`、`DynamoDB.6` 通過；`KMS.4` 不在 FSBP，由 cdk-nag＋驗證腳本涵蓋 |
| ✅ 2026-11-11 | ReadOnly 許可集加上 `SecurityAudit`，正向＋反向驗證通過（§3） |
| ✅ 2026-11-11 | 建立 `Developer` 許可集，只指派 brewline-dev，正向＋反向驗證通過（§3） |
| ✅ 2026-11-12 | Node 24（PR #12，ADR-023）；訂貨 A1a：GSI1 部署 Dev、Prod 並驗證（§10.5，PR #13、#16） |
| ✅ 2026-11-13 | Lambda 併發配額：Dev、Prod 原為 **10**（新帳號預設），2026-11-12 申請 1000（Service Quotas `L-B99A9384`）→ 轉 Support 案件（`CASE_OPENED`）→ 2026-11-13 `CASE_CLOSED`，`get-account-settings` 實際值 **1000／Unreserved 1000**（兩個帳號）。A1b、A1c 需求 Dev ≥ 122、Prod ≥ 141 |
| ✅ 2026-11-13 | 訂貨 A1b 身分層（§10.6，PR #14）、A1c 商品唯讀 API（§10.7，PR #15、#18）部署 Dev、Prod 並驗證 |
| ✅ 2026-11-13 | Prod Config 記錄類型 8 → 57（`Config.1` 要求）；`Cognito.1` SUPPRESSED（ADR-022）；發現台北 Config 無法記錄 IAM、ApiGatewayV2（§2、§8、§9） |
| ✅ 2026-11-19 | `Config.1` 重新評估：`PASSED`，不需要 SUPPRESSED（§9） |
| ✅ 2026-11-13 | A2 決策：每租戶限流 → 只做路由限流並接受限制（D3）；聯絡人欄位層級加密 → 延到 A4（D5）；`LeadingKeys` 完全比對 → A2a 完成 |
| ✅ 2026-11-13 | 訂貨 A2a：租戶存取角色、訂單 scope、token 15 分鐘，部署 Dev、Prod 並驗證（§10.6、§10.8，PR #20、#21） |
| ✅ 2026-11-13 | 訂貨 A2b-1：訂單 API 部署 Dev、Prod 並驗證（§10.9，PR #23） |
| ✅ 2026-11-13 | 訂貨 A2b-2：Dev 訂單測試（冪等風暴、搶庫存、IAM 探測）17/17（§10.9，PR #25）；**A2 完成** |
| ✅ 2026-11-13 | A3 決策：D1 Streams → Lambda → EventBridge；D2 狀態以 DynamoDB 為準、Step Functions 只做逾時取消；D5 逾時 Dev 10 分／Prod 48 小時；D6 咖啡廳自行取消延後；D7 先建告警、通知待 A4 |
| ✅ 2026-11-13 | 訂貨 A3a Streams（§10.5，PR #27）、A3b 事件層（§10.10，PR #28、#29）部署 Dev、Prod 並驗證 |
| ✅ 2026-11-18 | Developer 許可集加上 EventBridge、Step Functions、SQS、Scheduler 唯讀與 `cloudformation:DescribeType`（台北限定），正向＋反向＋政策模擬驗證（§3） |
| ✅ 2026-11-13 | 訂貨 A3c：staff 端點＋狀態機部署 Dev、Prod 並驗證（§10.9，PR #31） |
| ✅ 2026-11-16 | 訂貨 A3d：逾時取消工作流部署 Dev、Prod；Dev 端到端通過（§10.11，PR #33、#34）；**A3 完成** |
| ✅ 2026-11-16 | A4 決策 D1–D7（ADR-029）；A4a key policy（PR #36）、A4b 維運通知（§10.12，PR #37）部署 Dev、Prod；Dev 端到端通過；Dev／Prod Email 訂閱已確認 |
| ✅ 2026-11-16 | A4c 聯絡人＋欄位層級加密（§10.13，PR #39）部署 Dev、Prod；Dev smoke 68/68、訂單測試 25/25 |
| ✅ 2026-11-16 | 網域 `brewline-demo.click` 註冊完成（ACTIVE、隱私保護、自動續約）；A4d 訂單通知信（§10.14，PR #41–#43）部署 Dev、Prod；Dev 端到端 4 封信＋逾時 4/4 |
| ✅ 2026-11-18 | 網域聯絡人驗證：`get-contact-reachability-status` = `DONE`（Prod Admin，us-east-1） |
| ✅ 2026-11-16 | A4e 定期補貨（§10.15，PR #46、#47）部署 Dev、Prod；Dev smoke 78/78、`replenish-check` 10/10；**訂貨模組 A1–A4 完成** |
| ✅ 2026-11-17 | 模擬器決策 D1–D9 定案（docs/07 對照，見 ADR-030）；S0（RSK-017）bus 資源政策部署 Dev、Prod 並驗證，含真實憑證反向測試（§10.10，PR #52） |
| ✅ 2026-11-17 | 模擬器 S1a（simulator client、`synthetic`）、S1b（stack、帳號 40、開關 `paused`、排程、探測）部署 Dev、Prod 並驗證，含 Dev 開關測試與 Prod 探測（§10.16，PR #54／#56／#57／#58） |
| ✅ 2026-11-17 | 模擬器 S1c 產生器（§10.16，PR #60）部署 Dev、Prod；Dev 驗證 dry-run 雜湊與本機相同、手動一小時（建立／重播／事件 `synthetic`）、逾時取消帶 `synthetic`、排程 18 時下單、19 時 0 筆；Dev 留在 `running` |
| ✅ 2026-11-18 | 溯源 S2a（§10.17，PR #65、#66）部署 Dev、Prod 並驗證；Dev smoke 129/129 |
| ✅ 2026-11-18 | 模擬器 Dev 觀察期：11/17 17–19 時與 11/18 10、11、14 時全部照計畫（共 5 筆 created、0 violation、DLQ 0、無告警） |
| ✅ 2026-11-18 | minimatch 警示（PR #63）部署 Dev、Prod：Lambda 程式不變（只有每次部署的 custom resource 更新） |
| ✅ 2026-11-18 | 模擬器 S1d：Prod `state` 改 `running`，16:05 排程自動下第一批 2 筆模擬訂單（§10.16）；**模擬器 S1 完成** |
| ✅ 2026-11-20 | 溯源 S2d（§10.20，PR #75、#76）：Dev 端到端、Prod 16:05 排烘 9 批、09:05 烘焙 → 9 個公開頁；**溯源 S2 完成、P1 完成** |
| ✅ 2026-11-19 | FSBP 全面整理（§9）：刪除 Dev／Prod 台北預設 VPC、5 項帳號設定、停用 Inspector.1/.2、6 項 SUPPRESSED → **100%**（2026-11-20） |
| ✅ 2026-11-21 | P2b-1 訂艙 API＋模擬航程產生器（dry-run）、P2b-2 shipment stack＋航程偵測＋位置排程部署 Dev、Prod；驗證腳本修正 #85（§10.22，PR #83、#84、#85） |
| 2026-11-25 前後 | P2b Dev 運行觀察：第一筆訂艙、位置檔、`DEPA`、`ARRI`；之後 V2–V8（位置檔筆數＝Athena、事件 detail 沒有識別碼、重送冪等、格式錯誤 → DLQ 告警、Developer 不能寫位置檔），結果寫入 §10.22 |
| 2026-12-06 前後 | P2b Prod 觀察（P1）：第一筆訂艙 11-29、第一個 `DEPA` 12-06（Prod Admin，只讀） |
| 待決 | 轉運／經停（ADR-032 補充 E8，P2b 只做直航）；庫存與到港連動（E2，目前補貨不看到港） |
| P2 | 下一步：P2b-spike aisstream（Dev 7 天）→ P2c 公開頁旅程（TRC-F-004，D11）→ P2d IFTSTA（D12）→ 採購分析 P2e–P2f（docs/05；`procurement-dlq`）；curate 工作流（Athena UNLOAD，D3）在 P2e 第一個使用者出現時建立 |
| P2b-spike 前 | aisstream API key（需本人以 GitHub 登入建立）→ 密碼管理器；spike 時存 Dev SSM SecureString |
| 有空時 | 管理帳號 Secrets Manager 的 USD 0.00003 是否只是 API 呼叫（若有 secret 會是每個每月 USD 0.40） |
| 有空時 | us-east-1 的預設 VPC（Dev、Prod）也刪除（edge stack 不用 VPC；不影響 FSBP，台北以外沒開 Security Hub） |
| ✅ 2026-11-20 | 告警額度：免費 10 個是**全組織**共用（§5）→ ADR-030 D9 修訂（每環境 ≤ 13、告警費 ≤ USD 2／月，**不合併 DLQ**）；目前組織合計 22（Dev 11、Prod 11、管理帳號 0） |
| ✅ 2026-11-18 | Developer 許可集加上 `ssm:PutParameter`（只限 `/brewline/dev/simulator/state`），Developer 可在 Dev 切換模擬器開關（§3） |
| ✅ 2026-11-18 | Dependabot 安全警示 2 筆（`minimatch` < 11.0.1，Moderate，只在測試／synth 工具鏈）：PR #63 以 npm `overrides` 升到 11.0.9；`aws-cdk-lib` 內部打包（bundleDependencies）的一份要等新版 |
| ✅ 2026-11-17 | D7②：`scp-budget-lockdown` 加上 `cognito-idp:AdminInitiateAuth`，掛 Dev OU 實測後移除（§4.4） |
| nodejs26.x GA 後（預計 2026-11 底） | 評估 Lambda 升級到 Node 26（本機、CI、`Runtime`），移除 `LATEST_RUNTIME_ACK`（ADR-023 修訂） |
| P3 | OIDC 角色改由 `infra/landing-zone` app 管理（`cdk import`；先確認資源類型支援 import）（2026-11-19 由 P1 移到 P3 強化） |
| P3 | Config 新增 SQS、Step Functions 等類型（若 Security Hub 需要） |

---

## 14. 操作備忘 / Operating Notes

- 每次開 CloudShell 先跑 `aws sts get-caller-identity`，確認在哪個帳號。CloudShell 跟著登入的帳號和角色走。
- CloudShell 開在東京；對台北的指令一律加 `--region ap-east-2`（否則被 `scp-region-restrict` 擋）。管理帳號不受 SCP 限制。
- 錯誤訊息判讀：`explicit deny in a service control policy` → 查 SCP；`resource control policy` → 查 RCP；`explicit deny in a resource-based policy` → 查資源本身的政策（例如 bus 政策，§10.10）；`no identity-based policy allows` → 查 IAM。錯誤中的政策 ID 對照 §4。先看**哪個 API 被拒**：`AssumeRole` 被拒＝還沒拿到憑證（角色信任政策），不是目標資源的問題。
- 測試防護欄時選「就算成功也無害」的操作，並做正向＋反向測試。
- 合規檢查（Config、Security Hub CSPM）用 **ReadOnly** 即可（ViewOnlyAccess + SecurityAudit）。教訓：只有 ViewOnlyAccess 時 `config:GetDiscoveredResourceCounts` 被拒，畫面顯示「資源 (0)」不代表沒有記錄，要先看有沒有存取遭拒。
- 主控台搜尋「Security Hub」會開到**新版 Security Hub**（台北不支援，顯示 Region Unsupported）；FSBP 結果要搜尋 **Security Hub CSPM**。CLI `aws securityhub` 呼叫的是 CSPM。
- 確認特定資源是否合規：看「問題清單」（findings，依資源）比「控制項」（依規則、整個帳號）準。
- 反向測試用「不存在的資源」只適用於**先授權、後查資源**的服務（DynamoDB、IAM 是）。**KMS 會先找金鑰（要評估 key policy）**，不存在就回 `NotFoundException`，測不到 IAM Deny；這類情況改用 `aws iam simulate-principal-policy`（只計算 IAM 政策，不執行動作，不含 SCP／RCP／key policy）。
- Identity Center 建立的角色路徑含區域：`/aws-reserved/sso.amazonaws.com/ap-east-2/`；查 ARN 用 `aws iam list-roles --path-prefix /aws-reserved/`，不要手打。
- 許可集要能用 CloudShell，需另加 `AWSCloudShellFullAccess`（ViewOnlyAccess 不含）。
- 改許可集內嵌政策：CLI 是 `put-inline-policy-**to**-permission-set`（讀取是 `get-…-for-…`、刪除是 `delete-…-from-…`）；寫入後**讀回比對**，再 provision，最後一次 provision 必須在最後一次寫入之後（provision 冪等）；使用者要重新登入才拿到新權限。
- CloudShell 一開始先 `export AWS_PAGER=""`：否則長輸出會進入 `less`，之後貼上的指令會被當成分頁器按鍵。
- CloudShell 閒置約 20 分鐘會斷線，**重新連線後 shell 變數全部消失**（2026-11-17：`$F` 變空 → log group 變成 `/aws/lambda/` → `ResourceNotFoundException`）。之後要再跑的驗證指令寫成自足的形式（名稱寫死），時間範圍用固定時刻（`date -d '2026-11-17 17:30 +0800' +%s`），不要用「最近 N 分鐘」。
- 查 Powertools 的 JSON 日誌用 JSON filter pattern（`{ $.message = "simulated hour" }`、`{ $.detail.synthetic IS TRUE }`），比全文搜尋精準。
- 貼上多行指令時，`\` 結尾的下一行若是註解，指令會在那裡結束、後面參數被吃掉（2026-11-13：第一次隱藏 `Cognito.1` 沒有帶到備註）→ 一次貼一個完整指令，並用查詢驗證實際狀態。
- Security Hub 的「資源 ID」是完整 ARN（例如 user pool 是 `…:userpool/<pool-id>`，不含名稱）；篩選控制項用「安全控制 ID」，或直接從「控制項」頁面搜尋。
- `scp-budget-lockdown` 平時必須沒有任何目標。
- 帳號層級的查詢（例如 `lambda:GetAccountSettings`，Resource 只能是 `*`）不在 Developer 許可集內 → 用 Admin（2026-11-12 實測 `no identity-based policy allows`）。
- Service Quotas 是**每帳號、每區域**：申請一律加 `--region ap-east-2`。狀態 `CASE_OPENED` 代表轉為人工審核的 Support 案件，到該帳號的 Support Center 查看並回覆；結案後狀態是 `CASE_CLOSED`（不會顯示 `APPROVED`），**是否核准以 `aws lambda get-account-settings` 的實際值為準**（2026-11-13 實測，隔夜完成）。
- 主控台中文翻譯對照：Trail＝線索、Sample findings＝問題清單範本、Configuration＝組態、Central configuration＝中央組態。
