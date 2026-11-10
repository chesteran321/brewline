#!/usr/bin/env node
import { App, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { applyStandardTags, RequiredTagsChecker } from '../lib/aspects/required-tags';
import { resolveEnv } from '../lib/config';
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

// 全 app 共用標籤；module 之後由各 stack 覆寫。
// App-wide tags; individual stacks override "module" later.
applyStandardTags(app, { env: env.name, module: 'platform' });
RequiredTagsChecker.attach(app);

// cdk-nag v3 以 CDK 原生 Policy Validation 外掛執行；違規會讓 synth 失敗（CI 因此擋下 PR）。
// cdk-nag v3 runs as a native CDK policy-validation plugin; violations fail synth and block the PR.
// 刻意例外請用 Validations.of(construct).acknowledge({ id, reason })，並在 PR 說明原因。
Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
