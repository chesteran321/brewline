import { App, Stack, Tags, Validations } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { AwsSolutionsChecks } from 'cdk-nag';
import { applyStandardTags, RequiredTagsChecker } from '../lib/aspects/required-tags';
import { ENVIRONMENTS, resolveEnv } from '../lib/config';
import { PipelineCheckStack } from '../lib/stacks/pipeline-check-stack';

/** 與 bin/app.ts 相同的組裝方式 / Same wiring as bin/app.ts. */
function buildApp(envName: 'dev' | 'prod') {
  const app = new App();
  const env = ENVIRONMENTS[envName];
  const stack = new PipelineCheckStack(app, `brewline-${envName}-pipeline-check`, {
    envName,
    commitSha: 'abc1234',
    env: { account: env.account, region: env.region },
  });
  applyStandardTags(app, { env: envName, module: 'platform' });
  RequiredTagsChecker.attach(app);
  Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
  return { app, stack };
}

describe('PipelineCheckStack', () => {
  test.each(['dev', 'prod'] as const)('%s: creates exactly one Standard SSM parameter', (envName) => {
    const template = Template.fromStack(buildApp(envName).stack);
    template.resourceCountIs('AWS::SSM::Parameter', 1);
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: `/brewline/${envName}/pipeline-check`,
      Value: 'abc1234',
      Type: 'String',
      Tier: 'Standard',
    });
  });

  test('targets ap-east-2 and the right accounts', () => {
    expect(buildApp('dev').stack.region).toBe('ap-east-2');
    expect(buildApp('dev').stack.account).toBe('610935435571');
    expect(buildApp('prod').stack.account).toBe('062868712468');
  });

  test('applies all required tags', () => {
    Template.fromStack(buildApp('dev').stack).hasResourceProperties('AWS::SSM::Parameter', {
      Tags: Match.objectLike({ project: 'brewline', env: 'dev', module: 'platform', owner: 'chester' }),
    });
  });

  test('has no tag-check errors', () => {
    const errors = Annotations.fromStack(buildApp('dev').stack).findError('*', Match.anyValue());
    expect(errors).toHaveLength(0);
  });

  // 正向測試：cdk-nag 全部通過，synth 成功 / Positive: cdk-nag passes, synth succeeds.
  test.each(['dev', 'prod'] as const)('%s: passes cdk-nag AwsSolutions', (envName) => {
    expect(() => buildApp(envName).app.synth()).not.toThrow();
  });
});

describe('cdk-nag gate', () => {
  // 反向測試：不安全的 S3 bucket 必須讓 synth 失敗，證明 CI 防線真的會擋。
  // Negative: an insecure bucket must fail synth, proving the CI gate actually blocks.
  test('fails synth for an insecure S3 bucket', () => {
    const app = new App();
    const stack = new Stack(app, 'Insecure');
    new s3.Bucket(stack, 'Bad'); // no access logs, no SSL enforcement
    Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
    expect(() => app.synth()).toThrow();
  });
});

describe('resolveEnv', () => {
  test('accepts dev and prod', () => {
    expect(resolveEnv('dev').account).toBe('610935435571');
    expect(resolveEnv('prod').account).toBe('062868712468');
  });

  // 反向測試：缺少或拼錯環境名稱必須失敗 / Negative: missing or misspelled env must fail.
  test.each([undefined, '', 'production', 'Dev'])('rejects %p', (value) => {
    expect(() => resolveEnv(value)).toThrow(/Missing or invalid context "env"/);
  });
});

describe('RequiredTagsChecker', () => {
  // 反向測試：沒貼齊標籤的資源要在 synth 時報錯 / Negative: an under-tagged resource must error.
  test('reports an error for a resource missing tags', () => {
    const app = new App();
    const stack = new Stack(app, 'Untagged');
    new ssm.StringParameter(stack, 'P', { stringValue: 'x' });
    Tags.of(app).add('project', 'brewline'); // only one of four
    RequiredTagsChecker.attach(app);
    const errors = Annotations.fromStack(stack).findError(
      '*',
      Match.stringLikeRegexp('Missing required tags: env, module, owner'),
    );
    expect(errors).toHaveLength(1);
  });
});
