import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as iam from 'aws-cdk-lib/aws-iam';
import { TenantAccessRole } from '../lib/constructs/tenant-access-role';

function build() {
  const app = new App();
  const stack = new Stack(app, 'T', { env: { account: '111111111111', region: 'ap-east-2' } });
  const ta = new TenantAccessRole(stack, 'TA', {
    envName: 'dev',
    tableArn: 'arn:aws:dynamodb:ap-east-2:111111111111:table/brewline-dev-core',
    keyArn: 'arn:aws:kms:ap-east-2:111111111111:key/abc',
  });
  return { stack, ta };
}

const policyStatements = (t: Template) =>
  (Object.values(t.findResources('AWS::IAM::Policy')) as any[]).flatMap((p) => p.Properties.PolicyDocument.Statement);
const trustStatements = (t: Template) =>
  (Object.values(t.findResources('AWS::IAM::Role')) as any[])[0].Properties.AssumeRolePolicyDocument.Statement;

describe('TenantAccessRole', () => {
  const { stack } = build();
  const t = Template.fromStack(stack);

  test('fixed name, 1-hour max session', () => {
    t.hasResourceProperties('AWS::IAM::Role', { RoleName: 'brewline-dev-tenant-access', MaxSessionDuration: 3600 });
  });

  test('trust: only brewline-<env>-orders-* roles, exactly one tenant_id tag of the right length', () => {
    const st = trustStatements(t);
    expect(st.map((s: any) => s.Action).sort()).toEqual(['sts:AssumeRole', 'sts:TagSession']);
    for (const s of st) {
      expect(JSON.stringify(s.Principal)).toContain(':iam::111111111111:root');
      expect(s.Condition.ArnLike['aws:PrincipalArn']).toBe('arn:aws:iam::111111111111:role/brewline-dev-orders-*');
      expect(s.Condition.StringLike['aws:RequestTag/tenant_id']).toBe(`t_${'?'.repeat(26)}`);
      expect(s.Condition['ForAllValues:StringEquals']['aws:TagKeys']).toEqual(['tenant_id']);
    }
  });

  test('own tenant: exact LeadingKeys match on the principal tag (no trailing wildcard)', () => {
    const own = policyStatements(t).find((s) => s.Sid === 'OwnTenantItems');
    expect(own.Condition).toEqual({
      'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': ['TENANT#${aws:PrincipalTag/tenant_id}'] },
    });
    expect(JSON.stringify(own.Condition)).not.toMatch(/TENANT#[^"]*\*/);
  });

  test('products: read-only, plus UpdateItem limited to stock attributes', () => {
    const st = policyStatements(t);
    const read = st.find((s) => s.Sid === 'ReadProducts');
    expect([].concat(read.Action).sort()).toEqual(['dynamodb:BatchGetItem', 'dynamodb:GetItem']);
    const upd = st.find((s) => s.Sid === 'ReserveStockOnly');
    expect(upd.Action).toBe('dynamodb:UpdateItem');
    const attrs: string[] = upd.Condition['ForAllValues:StringEquals']['dynamodb:Attributes'];
    expect(attrs).toEqual(['pk', 'sk', 'available_kg', 'reserved_kg', 'version', 'updated_at']);
    // 反向：價格不可改 / Negative: price is not updatable.
    expect(attrs).not.toContain('price_per_kg');
    expect(upd.Condition.StringEqualsIfExists['dynamodb:ReturnValues']).not.toContain('ALL_NEW');
  });

  // 反向 / Negative
  test('no Scan, no Delete, no wildcard actions; Scan explicitly denied', () => {
    const st = policyStatements(t);
    const allowed = st.filter((s) => s.Effect === 'Allow').flatMap((s) => [].concat(s.Action));
    for (const bad of ['dynamodb:Scan', 'dynamodb:DeleteItem', 'dynamodb:*', 'kms:*', 'dynamodb:BatchWriteItem']) {
      expect(allowed).not.toContain(bad);
    }
    expect(st).toContainEqual(expect.objectContaining({ Sid: 'DenyScan', Effect: 'Deny', Action: 'dynamodb:Scan' }));
  });

  test('KMS only via DynamoDB', () => {
    const kms = policyStatements(t).find((s) => s.Sid === 'KeyViaDynamoDB');
    expect(kms.Condition).toEqual({ StringEquals: { 'kms:ViaService': 'dynamodb.ap-east-2.amazonaws.com' } });
  });

  test('grantAssume gives sts:AssumeRole + sts:TagSession on this role only', () => {
    const { stack: s2, ta } = build();
    const caller = new iam.Role(s2, 'Caller', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
    ta.grantAssume(caller);
    const st = policyStatements(Template.fromStack(s2)).find((x) => ([] as string[]).concat(x.Action).includes('sts:AssumeRole'));
    expect([].concat(st.Action).sort()).toEqual(['sts:AssumeRole', 'sts:TagSession']);
    expect(st.Resource).toEqual({ 'Fn::GetAtt': [expect.stringMatching(/^TARole/), 'Arn'] });
  });
});
