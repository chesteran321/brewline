#!/usr/bin/env node
import { App, Tags, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { applyStandardTags, RequiredTagsChecker } from '../lib/aspects/required-tags';
import { DataProtectionChecker } from '../lib/aspects/data-protection';
import { resolveEnv } from '../lib/config';
import { DataStack } from '../lib/stacks/data-stack';
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

// 全 app 共用標籤；module 之後由各 stack 覆寫。
// App-wide tags; individual stacks override "module" later.
applyStandardTags(app, { env: env.name, module: 'platform' });
RequiredTagsChecker.attach(app);

// cdk-nag 的 DDB3 只檢查 CfnTable，不檢查 TableV2 產生的 CfnGlobalTable，由自訂檢查補上。
// cdk-nag DDB3 only inspects CfnTable, not the CfnGlobalTable that TableV2 emits; close the gap here.
DataProtectionChecker.attach(app, { requireDeletionProtection: env.name === 'prod' });

// cdk-nag v3 以 CDK 原生 Policy Validation 外掛執行；違規會讓 synth 失敗（CI 因此擋下 PR）。
// cdk-nag v3 runs as a native CDK policy-validation plugin; violations fail synth and block the PR.
// 刻意例外請用 Validations.of(construct).acknowledge({ id, reason })，並在 PR 說明原因。
Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
