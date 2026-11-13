#!/usr/bin/env node
import { App, Tags, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { applyStandardTags, RequiredTagsChecker } from '../lib/aspects/required-tags';
import { ApiGuardrailsChecker } from '../lib/aspects/api-guardrails';
import { DataProtectionChecker } from '../lib/aspects/data-protection';
import { LambdaGuardrailsChecker } from '../lib/aspects/lambda-guardrails';
import { resolveEnv } from '../lib/config';
import { ApiStack } from '../lib/stacks/api-stack';
import { AuthStack } from '../lib/stacks/auth-stack';
import { DataStack } from '../lib/stacks/data-stack';
import { EventsStack } from '../lib/stacks/events-stack';
import { PipelineCheckStack } from '../lib/stacks/pipeline-check-stack';

const app = new App();

// 一律明確指定環境：cdk synth -c env=dev|prod
// Environment must always be explicit.
const env = resolveEnv(app.node.tryGetContext('env'));
const commitSha: string = app.node.tryGetContext('commit') ?? 'local';

new PipelineCheckStack(app, `brewline-${env.name}-pipeline-check`, {
  envName: env.name,
  commitSha,
  env: { account: env.account, region: env.region },
  description: 'BrewLine pipeline check (P1 CI/CD skeleton)',
  terminationProtection: env.name === 'prod',
});

// 共用資料基礎：KMS CMK + DynamoDB 單表（ADR-018）/ Shared data foundation.
const dataStack = new DataStack(app, `brewline-${env.name}-data`, {
  envName: env.name,
  data: env.data,
  env: { account: env.account, region: env.region },
  description: 'BrewLine shared data layer: KMS CMK + DynamoDB single table',
  terminationProtection: env.name === 'prod',
});
Tags.of(dataStack).add('module', 'core', { priority: 200 });

// 身分層：Cognito（Essentials）＋ pre token V2（ADR-022）/ Identity layer.
// 有狀態（使用者帳號）→ Prod 終止保護 / Stateful (user accounts) → termination protection in Prod.
const authStack = new AuthStack(app, `brewline-${env.name}-auth`, {
  envName: env.name,
  auth: env.auth,
  lambda: env.lambda,
  env: { account: env.account, region: env.region },
  description: 'BrewLine identity layer: Cognito user pool (Essentials) + pre token generation V2',
  terminationProtection: env.name === 'prod',
});
Tags.of(authStack).add('module', 'identity', { priority: 200 });

// 事件層（A3b，ADR-026）：bus、Streams → EventBridge、稽核 log、DLQ、告警 / Event layer.
const eventsStack = new EventsStack(app, `brewline-${env.name}-events`, {
  envName: env.name,
  lambda: env.lambda,
  env: { account: env.account, region: env.region },
  description: 'BrewLine event layer: EventBridge bus, Streams publisher, audit log, DLQs, alarms',
  terminationProtection: env.name === 'prod',
});
eventsStack.addStackDependency(dataStack, 'reads /brewline/<env>/data/* (stream ARN, key ARN) from SSM');
Tags.of(eventsStack).add('module', 'events', { priority: 200 });

// 訂貨 API（A1：商品唯讀）：HTTP API + JWT scope 授權（ADR-020、ADR-021）/ Ordering API.
// 無狀態 → 不開終止保護也可重建；仍在 Prod 開啟以防誤刪 / Stateless, but protected in Prod anyway.
// 依賴關係只用來排定部署順序（值經 SSM 傳遞，不產生 Export）/ Ordering only; values flow through SSM.
const apiStack = new ApiStack(app, `brewline-${env.name}-api`, {
  envName: env.name,
  api: env.api,
  lambda: env.lambda,
  commitSha,
  env: { account: env.account, region: env.region },
  description: 'BrewLine ordering API (A1): HTTP API, Cognito JWT scopes, read-only catalog',
  terminationProtection: env.name === 'prod',
});
apiStack.addStackDependency(dataStack, 'reads /brewline/<env>/data/* from SSM');
apiStack.addStackDependency(authStack, 'reads /brewline/<env>/auth/* from SSM');
// 先有事件層，Dev smoke test 下的單才會產生事件（驗證 OrderCreated 用）/ So smoke-test orders produce events.
apiStack.addStackDependency(eventsStack, 'smoke-test orders must flow through the stream publisher');
Tags.of(apiStack).add('module', 'ordering', { priority: 200 });

// 全 app 共用標籤；module 之後由各 stack 覆寫。
// App-wide tags; individual stacks override "module" later.
applyStandardTags(app, { env: env.name, module: 'platform' });
RequiredTagsChecker.attach(app);

// cdk-nag 的 DDB3 只檢查 CfnTable，不檢查 TableV2 產生的 CfnGlobalTable，由自訂檢查補上。
// cdk-nag DDB3 only inspects CfnTable, not the CfnGlobalTable that TableV2 emits; close the gap here.
DataProtectionChecker.attach(app, { requireDeletionProtection: env.name === 'prod' });

// Lambda 標準：Node 24、arm64、X-Ray、保留併發、log 保留期（ADR-023、COST-004、COST-007）。
// Lambda standard: Node 24, arm64, X-Ray, reserved concurrency, log retention.
LambdaGuardrailsChecker.attach(app);

// HTTP API：每條路由 JWT + scope；每個 stage access log + 限流（ADR-020、ADR-021）。
// HTTP API: JWT + scope on every route; access logs + throttling on every stage.
ApiGuardrailsChecker.attach(app);

// cdk-nag v3 以 CDK 原生 Policy Validation 外掛執行；違規會讓 synth 失敗（CI 因此擋下 PR）。
// cdk-nag v3 runs as a native CDK policy-validation plugin; violations fail synth and block the PR.
// 刻意例外請用 Validations.of(construct).acknowledge({ id, reason })，並在 PR 說明原因。
Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
