import { App, RemovalPolicy, Stack, Tags, Validations } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import { AwsSolutionsChecks } from 'cdk-nag';
import { DataProtectionChecker } from '../lib/aspects/data-protection';
import { applyStandardTags, RequiredTagsChecker } from '../lib/aspects/required-tags';
import { ENVIRONMENTS, EnvName } from '../lib/config';
import { DataStack } from '../lib/stacks/data-stack';

/** 與 bin/app.ts 相同的組裝方式 / Same wiring as bin/app.ts. */
function buildApp(envName: EnvName) {
  const app = new App();
  const env = ENVIRONMENTS[envName];
  const stack = new DataStack(app, `brewline-${envName}-data`, {
    envName,
    data: env.data,
    env: { account: env.account, region: env.region },
  });
  Tags.of(stack).add('module', 'core', { priority: 200 });
  applyStandardTags(app, { env: envName, module: 'platform' });
  RequiredTagsChecker.attach(app);
  DataProtectionChecker.attach(app, { requireDeletionProtection: envName === 'prod' });
  Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
  return { app, stack, template: Template.fromStack(stack) };
}

/** 只有一張表、沒有其他 Aspect 的最小 app，用來做反向測試 / Minimal app for negative tests. */
function bareTableApp(props: Partial<dynamodb.TablePropsV2>, requireDeletionProtection = false) {
  const app = new App();
  // CMK 加密的 TableV2 需要明確區域 / A CMK-encrypted TableV2 needs an explicit region.
  const stack = new Stack(app, 'Bare', { env: { account: '111111111111', region: 'ap-east-2' } });
  const key = new kms.Key(stack, 'K', { enableKeyRotation: true, removalPolicy: RemovalPolicy.DESTROY });
  new dynamodb.TableV2(stack, 'T', {
    partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
    encryption: dynamodb.TableEncryptionV2.customerManagedKey(key),
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    ...props,
  });
  DataProtectionChecker.attach(app, { requireDeletionProtection });
  return { app, stack };
}

const dataErrors = (stack: Stack, pattern: string) =>
  Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp(pattern));

describe('DataStack', () => {
  test.each(['dev', 'prod'] as const)('%s: one CMK with yearly rotation and the env alias', (envName) => {
    const { template } = buildApp(envName);
    template.resourceCountIs('AWS::KMS::Key', 1);
    template.hasResourceProperties('AWS::KMS::Key', { EnableKeyRotation: true, RotationPeriodInDays: 365 });
    template.hasResourceProperties('AWS::KMS::Alias', { AliasName: `alias/brewline-${envName}-data` });
  });

  test.each(['dev', 'prod'] as const)('%s: TableV2 with generic pk/sk, CMK, PITR, TTL, max throughput', (envName) => {
    const { template } = buildApp(envName);
    const d = ENVIRONMENTS[envName].data;
    template.resourceCountIs('AWS::DynamoDB::GlobalTable', 1);
    template.resourceCountIs('AWS::DynamoDB::Table', 0);
    template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      TableName: `brewline-${envName}-core`,
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
      SSESpecification: { SSEEnabled: true, SSEType: 'KMS' },
      TimeToLiveSpecification: { AttributeName: 'expires_at', Enabled: true },
      WriteOnDemandThroughputSettings: { MaxWriteRequestUnits: d.maxWriteRequestUnits },
      // A1a：只有一個多用途 GSI1 / exactly one overloaded GSI1.
      GlobalSecondaryIndexes: [
        {
          IndexName: 'gsi1',
          KeySchema: [
            { AttributeName: 'gsi1pk', KeyType: 'HASH' },
            { AttributeName: 'gsi1sk', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
          WriteOnDemandThroughputSettings: { MaxWriteRequestUnits: d.maxWriteRequestUnits },
        },
      ],
      // A3a：Streams 開啟，NEW_AND_OLD_IMAGES（事件來源）/ Streams on, old+new images (event source).
      StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' },
      Replicas: [
        Match.objectLike({
          Region: 'ap-east-2',
          SSESpecification: { KMSMasterKeyId: { 'Fn::GetAtt': [Match.stringLikeRegexp('^DataKey'), 'Arn'] } },
          PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true, RecoveryPeriodInDays: 35 },
          DeletionProtectionEnabled: d.deletionProtection,
          ReadOnDemandThroughputSettings: { MaxReadRequestUnits: d.maxReadRequestUnits },
          GlobalSecondaryIndexes: [
            { IndexName: 'gsi1', ReadOnDemandThroughputSettings: { MaxReadRequestUnits: d.maxReadRequestUnits } },
          ],
          Tags: Match.arrayWith([{ Key: 'data-class', Value: 'pii' }, { Key: 'module', Value: 'core' }]),
        }),
      ],
    });
  });

  test.each(['dev', 'prod'] as const)('%s: GSI key attributes are declared as strings', (envName) => {
    const { template } = buildApp(envName);
    template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      AttributeDefinitions: Match.arrayWith([
        { AttributeName: 'gsi1pk', AttributeType: 'S' },
        { AttributeName: 'gsi1sk', AttributeType: 'S' },
      ]),
    });
  });

  // 反向：GSI 沒有明確上限時，template 不會帶 MaxWriteRequestUnits（= 不受限）。這個測試記錄 CDK 的預設行為，
  // 說明為什麼 data-stack 必須明確設定。
  // Negative: without explicit caps the template carries no max units (= uncapped); documents why we set them.
  test('a TableV2 GSI without explicit caps has no on-demand max in the template (documents the default)', () => {
    const app = new App();
    const stack = new Stack(app, 'GsiDefault', { env: { account: '111111111111', region: 'ap-east-2' } });
    new dynamodb.TableV2(stack, 'T', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand({ maxReadRequestUnits: 10, maxWriteRequestUnits: 5 }),
      globalSecondaryIndexes: [{ indexName: 'g', partitionKey: { name: 'gpk', type: dynamodb.AttributeType.STRING } }],
    });
    const tables = Template.fromStack(stack).findResources('AWS::DynamoDB::GlobalTable');
    const [table] = Object.values(tables) as Array<{ Properties: { GlobalSecondaryIndexes: Array<Record<string, unknown>> } }>;
    expect(table.Properties.GlobalSecondaryIndexes[0].WriteOnDemandThroughputSettings).toBeUndefined();
  });

  test('exposes the GSI1 names as constants for consumers', () => {
    expect(DataStack.GSI1).toEqual({ indexName: 'gsi1', partitionKey: 'gsi1pk', sortKey: 'gsi1sk' });
  });

  test('prod: retains table and key; dev: destroys them', () => {
    const prod = buildApp('prod').template;
    prod.hasResource('AWS::DynamoDB::GlobalTable', { DeletionPolicy: 'Retain' });
    prod.hasResource('AWS::KMS::Key', { DeletionPolicy: 'Retain', Properties: Match.objectLike({ PendingWindowInDays: 30 }) });
    const dev = buildApp('dev').template;
    dev.hasResource('AWS::DynamoDB::GlobalTable', { DeletionPolicy: 'Delete' });
    dev.hasResource('AWS::KMS::Key', { DeletionPolicy: 'Delete', Properties: Match.objectLike({ PendingWindowInDays: 7 }) });
  });

  test.each(['dev', 'prod'] as const)('%s: publishes table, key and stream ARNs to SSM', (envName) => {
    const { template } = buildApp(envName);
    for (const name of ['table-name', 'table-arn', 'kms-key-arn', 'table-stream-arn']) {
      template.hasResourceProperties('AWS::SSM::Parameter', {
        Name: `/brewline/${envName}/data/${name}`,
        Tier: 'Standard',
      });
    }
  });

  test('uses no CloudFormation exports', () => {
    const outputs = buildApp('prod').template.toJSON().Outputs as Record<string, { Export?: unknown }>;
    expect(Object.values(outputs).every((o) => o.Export === undefined)).toBe(true);
  });

  test.each(['dev', 'prod'] as const)('%s: no tag or data-protection errors', (envName) => {
    const errors = Annotations.fromStack(buildApp(envName).stack).findError('*', Match.anyValue());
    expect(errors).toHaveLength(0);
  });

  // 正向：cdk-nag 全部通過，且不需要任何 acknowledge 例外 / Positive: cdk-nag passes with no exceptions.
  test.each(['dev', 'prod'] as const)('%s: passes cdk-nag AwsSolutions', (envName) => {
    expect(() => buildApp(envName).app.synth()).not.toThrow();
  });
});

describe('DataProtectionChecker', () => {
  test('accepts a compliant table', () => {
    expect(dataErrors(bareTableApp({}).stack, 'DataProtection')).toHaveLength(0);
  });

  // 反向：這正是 cdk-nag DDB3 漏掉的情況 / Negative: exactly what cdk-nag DDB3 misses for TableV2.
  test('cdk-nag alone does NOT catch PITR off on a TableV2 (documents the gap)', () => {
    const app = new App();
    const stack = new Stack(app, 'NagOnly');
    new dynamodb.TableV2(stack, 'T', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: false },
    });
    Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
    expect(() => app.synth()).not.toThrow();
  });

  test('errors when PITR is off', () => {
    const { stack } = bareTableApp({ pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: false } });
    expect(dataErrors(stack, 'must enable point-in-time recovery')).toHaveLength(1);
  });

  test('errors when encrypted with the DynamoDB owned key', () => {
    const { stack } = bareTableApp({ encryption: dynamodb.TableEncryptionV2.dynamoOwnedKey() });
    expect(dataErrors(stack, 'must use SSE-KMS')).toHaveLength(1);
  });

  test('errors when encrypted with the AWS managed key', () => {
    const { stack } = bareTableApp({ encryption: dynamodb.TableEncryptionV2.awsManagedKey() });
    expect(dataErrors(stack, 'customer managed KMS key')).toHaveLength(1);
  });

  test('errors in prod mode when deletion protection is off', () => {
    const { stack } = bareTableApp({ deletionProtection: false }, true);
    expect(dataErrors(stack, 'must enable deletion protection')).toHaveLength(1);
  });

  // 注意：Annotation error 不會讓 app.synth() 丟例外；是 CDK CLI（cdk synth）看到 error 後以 exit 1 結束。
  // 已於本機實測：Dev 關閉 PITR → `cdk synth -c env=dev` 輸出 [DataProtection] ... 並 exit 1。
  // Note: annotation errors do not make app.synth() throw; the CDK CLI exits 1 when it sees them.
});

describe('RequiredTagsChecker on data resources', () => {
  function taggedTableApp(dataClass?: string) {
    const app = new App();
    const stack = new Stack(app, 'Tags');
    const table = new dynamodb.TableV2(stack, 'T', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
    });
    if (dataClass !== undefined) {
      Tags.of(table).add('data-class', dataClass);
    }
    applyStandardTags(app, { env: 'dev', module: 'core' });
    RequiredTagsChecker.attach(app);
    return stack;
  }

  // 反向：TableV2 的標籤在 Replicas[].Tags，舊版檢查會整個跳過 / Negative: old checker skipped TableV2.
  test('errors when a TableV2 lacks data-class', () => {
    expect(dataErrors(taggedTableApp(), 'Missing required tags \\(replica .*\\): data-class')).toHaveLength(1);
  });

  test('errors on an invalid data-class value', () => {
    expect(dataErrors(taggedTableApp('secret'), 'Invalid data-class "secret"')).toHaveLength(1);
  });

  test('accepts a valid data-class value', () => {
    expect(Annotations.fromStack(taggedTableApp('internal')).findError('*', Match.anyValue())).toHaveLength(0);
  });

  test('still checks the four base tags on a TableV2', () => {
    const app = new App();
    const stack = new Stack(app, 'Untagged');
    const table = new dynamodb.TableV2(stack, 'T', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
    });
    Tags.of(table).add('data-class', 'pii');
    RequiredTagsChecker.attach(app);
    expect(dataErrors(stack, 'Missing required tags.*project, env, module, owner')).toHaveLength(1);
  });
});
