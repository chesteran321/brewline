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
| IaC | AWS CDK（TypeScript），Node 22 LTS，Lambda `Runtime.NODEJS_22_X` |
| CDK bootstrap | qualifier `hnb659fds`，Dev / Prod 的 ap-east-2 與 us-east-1 |

### CI/CD 身分 / CI/CD identities（GitHub OIDC）

| 角色 Role | 帳號 Account | 信任 `sub` | 用途 Use |
|---|---|---|---|
| `gha-readonly` | Dev、Prod | `repo:chesteran321/brewline:pull_request` | PR 的 `cdk diff`（只能扮演 lookup role） |
| `gha-deploy-dev` | Dev | `repo:chesteran321/brewline:ref:refs/heads/main` | main 合併後部署 Dev |
| `gha-deploy-prod` | Prod | `repo:chesteran321/brewline:environment:production` | 經 `production` environment 核准後部署 Prod |

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
cd infra/app
npm ci
npm test
npx cdk synth -c env=dev     # 不需要 AWS 憑證 / no AWS credentials needed
npx cdk diff  -c env=dev --no-change-set
```
