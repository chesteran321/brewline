import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { mockClient } from 'aws-sdk-client-mock';
import { TenantCredentials, TenantIsolationError } from '../src/lib/tenant-credentials';

const sts = mockClient(STSClient);
const A = `t_${'A'.repeat(26)}`;
const B = `t_${'B'.repeat(26)}`;
const ROLE = 'arn:aws:iam::111111111111:role/brewline-dev-tenant-access';

const creds = (expiresAt: number) => ({
  Credentials: { AccessKeyId: 'AKIA', SecretAccessKey: 's', SessionToken: 't', Expiration: new Date(expiresAt) },
});

beforeEach(() => sts.reset());

test('assumes the tenant role with exactly one tenant_id session tag', async () => {
  sts.on(AssumeRoleCommand).resolves(creds(3_600_000));
  const tc = new TenantCredentials(new STSClient({ region: 'ap-east-2' }), ROLE, 'create-order', () => 0);
  await tc.get(A);
  const input = sts.commandCalls(AssumeRoleCommand)[0]!.args[0].input;
  expect(input).toMatchObject({ RoleArn: ROLE, DurationSeconds: 3600, Tags: [{ Key: 'tenant_id', Value: A }] });
  expect(input.Tags).toHaveLength(1);
  expect(input.RoleSessionName).toBe(`create-order.${A}`);
  expect(input.RoleSessionName!.length).toBeLessThanOrEqual(64);
});

test('caches per tenant, shares concurrent calls, refreshes near expiry', async () => {
  let now = 0;
  sts.on(AssumeRoleCommand).resolves(creds(3_600_000));
  const tc = new TenantCredentials(new STSClient({ region: 'ap-east-2' }), ROLE, 'x', () => now);
  await Promise.all([tc.get(A), tc.get(A), tc.get(A)]);
  expect(sts.commandCalls(AssumeRoleCommand)).toHaveLength(1);
  await tc.get(B); // 另一個租戶 → 另一份憑證 / another tenant → separate credentials
  expect(sts.commandCalls(AssumeRoleCommand)).toHaveLength(2);
  now = 3_600_000 - 4 * 60 * 1000; // 到期前 4 分鐘 → 更新 / 4 min before expiry → refresh
  await tc.get(A);
  expect(sts.commandCalls(AssumeRoleCommand)).toHaveLength(3);
});

test('a failed AssumeRole is not cached', async () => {
  sts.on(AssumeRoleCommand).rejectsOnce(new Error('AccessDenied')).resolves(creds(3_600_000));
  const tc = new TenantCredentials(new STSClient({ region: 'ap-east-2' }), ROLE, 'x', () => 0);
  await expect(tc.get(A)).rejects.toThrow('AccessDenied');
  await expect(tc.get(A)).resolves.toMatchObject({ accessKeyId: 'AKIA' });
});

// 反向：格式不對的 tenant_id 根本不會送到 STS / Malformed tenant ids never reach STS.
test.each(['t_1', 't_' + 'a'.repeat(26), `t_${'A'.repeat(26)}x`, '', 'TENANT#x'])('rejects tenant id %p', async (bad) => {
  const tc = new TenantCredentials(new STSClient({ region: 'ap-east-2' }), ROLE, 'x');
  await expect(tc.get(bad)).rejects.toBeInstanceOf(TenantIsolationError);
  expect(sts.commandCalls(AssumeRoleCommand)).toHaveLength(0);
});
