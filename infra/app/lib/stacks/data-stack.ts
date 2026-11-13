import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps, Tags } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { DATA_CLASS_TAG, DataSettings, EnvName } from '../config';

export interface DataStackProps extends StackProps {
  readonly envName: EnvName;
  readonly data: DataSettings;
}

/**
 * 共用資料基礎：每個工作負載帳號 1 把 KMS CMK + DynamoDB 單表（docs/09 §3.1、§5；ADR-018）。
 * Shared data foundation: one KMS CMK per workload account plus the single DynamoDB table.
 *
 * 其他 stack 透過 SSM 參數取得名稱與 ARN，而不是 CloudFormation Export，
 * 避免「被匯入的 Export 不能修改」造成 stack 互相卡住。
 * Other stacks read names/ARNs from SSM parameters instead of CloudFormation exports,
 * so an imported export never blocks changes to this stack.
 */
export class DataStack extends Stack {
  /**
   * 多用途 GSI（overloaded GSI，ADR-018 修訂、A1）。鍵名通用，值決定用途：
   *   商品目錄 gsi1pk = "CATALOG"、gsi1sk = "PRODUCT#<id>"（A1）
   *   訂單狀態 gsi1pk = "STATUS#<status>"、gsi1sk = "<ts>"（A2，docs/03 §6）
   * Overloaded GSI: generic key names; the values decide the access pattern.
   */
  public static readonly GSI1 = { indexName: 'gsi1', partitionKey: 'gsi1pk', sortKey: 'gsi1sk' } as const;

  public readonly key: kms.Key;
  public readonly table: dynamodb.TableV2;

  /** SSM 參數路徑前綴 / SSM parameter path prefix. */
  public static parameterPrefix(envName: EnvName): string {
    return `/brewline/${envName}/data`;
  }

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    const { envName, data } = props;
    const removalPolicy = data.retainOnDelete ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    // 1) KMS CMK：對稱金鑰、年度自動輪替。
    //    CDK 預設 key policy 把管理權交給帳號 root，實際存取由 IAM 決定；
    //    RCP rcp-data-perimeter 另外限制只有組織內的身分能使用 kms:*。
    // Symmetric CMK with yearly rotation. The default key policy delegates to IAM in this account;
    // the org RCP additionally limits kms:* to principals inside the organization.
    this.key = new kms.Key(this, 'DataKey', {
      alias: `alias/brewline-${envName}-data`,
      description: `BrewLine ${envName} data key (DynamoDB core table; later S3, SQS, SNS).`,
      enableKeyRotation: true,
      rotationPeriod: Duration.days(365),
      pendingWindow: Duration.days(data.keyPendingWindowDays),
      removalPolicy,
    });

    // 2) DynamoDB 單表。TableV2 → AWS::DynamoDB::GlobalTable（ADR-018）。
    //    鍵名用通用的 pk / sk，實體型別寫在值裡（TENANT#、PRODUCT#…），日後新增實體不必改 schema。
    //    GSI 一次 PR 只加一個（CloudFormation 每次更新只能新增一個 GSI）。
    // Generic pk/sk so new entity types never change the key schema.
    // One GSI per PR (CloudFormation adds at most one GSI per update).
    this.table = new dynamodb.TableV2(this, 'CoreTable', {
      tableName: `brewline-${envName}-core`,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand({
        maxReadRequestUnits: data.maxReadRequestUnits,
        maxWriteRequestUnits: data.maxWriteRequestUnits,
      }),
      tableClass: dynamodb.TableClass.STANDARD,
      encryption: dynamodb.TableEncryptionV2.customerManagedKey(this.key),
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
        recoveryPeriodInDays: data.pitrRecoveryDays,
      },
      deletionProtection: data.deletionProtection,
      timeToLiveAttribute: 'expires_at',
      // Streams（A3a）：事件的來源（CDC／交易外送箱，A3 決策 D1）。NEW_AND_OLD_IMAGES 才能判斷「狀態從 X 變成 Y」、
      // 「庫存跌破門檻」。**之後不要改 view type**：GlobalTable 有多個 replica 時無法修改，現在單一 replica 也要先停用再啟用。
      // Streams are the event source (CDC / transactional outbox). Old+new images let consumers detect transitions.
      // Do not change the view type later; it cannot be modified once the table has more than one replica.
      dynamoStream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      // GSI1：只有帶 gsi1pk 的項目會進索引（sparse）。projection ALL：項目小、讀取方便，儲存成本可忽略。
      // 最大吞吐量明確設成與資料表相同（COST-005）：CDK 不設時 template 不會出現上限 → 索引不受限。
      // 寫入上限不可低於資料表，否則 GSI 的反壓（back-pressure）會連帶節流資料表寫入。
      // GSI1 is sparse and ALL-projected. Max throughput is set explicitly (CDK omits it otherwise, leaving the
      // index uncapped); never cap GSI writes below the table, or index back-pressure throttles table writes.
      globalSecondaryIndexes: [
        {
          indexName: DataStack.GSI1.indexName,
          partitionKey: { name: DataStack.GSI1.partitionKey, type: dynamodb.AttributeType.STRING },
          sortKey: { name: DataStack.GSI1.sortKey, type: dynamodb.AttributeType.STRING },
          projectionType: dynamodb.ProjectionType.ALL,
          maxReadRequestUnits: data.maxReadRequestUnits,
          maxWriteRequestUnits: data.maxWriteRequestUnits,
        },
      ],
      removalPolicy,
    });

    // 表內之後會有聯絡人資料，因此以最高等級分類 / Will hold contact data, so classify at the highest level.
    Tags.of(this.table).add(DATA_CLASS_TAG, 'pii');

    // 3) 給其他 stack 使用的 SSM 參數（Standard tier，免費）/ Free Standard-tier parameters for consumers.
    const prefix = DataStack.parameterPrefix(envName);
    const params: Array<[string, string, string]> = [
      ['TableNameParam', 'table-name', this.table.tableName],
      ['TableArnParam', 'table-arn', this.table.tableArn],
      ['KeyArnParam', 'kms-key-arn', this.key.keyArn],
      ['TableStreamArnParam', 'table-stream-arn', this.table.tableStreamArn!],
    ];
    for (const [id, name, value] of params) {
      new ssm.StringParameter(this, id, {
        parameterName: `${prefix}/${name}`,
        stringValue: value,
        tier: ssm.ParameterTier.STANDARD,
        description: `BrewLine ${envName} shared data layer: ${name}`,
      });
    }

    // 部署後驗證用 / Used by the post-deploy verification step.
    new CfnOutput(this, 'TableName', { value: this.table.tableName });
    new CfnOutput(this, 'KeyArn', { value: this.key.keyArn });
  }
}
