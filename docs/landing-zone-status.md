# Landing Zone 實際狀態 / Landing Zone As-Built Status

> 狀態 Status：**P0 完成；P1 CI/CD 骨架、共用資料基礎完成 / P0 complete; P1 CI/CD skeleton and shared data foundation complete**（2026-11-11）
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
  - ✅ 已確認可用：Lambda、API Gateway、DynamoDB、Step Functions、EventBridge、Scheduler、SQS、SNS、SES、Cognito、S3、Firehose、Glue、Athena、SSM、KMS、X-Ray、CloudWatch、CodeDeploy、CloudFormation、Bedrock（模型清單需另查）、GuardDuty、Security Hub、Config、CloudTrail、Access Analyzer

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
               "athena:StartQueryExecution", "glue:StartJobRun", "glue:StartCrawler"],
    "Resource": "*",
    "Condition": { "ArnNotLike": { "aws:PrincipalArn": "arn:aws:iam::*:role/aws-reserved/sso.amazonaws.com/*AWSReservedSSO_Admin_*" } }
  }]
}
```

- 只擋建立與按次計費呼叫，不擋刪除；Identity Center Admin 角色豁免。
- 鎖定時 **CDK / GitHub Actions 部署會全部失敗**（錯誤訊息出現 `p-mljh1epv`）。
- 擋不住已經在跑的排程 Lambda → 模擬器要靠 SIM-N-001 的 SSM 開關。

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
| `brewline-dev-monthly` | USD 5／月 | Linked account 610935435571 | 同上 |
| `brewline-security-monthly` | USD 5／月 | Linked account 978684888186 | 同上 |

- 分帳號預算以 **CLI 建立**（新帳號尚無帳單資料時，主控台的 Linked account 清單選不到）。
- 2026-09-30 之後新增的預算收件人**必須驗證 Email** 才收得到通知。

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
- **已知例外**：管理帳號 ap-east-2 偵測器由 `create-detector` 建立時套用預設值開啟了 EBS Malware Protection；成為成員後成員與委派管理員都無法停用（自動啟用「所有帳戶」時也無法取消關聯）。該帳號無 EC2，不會觸發掃描。於試用期決策點確認費用為 0。
- 教訓：成員帳號要先調好偵測器功能再加入成員；加入後設定權移交委派管理員。
- 試用期：2026-11-09 起 30 天（每帳號每區域）。

---

## 8. 設定記錄 / AWS Config

| 帳號 | 記錄 | 頻率 | 區域 |
|---|---|---|---|
| brewline-prod | ✅ | CONTINUOUS | ap-east-2 |
| brewline-dev | ✅ | DAILY | ap-east-2 |
| brewline-security、Management | ❌ | — | — |

- 記錄類型（8 種，`INCLUSION_BY_RESOURCE_TYPES`）：`AWS::IAM::Role`、`AWS::IAM::Policy`、`AWS::S3::Bucket`、`AWS::KMS::Key`、`AWS::Lambda::Function`、`AWS::DynamoDB::Table`、`AWS::ApiGatewayV2::Api`、`AWS::ApiGatewayV2::Stage`
- 使用服務連結角色 `AWSServiceRoleForConfig`；保留期 365 天；快照每 24 小時。
- 交付到 `brewline-security-config-978684888186`（Security 帳號；版本控制；無 Object Lock；目前版本 365 天過期、非目前版本 30 天）。Bucket policy 以 `aws:SourceAccount` 允許 062868712468、610935435571。
- **缺口**：CloudFront 設定只記錄在 us-east-1 的 Config，本專案未記錄 → 改由 CDK + cdk-nag 部署前檢查。
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
| 鍵 | `pk`（S）／`sk`（S）；無 GSI、無 Streams | 同左 |
| 容量 | On-demand，max 50 RRU／25 WRU | On-demand，max 200 RRU／100 WRU |
| 加密 | SSE-KMS（上述 CMK） | 同左 |
| PITR | 35 天（ADR-019） | 35 天 |
| 刪除保護／刪除政策 | 否／Delete | **是／Retain** |
| TTL | `expires_at` | `expires_at` |
| 標籤 | `module=core`、`data-class=pii` | 同左 |
| SSM（Standard） | `/brewline/dev/data/{table-name,table-arn,kms-key-arn}` | `/brewline/prod/data/...` |

- Key policy 為 CDK 預設（`kms:*` 給帳號 root → 交由 IAM 決定）；RCP `EnforceOrgIdentities` 另限制只有組織內身分可用 `kms:*`。
- 其他 stack 一律由 SSM 參數取得名稱／ARN，不使用 CloudFormation Export。
- 加密為**表層級**；聯絡人欄位層級加密於訂貨模組（A2）決定。
- 費用：約 USD 1／月／帳號（KMS key）；DynamoDB 與 PITR 目前約 0。一年後第一次輪替每把 +USD 1／月（上限 USD 3／月）。

已驗證（2026-11-11，Deploy run #5，`scripts/verify-data-stack.sh`，身分 `cdk-hnb659fds-lookup-role-*`）：
- Dev、Prod 各 11 項全部 ✅：ACTIVE、SSE=KMS／ENABLED、SSE key = stack CMK、鍵 `pk`/`sk`、PITR ENABLED、TTL `expires_at`、KMS 輪替 True、SSM 表名正確；刪除保護與終止保護 Dev `false`、Prod `true`。
- 反向（本機）：Dev 關閉 PITR → `cdk synth` 輸出 `[DataProtection] ... must enable point-in-time recovery`，exit 1。
- 反向（Jest）：cdk-nag 單獨使用時**不會**擋下 TableV2 關閉 PITR（記錄缺口）；自訂檢查會擋。
- ✅（2026-11-11 22:42，Prod Admin 主控台）Config 已將 `brewline-prod-core` 記錄為 `AWS::DynamoDB::Table`，合規狀態「合規」→ `TableV2`（GlobalTable）不影響 Config 記錄。
- ✅（2026-11-11 22:53，Security Hub CSPM 控制項頁）`DynamoDB.2`（PITR）通過、`DynamoDB.6`（刪除保護）通過，失敗的檢查皆 0／1。
- `KMS.4`（金鑰輪替）顯示「已停用」：它不屬於 FSBP（屬 CIS、NIST 等），Prod 只開 FSBP 所以不評估。輪替已由 cdk-nag `AwsSolutions-KMS5`（部署前）與驗證腳本 `KMS rotation = True`（部署後）確認，不另開標準。

教訓 / Lessons：
- cdk-nag `AwsSolutions-DDB3` 只檢查 `CfnTable`；`TableV2` 產生 `CfnGlobalTable`，被視為不適用。
- `CfnGlobalTable` 不是 ITaggable（標籤在 `Replicas[].Tags`），只用 `TagManager.isTaggable()` 的檢查會默默跳過。
- CMK 加密的 `TableV2` 必須在有明確區域的 stack 中（測試的 Stack 也要給 `env`）。

---

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
| ADR-018 | 共用資料層：每帳號 1 把 CMK + DynamoDB 單表（TableV2） | Accepted（2026-11-11） | 見 §10.5 與 docs/14；鍵 `pk`/`sk`；GSI、Streams 延後；SSM 取代 Export；自訂 `DataProtectionChecker` 補 cdk-nag 缺口 |
| ADR-019 | Dev 也開 PITR | Accepted（2026-11-11） | 費用約 0、不需例外、可在 Dev 練習還原；取代 02 §3 |
| ADR-023 | Node 24：本機、CI、Lambda 一致 | Accepted（2026-11-12） | Lambda `nodejs24.x`（淘汰 2028-04-30）；`.nvmrc`、`engines`、`@types/node` 改 24；取代 status §10.3 的 Node 22 |

| 風險 | 內容 | L | I | 緩解 |
|---|---|---|---|---|
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
| 14 | 加入 §11 的 ADR 與 RSK-013（ADR-018、ADR-019 已加入，PR #6） |
| 02 §3 | Dev PITR 改為開啟（ADR-019） |
| 02 §4 | CDK 結構改為 `infra/app/{bin,lib/stacks,lib/aspects,scripts,test}` |
| 09 §3.1 | 加註：使用 `TableV2`；Streams 延後到有 consumer；GSI 依模組逐一新增 |
| 09 §5、11 §2 | KMS 輪替費用：第一、二次輪替各 +USD 1／月，每把上限 USD 3／月 |
| 03 §10 | 「聯絡人欄位以 CMK 加密」釐清為表層級 SSE（已完成）＋欄位層級（A2 決定） |
| 03 §10、09 §1.2 | API Gateway **HTTP API 不能直接掛 WAF**；登入／註冊限流改由 CloudFront 或 Cognito user pool WAF（A1 決定） |
| 03 §5 | 租戶角色另需 `dynamodb:ConditionCheckItem`（TransactWriteItems）；信任政策需 `sts:TagSession` |

---

## 13. 待辦 / Open Items

| 時間 | 事項 |
|---|---|
| 盡快 | 確認 5 個預算收件人 Email 皆為 Verified |
| 盡快 | 查看 Prod 第一個 FSBP 分數 |
| 盡快 | 管理帳號舊資源盤點與清理（台北 S3 bucket、Glue Data Catalog、2 個 CloudWatch 告警） |
| 有空時 | break-glass 第二個 MFA 裝置、紙本備份 |
| 有空時 | 手動建立的預算日後改由 CDK 管理（或匯入） |
| **2026-12-04** | 試用期決策點：GuardDuty、Security Hub CSPM 用量頁；確認管理帳號 EBS Malware 費用為 0；依 11 §7 定案 ADR-008 |
| ✅ 2026-11-10 | `.gitignore` 補強；`infra/app` 初始化；PR／Deploy workflow；pipeline-check stack 驗證 Dev、Prod 整條管線（§10.4，PR #1） |
| ✅ 2026-11-10 | ruleset required status check `checks`；`.github/dependabot.yml` |
| ✅ 2026-11-10 | 本機 `D:\brewline` 改為 `git clone` GitHub repo |
| P1 | 處理 Dependabot 開的更新 PR（確認 `checks` 綠燈再合併） |
| ✅ 2026-11-11 | 共用資料基礎：`brewline-<env>-data` 部署 Dev、Prod 並驗證（§10.5，PR #6） |
| ✅ 2026-11-11 | 決定：OIDC 角色**不**由 workload app／CI 管理；之後另建 `infra/landing-zone` app，以 `cdk import` 匯入，由 Admin 本機部署（可選：`scp-baseline` 加 Sid 禁止非 SSO Admin 修改 `gha-*` 角色） |
| ✅ 2026-11-11 | Prod Config 記錄 `brewline-prod-core`（`AWS::DynamoDB::Table`，合規） |
| ✅ 2026-11-11 | FSBP `DynamoDB.2`、`DynamoDB.6` 通過；`KMS.4` 不在 FSBP，由 cdk-nag＋驗證腳本涵蓋 |
| ✅ 2026-11-11 | ReadOnly 許可集加上 `SecurityAudit`，正向＋反向驗證通過（§3） |
| ✅ 2026-11-11 | 建立 `Developer` 許可集，只指派 brewline-dev，正向＋反向驗證通過（§3） |
| P1 | 下一步：訂貨模組 A1（Cognito＋商品唯讀 API）→ A2（下單交易＋冪等）→ A3（Step Functions＋事件）→ A4（SES／Scheduler）→ 模擬器 → 溯源 |
| P1 | OIDC 角色改由 `infra/landing-zone` app 管理（`cdk import`；先確認資源類型支援 import） |
| P3 | Config 新增 SQS、Step Functions 等類型（若 Security Hub 需要） |

---

## 14. 操作備忘 / Operating Notes

- 每次開 CloudShell 先跑 `aws sts get-caller-identity`，確認在哪個帳號。CloudShell 跟著登入的帳號和角色走。
- CloudShell 開在東京；對台北的指令一律加 `--region ap-east-2`（否則被 `scp-region-restrict` 擋）。管理帳號不受 SCP 限制。
- 錯誤訊息判讀：`explicit deny in a service control policy` → 查 SCP；`resource control policy` → 查 RCP；`no identity-based policy allows` → 查 IAM。錯誤中的政策 ID 對照 §4。
- 測試防護欄時選「就算成功也無害」的操作，並做正向＋反向測試。
- 合規檢查（Config、Security Hub CSPM）用 **ReadOnly** 即可（ViewOnlyAccess + SecurityAudit）。教訓：只有 ViewOnlyAccess 時 `config:GetDiscoveredResourceCounts` 被拒，畫面顯示「資源 (0)」不代表沒有記錄，要先看有沒有存取遭拒。
- 主控台搜尋「Security Hub」會開到**新版 Security Hub**（台北不支援，顯示 Region Unsupported）；FSBP 結果要搜尋 **Security Hub CSPM**。CLI `aws securityhub` 呼叫的是 CSPM。
- 確認特定資源是否合規：看「問題清單」（findings，依資源）比「控制項」（依規則、整個帳號）準。
- 反向測試用「不存在的資源」只適用於**先授權、後查資源**的服務（DynamoDB、IAM 是）。**KMS 會先找金鑰（要評估 key policy）**，不存在就回 `NotFoundException`，測不到 IAM Deny；這類情況改用 `aws iam simulate-principal-policy`（只計算 IAM 政策，不執行動作，不含 SCP／RCP／key policy）。
- Identity Center 建立的角色路徑含區域：`/aws-reserved/sso.amazonaws.com/ap-east-2/`；查 ARN 用 `aws iam list-roles --path-prefix /aws-reserved/`，不要手打。
- 許可集要能用 CloudShell，需另加 `AWSCloudShellFullAccess`（ViewOnlyAccess 不含）。
- `scp-budget-lockdown` 平時必須沒有任何目標。
- 主控台中文翻譯對照：Trail＝線索、Sample findings＝問題清單範本、Configuration＝組態、Central configuration＝中央組態。
