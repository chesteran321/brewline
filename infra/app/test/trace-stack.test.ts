import { App } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { ENVIRONMENTS, TraceSettings } from '../lib/config';
import { TraceStack } from '../lib/stacks/trace-stack';

const make = (envName: 'dev' | 'prod', trace: TraceSettings = ENVIRONMENTS[envName].trace) => {
  const app = new App();
  const e = ENVIRONMENTS[envName];
  return new TraceStack(app, `brewline-${envName}-trace`, {
    envName,
    lambda: e.lambda,
    trace,
    env: { account: e.account, region: e.region },
  });
};
type Stmt = { Sid?: string; Effect: string; Action: string | string[]; Resource: unknown; Condition?: unknown };
const statements = (t: Template): Stmt[] =>
  Object.values(t.findResources('AWS::IAM::Policy')).flatMap((p) => p.Properties.PolicyDocument.Statement as Stmt[]);

describe.each(['dev', 'prod'] as const)('TraceStack (%s)', (envName) => {
  const stack = make(envName);
  const t = Template.fromStack(stack);
  const trace = ENVIRONMENTS[envName].trace;

  test('private bucket: block public access, SSE-S3, TLS only, owner-enforced, retained, data-class public', () => {
    t.hasResource('AWS::S3::Bucket', {
      DeletionPolicy: 'Retain',
      Properties: Match.objectLike({
        BucketName: `brewline-${envName}-trace-${ENVIRONMENTS[envName].account}`,
        PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
        BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] },
        OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
        Tags: Match.arrayWith([{ Key: 'data-class', Value: 'public' }]),
      }),
    });
    // 只有 CloudFront（本 distribution）能讀；沒有任何公開 Allow / Only this distribution may read.
    const policy = Object.values(t.findResources('AWS::S3::BucketPolicy'))[0]!.Properties.PolicyDocument.Statement as Stmt[];
    const allows = policy.filter((s) => s.Effect === 'Allow');
    expect(allows).toHaveLength(1);
    expect(allows[0]).toMatchObject({
      Action: 's3:GetObject',
      Principal: { Service: 'cloudfront.amazonaws.com' },
      Condition: { StringEquals: { 'AWS:SourceArn': expect.anything() } },
    });
    expect(JSON.stringify(allows[0]!.Condition)).toContain(':distribution/');
    expect(JSON.stringify(policy)).not.toContain('s3:ListBucket');
  });

  test('distribution: domain, us-east-1 certificate and web ACL from config, OAC, HTTPS only, managed policies, unknown token → 404', () => {
    t.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Aliases: [trace.domain],
        WebACLId: trace.edge!.webAclArn,
        ViewerCertificate: { AcmCertificateArn: trace.edge!.certificateArn, MinimumProtocolVersion: 'TLSv1.2_2021', SslSupportMethod: 'sni-only' },
        DefaultRootObject: 'index.html',
        DefaultCacheBehavior: Match.objectLike({
          ViewerProtocolPolicy: 'redirect-to-https',
          AllowedMethods: ['GET', 'HEAD'],
          CachePolicyId: '658327ea-f89d-4fab-a63d-7e88639e58f6', // Managed-CachingOptimized
          ResponseHeadersPolicyId: '67f7725c-6f97-4210-82d7-5512b31e9d03', // Managed-SecurityHeadersPolicy
        }),
        CustomErrorResponses: [
          { ErrorCode: 403, ResponseCode: 404, ResponsePagePath: '/404.html', ErrorCachingMinTTL: 60 },
          { ErrorCode: 404, ResponseCode: 404, ResponsePagePath: '/404.html', ErrorCachingMinTTL: 60 },
        ],
        Origins: [Match.objectLike({ OriginAccessControlId: Match.anyValue() })],
      }),
    });
    // 反向：Free 方案不支援的設定都沒有 / Negative: nothing the Free plan rejects.
    const cfg = JSON.stringify(Object.values(t.findResources('AWS::CloudFront::Distribution'))[0]!.Properties.DistributionConfig);
    for (const bad of ['ForwardedValues', 'Logging', 'OriginShield', 'LambdaFunctionAssociations', 'ContinuousDeploymentPolicyId', 'Staging', 'OriginGroups']) {
      expect(cfg).not.toContain(bad);
    }
    t.resourceCountIs('AWS::CloudFront::CachePolicy', 0);
    t.resourceCountIs('AWS::CloudFront::ResponseHeadersPolicy', 0);
    t.resourceCountIs('AWS::CloudFront::OriginRequestPolicy', 0);
    t.resourceCountIs('AWS::CloudFront::CloudFrontOriginAccessIdentity', 0);
  });

  test('Free plan subscription covers exactly this distribution and the web ACL', () => {
    t.hasResourceProperties('AWS::PricingPlanManager::Subscription', { PlanFamily: 'CloudFront', PlanTier: 'FREE', UsageLevel: 'DEFAULT' });
    const arns = Object.values(t.findResources('AWS::PricingPlanManager::Subscription'))[0]!.Properties.ResourceArns as unknown[];
    expect(arns).toHaveLength(2);
    expect(JSON.stringify(arns[0])).toMatch(/:cloudfront::.*:distribution\/.*"Ref":"Distribution/);
    expect(arns[1]).toBe(trace.edge!.webAclArn);
  });

  test('DNS: A and AAAA alias records for the trace domain in the configured zone', () => {
    for (const type of ['A', 'AAAA']) {
      t.hasResourceProperties('AWS::Route53::RecordSet', {
        Type: type,
        Name: `${trace.domain}.`,
        HostedZoneId: trace.hostedZoneId,
        AliasTarget: Match.objectLike({ DNSName: { 'Fn::GetAtt': [Match.stringLikeRegexp('Distribution'), 'DomainName'] } }),
      });
    }
  });

  test('projector: rule on roast events, GetItem on ROAST#/LOT#/PRODUCT# only, PutObject only under v1/, Scan denied', () => {
    t.hasResourceProperties('AWS::Events::Rule', {
      Name: `brewline-${envName}-trace-project`,
      EventPattern: { source: ['brewline.traceability'], 'detail-type': ['RoastBatchRoasted', 'RoastBatchRecalled'] },
    });
    const st = statements(t);
    expect(st.find((s) => s.Sid === 'ReadRoastLotProduct')).toMatchObject({
      Action: 'dynamodb:GetItem',
      Condition: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['ROAST#*', 'LOT#*', 'PRODUCT#*'] } },
    });
    expect(st.find((s) => s.Sid === 'DenyScan')).toMatchObject({ Effect: 'Deny', Action: 'dynamodb:Scan' });
    expect(JSON.stringify(st.find((s) => s.Sid === 'WriteProjections')!.Resource)).toContain('/v1/*');
    // 反向：沒有任何角色能刪除物件、列出 bucket、寫資料表或查詢（只有 GetItem）/ Negative.
    const actions = st.flatMap((s) => ([] as string[]).concat(s.Action));
    for (const bad of ['s3:DeleteObject', 's3:ListBucket', 's3:*', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Query', 'dynamodb:BatchGetItem']) {
      expect(actions).not.toContain(bad);
    }
  });

  test('site publisher writes only the fixed site files (never v1/)', () => {
    const site = statements(t).find((s) => s.Sid === 'WriteSiteFiles')!;
    const res = JSON.stringify(site.Resource);
    for (const f of ['index.html', 'app.js', 'app.css', '404.html', 'robots.txt']) expect(res).toContain(`/${f}`);
    expect(res).not.toContain('v1/');
    expect(res).not.toContain('/*');
    t.hasResourceProperties('Custom::BrewlineTraceSite', { Files: Match.arrayWith([Match.objectLike({ Key: 'index.html' })]) });
  });

  test('one alarm (projector DLQ); outputs; no synth errors', () => {
    t.hasResourceProperties('AWS::CloudWatch::Alarm', { AlarmName: `brewline-${envName}-trace-projector-dlq-not-empty` });
    // 免費額度 10 個告警（ADR-030 D9）：這個 stack 只用 1 個 / One alarm only (10 free per account).
    t.resourceCountIs('AWS::CloudWatch::Alarm', 1);
    for (const o of ['TraceUrl', 'DistributionId', 'BucketName', 'FreePlanSubscriptionArn', 'ProjectorFunctionName']) expect(t.findOutputs(o)).not.toEqual({});
    expect(Annotations.fromStack(stack).findError('*', Match.anyValue())).toEqual([]);
  });
});

describe('TraceStack negative', () => {
  const dev = ENVIRONMENTS.dev.trace;
  test('requires the edge ARNs (two-phase deploy)', () => {
    expect(() => make('dev', { ...dev, edge: undefined })).toThrow(/trace.edge is required/);
  });
  test('rejects a certificate outside us-east-1', () => {
    expect(() => make('dev', { ...dev, edge: { ...dev.edge!, certificateArn: dev.edge!.certificateArn.replace('us-east-1', 'ap-east-2') } })).toThrow(/us-east-1/);
  });
  test('rejects edge ARNs from another account', () => {
    expect(() => make('dev', ENVIRONMENTS.prod.trace)).toThrow(/belongs to account/);
  });
  test('rejects a REGIONAL web ACL', () => {
    expect(() => make('dev', { ...dev, edge: { ...dev.edge!, webAclArn: dev.edge!.webAclArn.replace(':global/', ':regional/') } })).toThrow(/CLOUDFRONT/);
  });
});
