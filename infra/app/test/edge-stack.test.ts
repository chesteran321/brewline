import { App } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { ENVIRONMENTS } from '../lib/config';
import { EdgeStack, FREE_PLAN_MAX_WAF_RULES } from '../lib/stacks/edge-stack';

const make = (envName: 'dev' | 'prod', region = 'us-east-1', trace = ENVIRONMENTS[envName].trace) => {
  const app = new App();
  return new EdgeStack(app, `brewline-${envName}-edge`, {
    envName,
    trace,
    env: { account: ENVIRONMENTS[envName].account, region },
  });
};

describe.each(['dev', 'prod'] as const)('EdgeStack (%s)', (envName) => {
  const stack = make(envName);
  const template = Template.fromStack(stack);
  const trace = ENVIRONMENTS[envName].trace;

  test('DNS-validated certificate for the trace domain in this account’s zone (native CloudFormation, no Lambda)', () => {
    template.hasResourceProperties('AWS::CertificateManager::Certificate', {
      DomainName: trace.domain,
      ValidationMethod: 'DNS',
      DomainValidationOptions: [{ DomainName: trace.domain, HostedZoneId: trace.hostedZoneId }],
    });
    // 反向：沒有萬用字元或額外名稱 / Negative: no wildcard or extra names.
    expect(template.findResources('AWS::CertificateManager::Certificate')).toEqual(
      expect.not.objectContaining({ SubjectAlternativeNames: expect.anything() }),
    );
    template.resourceCountIs('AWS::Lambda::Function', 0);
  });

  test('CLOUDFRONT web ACL: rate limit per IP, IP reputation, core rule set; all enforcing; within the Free plan', () => {
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      Scope: 'CLOUDFRONT',
      DefaultAction: { Allow: {} },
      Rules: [
        Match.objectLike({
          Name: 'RateLimitPerIp',
          Action: { Block: {} },
          Statement: { RateBasedStatement: { Limit: trace.rateLimitPer5Min, AggregateKeyType: 'IP', EvaluationWindowSec: 300 } },
        }),
        Match.objectLike({ Name: 'AWSManagedRulesAmazonIpReputationList', OverrideAction: { None: {} } }),
        Match.objectLike({ Name: 'AWSManagedRulesCommonRuleSet', OverrideAction: { None: {} } }),
      ],
    });
    const rules = Object.values(template.findResources('AWS::WAFv2::WebACL'))[0]!.Properties.Rules as unknown[];
    expect(rules.length).toBeLessThanOrEqual(FREE_PLAN_MAX_WAF_RULES);
  });

  test('ARNs published as SSM parameters and outputs; no synth errors (termination protection is set in bin/app.ts, checked by verify)', () => {
    for (const p of ['trace-certificate-arn', 'trace-web-acl-arn']) {
      template.hasResourceProperties('AWS::SSM::Parameter', { Name: `/brewline/${envName}/edge/${p}` });
    }
    for (const o of ['TraceCertificateArn', 'TraceWebAclArn', 'TraceDomain']) expect(template.findOutputs(o)).not.toEqual({});
    expect(Annotations.fromStack(stack).findError('*', Match.anyValue())).toEqual([]);
  });
});

describe('EdgeStack negative', () => {
  test('refuses any region other than us-east-1', () => {
    expect(() => make('dev', 'ap-east-2')).toThrow('us-east-1');
  });
  test('refuses a trace domain outside the hosted zone', () => {
    expect(() => make('dev', 'us-east-1', { ...ENVIRONMENTS.dev.trace, domain: 'trace.example.com' })).toThrow('not inside zone');
  });
  test('config: trace domains sit in each account’s own zone; Prod zone matches the mail zone', () => {
    expect(ENVIRONMENTS.prod.trace.hostedZoneId).toBe(ENVIRONMENTS.prod.mail.hostedZoneId);
    expect(ENVIRONMENTS.dev.trace.hostedZoneName).toBe(ENVIRONMENTS.dev.mail.domain);
    expect(new Set([ENVIRONMENTS.dev.trace.domain, ENVIRONMENTS.prod.trace.domain]).size).toBe(2);
  });
});
