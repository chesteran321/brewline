import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { DeleteParameterCommand, GetParameterCommand, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { mockClient } from 'aws-sdk-client-mock';
import { deprovision, handler, provision, ProvisionProps, setClientsForTesting } from '../src/provision';
import { simUsers } from '../src/tenants';

const cog = mockClient(CognitoIdentityProviderClient);
const ssm = mockClient(SSMClient);
setClientsForTesting(new CognitoIdentityProviderClient({ region: 'ap-east-2' }), new SSMClient({ region: 'ap-east-2' }));

const P: ProvisionProps = {
  userPoolId: 'pool', poolSize: 3, seed: 'seed', credentialsParam: '/b/dev/simulator/credentials',
  stateParam: '/b/dev/simulator/state', kmsKeyId: 'arn:key', retainOnDelete: false,
};
const users = simUsers('seed', 3);
const existing = (tenant: string) => ({ UserAttributes: [{ Name: 'custom:tenant_id', Value: tenant }] });
const notFound = Object.assign(new Error('x'), { name: 'UserNotFoundException' });
const paramNotFound = Object.assign(new Error('x'), { name: 'ParameterNotFound' });
const exists = Object.assign(new Error('x'), { name: 'ParameterAlreadyExists' });

beforeEach(() => {
  cog.reset();
  ssm.reset();
  cog.on(AdminGetUserCommand).rejects(notFound);
  ssm.on(GetParameterCommand).rejects(paramNotFound);
  ssm.on(PutParameterCommand).resolves({});
});

const credentialsPut = () =>
  ssm.commandCalls(PutParameterCommand).map((c) => c.args[0].input).find((i) => i.Name === P.credentialsParam);
const statePut = () => ssm.commandCalls(PutParameterCommand).map((c) => c.args[0].input).find((i) => i.Name === P.stateParam);

test('first run: creates every account in the simulator group with its seeded tenant, stores passwords encrypted', async () => {
  const r = await provision(P);
  expect(r).toEqual({ users: 3, created: 3, passwordsSet: 3, stateCreated: true });
  const creates = cog.commandCalls(AdminCreateUserCommand).map((c) => c.args[0].input);
  expect(creates.map((c) => c.Username)).toEqual(users.map((u) => u.username));
  expect(creates[0]).toMatchObject({ MessageAction: 'SUPPRESS' });
  expect(creates[0]!.UserAttributes).toContainEqual({ Name: 'custom:tenant_id', Value: users[0]!.tenantId });
  expect(cog.commandCalls(AdminAddUserToGroupCommand).every((c) => c.args[0].input.GroupName === 'simulator')).toBe(true);
  const put = credentialsPut()!;
  expect(put).toMatchObject({ Type: 'SecureString', KeyId: 'arn:key', Tier: 'Standard', Overwrite: true });
  const stored = JSON.parse(put.Value!);
  expect(Object.keys(stored).sort()).toEqual(users.map((u) => u.username).sort());
  // 密碼與 Cognito 設定的一致 / Stored passwords match what Cognito was given.
  for (const c of cog.commandCalls(AdminSetUserPasswordCommand)) {
    expect(stored[c.args[0].input.Username!]).toBe(c.args[0].input.Password);
    expect(c.args[0].input.Permanent).toBe(true);
  }
  expect(statePut()).toMatchObject({ Value: 'paused', Overwrite: false });
});

test('re-run with everything in place: no new users, no password resets, no credentials write; state untouched', async () => {
  for (const u of users) cog.on(AdminGetUserCommand, { Username: u.username }).resolves(existing(u.tenantId));
  const stored = Object.fromEntries(users.map((u) => [u.username, 'Existing-Password-1!']));
  ssm.on(GetParameterCommand, { Name: P.credentialsParam }).resolves({ Parameter: { Value: JSON.stringify(stored) } });
  ssm.on(PutParameterCommand, { Name: P.stateParam }).rejects(exists);
  const r = await provision(P);
  expect(r).toEqual({ users: 3, created: 0, passwordsSet: 0, stateCreated: false });
  expect(cog.commandCalls(AdminCreateUserCommand)).toHaveLength(0);
  expect(cog.commandCalls(AdminSetUserPasswordCommand)).toHaveLength(0);
  expect(credentialsPut()).toBeUndefined();
});

test('an account missing from the credentials parameter gets a new password; others keep theirs', async () => {
  for (const u of users) cog.on(AdminGetUserCommand, { Username: u.username }).resolves(existing(u.tenantId));
  const stored = { [users[0]!.username]: 'Existing-Password-1!' };
  ssm.on(GetParameterCommand, { Name: P.credentialsParam }).resolves({ Parameter: { Value: JSON.stringify(stored) } });
  const r = await provision(P);
  expect(r.passwordsSet).toBe(2);
  expect(JSON.parse(credentialsPut()!.Value!)[users[0]!.username]).toBe('Existing-Password-1!');
});

test('negative: an account with the wrong tenant_id fails the deploy instead of being changed', async () => {
  cog.on(AdminGetUserCommand, { Username: users[0]!.username }).resolves(existing('t_01AAAAAAAAAAAAAAAAAAAAAAAA'));
  await expect(provision(P)).rejects.toThrow('unexpected tenant_id');
  expect(cog.commandCalls(AdminSetUserPasswordCommand)).toHaveLength(0);
  expect(credentialsPut()).toBeUndefined();
});

test('negative: other SSM errors on the state parameter fail', async () => {
  ssm.on(PutParameterCommand, { Name: P.stateParam }).rejects(Object.assign(new Error('x'), { name: 'AccessDeniedException' }));
  await expect(provision(P)).rejects.toThrow();
});

test('delete: removes accounts and parameters unless retained', async () => {
  cog.on(AdminDeleteUserCommand).resolves({});
  ssm.on(DeleteParameterCommand).resolves({});
  expect(await deprovision(P)).toBe(3);
  expect(ssm.commandCalls(DeleteParameterCommand).map((c) => c.args[0].input.Name).sort()).toEqual([P.credentialsParam, P.stateParam].sort());
  cog.reset();
  ssm.reset();
  expect(await deprovision({ ...P, retainOnDelete: true })).toBe(0);
  expect(cog.commandCalls(AdminDeleteUserCommand)).toHaveLength(0);
  expect(ssm.commandCalls(DeleteParameterCommand)).toHaveLength(0);
});

test('handler never returns passwords to CloudFormation', async () => {
  const out = await handler({
    RequestType: 'Create',
    ResourceProperties: {
      ServiceToken: 'x', UserPoolId: 'pool', PoolSize: '3', Seed: 'seed', CredentialsParam: P.credentialsParam,
      StateParam: P.stateParam, KmsKeyId: 'arn:key', RetainOnDelete: 'false',
    },
  } as never);
  expect(out).toEqual({ PhysicalResourceId: 'brewline-simulator-accounts', Data: { Users: '3', Created: '3', PasswordsSet: '3' } });
  const pw = cog.commandCalls(AdminSetUserPasswordCommand)[0]!.args[0].input.Password!;
  expect(JSON.stringify(out)).not.toContain(pw);
});
