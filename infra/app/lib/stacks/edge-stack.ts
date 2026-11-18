import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';
import { EnvName, TraceSettings } from '../config';

export interface EdgeStackProps extends StackProps {
  readonly envName: EnvName;
  readonly trace: TraceSettings;
}

/** CloudFront Free 方案最多 5 條 WAF 規則；保留餘裕 / The Free plan allows 5 WAF rules; keep headroom. */
export const FREE_PLAN_MAX_WAF_RULES = 5;

/**
 * 溯源公開頁的 us-east-1 資源（S2b，ADR-031 D3／D4）。
 * us-east-1 resources for the public trace page.
 *
 * - ACM 憑證：`trace.<網域>`，DNS 驗證，驗證記錄寫入本帳號的 hosted zone（原生 CloudFormation，不需要 Lambda）。
 * - WAF web ACL（scope CLOUDFRONT）：3 條規則，在 Free 方案上限 5 條之內：
 *   1. 每個 IP 每 5 分鐘的請求上限 → 封鎖（防止有人大量猜 token，TRC-N-004）
 *   2. AWS 管理規則：IP 信譽清單（已知惡意來源）
 *   3. AWS 管理規則：核心規則集（常見攻擊樣式）
 * - 費用：distribution 訂閱 Free 方案後，web ACL、規則、請求費都包含在方案內（0 元）；**S2c 之前**是 pay-as-you-go
 *   （每個 web ACL 每月 USD 5＋每條規則 USD 1，按時間比例）→ S2c 要緊接著做。
 * - 兩個 ARN 輸出後要手動填進 config `trace.edge`（兩階段，與 ADR-029 E2 的網域委派相同），S2c 的台北 stack 才用得到。
 *
 * - Certificate: DNS-validated in this account's zone (native CloudFormation, no Lambda).
 * - Web ACL (CLOUDFRONT scope): 3 rules within the Free plan's 5. Covered by the plan once subscribed (S2c);
 *   until then it is pay-as-you-go, so S2c should follow promptly.
 */
export class EdgeStack extends Stack {
  public readonly certificate: acm.Certificate;
  public readonly webAcl: wafv2.CfnWebACL;

  public static parameterPrefix(envName: EnvName): string {
    return `/brewline/${envName}/edge`;
  }

  constructor(scope: Construct, id: string, props: EdgeStackProps) {
    super(scope, id, props);
    const { envName, trace } = props;
    if (this.region !== 'us-east-1') throw new Error('EdgeStack must be deployed to us-east-1 (CloudFront certificates and web ACLs)');

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
      hostedZoneId: trace.hostedZoneId,
      zoneName: trace.hostedZoneName,
    });
    if (!trace.domain.endsWith(`.${trace.hostedZoneName}`)) {
      throw new Error(`Trace domain ${trace.domain} is not inside zone ${trace.hostedZoneName}`);
    }

    this.certificate = new acm.Certificate(this, 'TraceCertificate', {
      certificateName: `brewline-${envName}-trace`,
      domainName: trace.domain,
      validation: acm.CertificateValidation.fromDns(zone),
    });

    const metric = (name: string): wafv2.CfnWebACL.VisibilityConfigProperty => ({
      cloudWatchMetricsEnabled: true,
      metricName: `brewline-${envName}-trace-${name}`,
      sampledRequestsEnabled: true,
    });
    const managed = (priority: number, name: string): wafv2.CfnWebACL.RuleProperty => ({
      name,
      priority,
      overrideAction: { none: {} },
      statement: { managedRuleGroupStatement: { vendorName: 'AWS', name } },
      visibilityConfig: metric(name),
    });

    const rules: wafv2.CfnWebACL.RuleProperty[] = [
      {
        name: 'RateLimitPerIp',
        priority: 0,
        action: { block: {} },
        statement: {
          rateBasedStatement: { limit: trace.rateLimitPer5Min, aggregateKeyType: 'IP', evaluationWindowSec: 300 },
        },
        visibilityConfig: metric('RateLimitPerIp'),
      },
      managed(1, 'AWSManagedRulesAmazonIpReputationList'),
      managed(2, 'AWSManagedRulesCommonRuleSet'),
    ];
    if (rules.length > FREE_PLAN_MAX_WAF_RULES) throw new Error(`The Free plan allows at most ${FREE_PLAN_MAX_WAF_RULES} WAF rules`);

    this.webAcl = new wafv2.CfnWebACL(this, 'TraceWebAcl', {
      name: `brewline-${envName}-trace`,
      description: 'BrewLine public trace page - CloudFront Free plan - per-IP rate limit, IP reputation, core rule set',
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      visibilityConfig: metric('WebAcl'),
      rules,
    });

    // 參考用（S2c 讀的是 config，不跨區讀 SSM）/ For reference; S2c reads config, not cross-region SSM.
    const prefix = EdgeStack.parameterPrefix(envName);
    new ssm.StringParameter(this, 'CertificateArnParam', {
      parameterName: `${prefix}/trace-certificate-arn`,
      stringValue: this.certificate.certificateArn,
      description: 'ACM certificate (us-east-1) for the public trace page',
    });
    new ssm.StringParameter(this, 'WebAclArnParam', {
      parameterName: `${prefix}/trace-web-acl-arn`,
      stringValue: this.webAcl.attrArn,
      description: 'WAF web ACL (CLOUDFRONT) for the public trace page',
    });

    new CfnOutput(this, 'TraceDomain', { value: trace.domain });
    new CfnOutput(this, 'TraceCertificateArn', { value: this.certificate.certificateArn });
    new CfnOutput(this, 'TraceWebAclArn', { value: this.webAcl.attrArn });
    new CfnOutput(this, 'TraceWebAclRuleCount', { value: String(rules.length) });
  }
}
