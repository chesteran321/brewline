import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { Arn, ArnFormat, CfnOutput, CustomResource, Duration, RemovalPolicy, Stack, StackProps, Tags, Token, Validations } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as destinations from 'aws-cdk-lib/aws-lambda-destinations';
import * as pricing from 'aws-cdk-lib/aws-pricingplanmanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { SITE_FILES } from '../../../../services/traceability/src/site-publisher';
import { DATA_CLASS_TAG, EDGE_REGION, EnvName, LambdaSettings, TraceSettings } from '../config';
import { BrewlineFunction, SERVICES_ROOT } from '../constructs/brewline-function';
import { deployTimeProvider } from '../constructs/deploy-time-provider';
import { DataStack } from './data-stack';
import { EventsStack } from './events-stack';
import { notifyAlarms } from './ops-stack';

export interface TraceStackProps extends StackProps {
  readonly envName: EnvName;
  readonly lambda: LambdaSettings;
  readonly trace: TraceSettings;
}

/** 投影觸發的事件（stream publisher，source brewline.traceability）/ Events that trigger a projection. */
export const TRACE_EVENT_TYPES = ['RoastBatchRoasted', 'RoastBatchRecalled'] as const;

/** 投影的 S3 前綴（與 services/traceability/src/projection.ts 相同）/ Projection prefix. */
export const PROJECTION_PREFIX = 'v1/';

/**
 * 公開溯源頁（S2c，ADR-031 D2–D4）：S3（只經 OAC 讀取）＋ CloudFront（us-east-1 的憑證與 web ACL）＋
 * 統一費率 Free 方案訂閱 ＋ 投影函數 ＋ 靜態頁 ＋ DNS。
 * Public trace page: private S3 bucket read only through OAC, CloudFront with the us-east-1 certificate and web ACL,
 * the flat-rate Free plan subscription, the projector, the static page and DNS.
 *
 * 讀取路徑只有 CloudFront → S3：沒有 Lambda、API、DynamoDB（D2）→ 列舉 token 不會產生 Lambda 錯誤或資料庫讀取，
 * 只會被 WAF 的每 IP 速率規則擋下（TRC-N-004）。
 * The read path is CloudFront → S3 only, so token enumeration costs no Lambda or database reads and is rate-limited by WAF.
 */
export class TraceStack extends Stack {
  public static parameterPrefix(envName: EnvName): string {
    return `/brewline/${envName}/trace`;
  }

  constructor(scope: Construct, id: string, props: TraceStackProps) {
    super(scope, id, props);
    const { envName, trace } = props;
    if (!trace.edge) throw new Error('trace.edge is required: deploy the edge stack (S2b) and copy its outputs into config');
    for (const [name, arn] of Object.entries(trace.edge)) {
      const parts = Arn.split(arn, ArnFormat.SLASH_RESOURCE_NAME);
      if (parts.region !== EDGE_REGION) throw new Error(`trace.edge.${name} must be in ${EDGE_REGION} (CloudFront requirement)`);
      if (!Token.isUnresolved(this.account) && parts.account !== this.account) {
        throw new Error(`trace.edge.${name} belongs to account ${parts.account}, not ${this.account}`);
      }
    }
    if (!trace.edge.webAclArn.includes(':global/webacl/')) throw new Error('trace.edge.webAclArn must be a CLOUDFRONT (global) web ACL');

    const param = (name: string) => ssm.StringParameter.valueForStringParameter(this, name);
    const dataPrefix = DataStack.parameterPrefix(envName);
    const tableName = param(`${dataPrefix}/table-name`);
    const tableArn = param(`${dataPrefix}/table-arn`);
    const keyArn = param(`${dataPrefix}/kms-key-arn`);
    const busArn = param(`${EventsStack.parameterPrefix(envName)}/bus-arn`);

    // --- 1) Bucket：私有，只有 CloudFront（OAC）讀得到 / Private; only CloudFront (OAC) can read it ---
    // SSE-S3：內容本來就要公開，用 CMK 只會讓 CloudFront 需要 KMS 權限，沒有額外保護。
    // SSE-S3: the content is public by design; a CMK would only require granting CloudFront KMS access.
    const bucket = new s3.Bucket(this, 'SiteBucket', {
      bucketName: `brewline-${envName}-trace-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      minimumTLSVersion: 1.2,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      // 投影可以從資料表重建，但保留 bucket 避免誤刪 stack 時公開頁全部 404 / Keep it so a stack delete never 404s every bag.
      removalPolicy: RemovalPolicy.RETAIN,
    });
    // 只放公開頁的內容（白名單投影＋靜態檔）/ Holds only public content.
    Tags.of(bucket).add(DATA_CLASS_TAG, 'public');
    Validations.of(bucket).acknowledge({
      id: 'AwsSolutions-S1',
      reason: 'Public, derived content (projections rebuilt from DynamoDB, static page from the repo); writes come only from two Lambda roles whose calls are in CloudTrail. Server access logs would cost more than the bucket.',
    });

    // --- 2) CloudFront（ADR-031 D3）---
    // Free 方案只能用 managed 政策：CachingOptimized 會遵守原點的 Cache-Control（投影 max-age=300）。
    // The Free plan allows managed policies only; CachingOptimized honours the origin max-age (300 s).
    const certificate = acm.Certificate.fromCertificateArn(this, 'Certificate', trace.edge.certificateArn);
    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `BrewLine ${envName} public trace page (ADR-031)`,
      domainNames: [trace.domain],
      certificate,
      webAclId: trace.edge.webAclArn,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      defaultRootObject: 'index.html',
      enableIpv6: true,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        compress: true,
      },
      // 不存在的 token：S3 對沒有 ListBucket 的讀取回 403 → 一律 404，回應內容與時間一致（TRC-N-004）
      // Unknown tokens: S3 returns 403 without ListBucket → always 404 with the same small body.
      errorResponses: [403, 404].map((httpStatus) => ({
        httpStatus,
        responseHttpStatus: 404,
        responsePagePath: '/404.html',
        ttl: Duration.minutes(1),
      })),
    });
    Validations.of(distribution).acknowledge(
      { id: 'AwsSolutions-CFR1', reason: 'A public QR page for any buyer of the coffee; no geographic restriction is intended.' },
      { id: 'AwsSolutions-CFR3', reason: 'The CloudFront flat-rate Free plan does not include standard access logs (ADR-031 D3); WAF metrics and CloudWatch distribution metrics are used instead.' },
    );

    // --- 3) 統一費率 Free 方案（D3）：剛好 1 個 distribution＋1 個 web ACL / Exactly one distribution and one web ACL ---
    const plan = new pricing.CfnSubscription(this, 'FreePlan', {
      planFamily: 'CloudFront',
      planTier: 'FREE',
      usageLevel: 'DEFAULT',
      resourceArns: [distribution.distributionArn, trace.edge.webAclArn],
    });

    // --- 4) DNS ---
    const zone = route53.PublicHostedZone.fromPublicHostedZoneAttributes(this, 'Zone', {
      hostedZoneId: trace.hostedZoneId,
      zoneName: trace.hostedZoneName,
    });
    const recordName = trace.domain === trace.hostedZoneName ? undefined : trace.domain.slice(0, -(trace.hostedZoneName.length + 1));
    const alias = route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(distribution));
    new route53.ARecord(this, 'AliasA', { zone, recordName, target: alias });
    new route53.AaaaRecord(this, 'AliasAaaa', { zone, recordName, target: alias });

    // --- 5) 投影函數 / Projector ---
    const dlq = new sqs.Queue(this, 'ProjectorDlq', {
      queueName: `brewline-${envName}-trace-projector-dlq`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
    });
    Validations.of(dlq).acknowledge({ id: 'AwsSolutions-SQS3', reason: 'This queue is itself the dead-letter queue for the trace projector.' });

    const projector = new BrewlineFunction(this, 'Projector', {
      envName,
      lambda: props.lambda,
      module: 'traceability',
      name: 'trace-projector',
      entry: 'traceability/src/projector.ts',
      description: 'RoastBatchRoasted/Recalled → allow-listed public JSON in S3 (ADR-031 D2)',
      reservedConcurrency: props.lambda.reservedConcurrency.traceProjector,
      environment: { TABLE_NAME: tableName, BUCKET_NAME: bucket.bucketName, POWERTOOLS_SERVICE_NAME: 'traceability-trace-projector' },
    });
    projector.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadRoastLotProduct',
        actions: ['dynamodb:GetItem'],
        resources: [tableArn],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['ROAST#*', 'LOT#*', 'PRODUCT#*'] } },
      }),
    );
    projector.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'DenyScan',
        effect: iam.Effect.DENY,
        actions: ['dynamodb:Scan'],
        resources: [tableArn, `${tableArn}/index/*`],
      }),
    );
    projector.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'DecryptViaDynamoDB',
        actions: ['kms:Decrypt'],
        resources: [keyArn],
        conditions: { StringEquals: { 'kms:ViaService': `dynamodb.${this.region}.amazonaws.com` } },
      }),
    );
    projector.role.addToPolicy(
      new iam.PolicyStatement({ sid: 'WriteProjections', actions: ['s3:PutObject'], resources: [bucket.arnForObjects(`${PROJECTION_PREFIX}*`)] }),
    );
    Validations.of(projector.role).acknowledge({
      id: `AwsSolutions-IAM5[Resource::<${this.getLogicalId(bucket.node.defaultChild as s3.CfnBucket)}.Arn>/${PROJECTION_PREFIX}*]`,
      reason: 'One object per QR token under v1/; the token is random, so the key cannot be narrowed further.',
    });
    projector.function.configureAsyncInvoke({ retryAttempts: 2, maxEventAge: Duration.hours(6), onFailure: new destinations.SqsDestination(dlq) });

    new events.Rule(this, 'ProjectRule', {
      eventBus: events.EventBus.fromEventBusArn(this, 'Bus', busArn),
      ruleName: `brewline-${envName}-trace-project`,
      description: 'Roast batch roasted or recalled → public trace projection (S2c)',
      eventPattern: { source: ['brewline.traceability'], detailType: [...TRACE_EVENT_TYPES] },
      targets: [new targets.LambdaFunction(projector.function, { deadLetterQueue: dlq, retryAttempts: 3, maxEventAge: Duration.hours(2) })],
    });

    // --- 6) 靜態頁（部署時發布）/ Static page, published at deploy time ---
    const siteFn = new BrewlineFunction(this, 'SitePublisher', {
      envName,
      lambda: props.lambda,
      module: 'traceability',
      name: 'site-publisher',
      entry: 'traceability/src/site-publisher.ts',
      description: 'Deploy-time: publish the static trace page files (fixed keys only)',
      reservedConcurrency: props.lambda.reservedConcurrency.customResource,
      timeout: Duration.seconds(30),
      environment: { POWERTOOLS_SERVICE_NAME: 'traceability-site-publisher' },
    });
    siteFn.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'WriteSiteFiles',
        actions: ['s3:PutObject'],
        resources: Object.keys(SITE_FILES).map((k) => bucket.arnForObjects(k)),
      }),
    );
    const siteDir = path.join(SERVICES_ROOT, 'traceability', 'site');
    const files = Object.keys(SITE_FILES).map((Key) => ({ Key, Body: readFileSync(path.join(siteDir, Key)).toString('base64') }));
    const site = new CustomResource(this, 'Site', {
      serviceToken: deployTimeProvider(this, 'SiteProvider', siteFn).serviceToken,
      resourceType: 'Custom::BrewlineTraceSite',
      properties: {
        BucketName: bucket.bucketName,
        Files: files,
        SiteHash: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
      },
    });
    site.node.addDependency(bucket);

    // --- 7) 告警 / Alarms ---
    new cloudwatch.Alarm(this, 'ProjectorDlqAlarm', {
      alarmName: `brewline-${envName}-trace-projector-dlq-not-empty`,
      alarmDescription: 'Roast batches whose public trace page could not be written after retries (S2c).',
      metric: dlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5), statistic: 'Maximum' }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    // 不另設 Errors 告警：免費額度只有 10 個告警（ADR-030 D9），失敗重試後一定會進 DLQ → 一個 DLQ 告警就涵蓋。
    // No separate Errors alarm: only 10 alarms are free, and every failure ends in the DLQ after retries.
    notifyAlarms(this, envName);

    // --- 8) 參數與輸出 / Parameters and outputs ---
    const prefix = TraceStack.parameterPrefix(envName);
    new ssm.StringParameter(this, 'DomainParam', { parameterName: `${prefix}/domain`, stringValue: trace.domain, description: 'Public trace page domain (QR codes point to https://<domain>/#<token>)' });
    new ssm.StringParameter(this, 'BucketParam', { parameterName: `${prefix}/bucket-name`, stringValue: bucket.bucketName, description: 'Trace projection bucket' });
    new ssm.StringParameter(this, 'DistributionParam', { parameterName: `${prefix}/distribution-id`, stringValue: distribution.distributionId, description: 'Trace CloudFront distribution' });

    new CfnOutput(this, 'TraceDomain', { value: trace.domain });
    new CfnOutput(this, 'TraceUrl', { value: `https://${trace.domain}/` });
    new CfnOutput(this, 'BucketName', { value: bucket.bucketName });
    new CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
    new CfnOutput(this, 'DistributionDomainName', { value: distribution.distributionDomainName });
    new CfnOutput(this, 'WebAclArn', { value: trace.edge.webAclArn });
    new CfnOutput(this, 'CertificateArn', { value: trace.edge.certificateArn });
    new CfnOutput(this, 'FreePlanSubscriptionArn', { value: plan.attrArn });
    new CfnOutput(this, 'FreePlanTier', { value: plan.attrCurrentPlanTier });
    new CfnOutput(this, 'ProjectorFunctionName', { value: projector.function.functionName });
    new CfnOutput(this, 'ProjectorDlqUrl', { value: dlq.queueUrl });
    new CfnOutput(this, 'SiteFiles', { value: site.getAttString('Files') });
  }
}
