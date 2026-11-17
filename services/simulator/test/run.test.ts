import { AdminInitiateAuthCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { mockClient } from 'aws-sdk-client-mock';
import { handler, setDepsForTesting } from '../src/run';

const cog = mockClient(CognitoIdentityProviderClient);
const ssm = mockClient(SSMClient);
let fetchCalls = 0;
let apiStatus = 200;
let apiItems = 8;
setDepsForTesting({
  cognito: new CognitoIdentityProviderClient({ region: 'ap-east-2' }),
  ssm: new SSMClient({ region: 'ap-east-2' }),
  fetch: (async () => {
    fetchCalls++;
    return new Response(JSON.stringify({ items: Array(apiItems).fill({}) }), { status: apiStatus });
  }) as typeof fetch,
});

const ENV = {
  STATE_PARAM: '/s', CONFIG_PARAM: '/c', CREDENTIALS_PARAM: '/p', USER_POOL_ID: 'pool',
  SIMULATOR_CLIENT_ID: 'sim-client', API_ENDPOINT: 'https://api.example.com',
};
const CONFIG = {
  poolSize: 40, initialActive: 30, ordersPerDay: { min: 5, max: 40 }, linesPerOrder: { min: 1, max: 3 },
  kgPerLine: { min: 1, max: 5 }, duplicateOrderRate: 0.02, seed: 'x',
};
const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

beforeEach(() => {
  Object.assign(process.env, ENV);
  cog.reset();
  ssm.reset();
  fetchCalls = 0;
  apiStatus = 200;
  apiItems = 8;
  ssm.on(GetParameterCommand, { Name: '/c' }).resolves({ Parameter: { Value: JSON.stringify(CONFIG) } });
  ssm.on(GetParameterCommand, { Name: '/p' }).resolves({ Parameter: { Value: JSON.stringify({ 'sim-001@example.com': 'Password-123456!' }) } });
  cog.on(AdminInitiateAuthCommand).resolves({ AuthenticationResult: { AccessToken: jwt({ synthetic: 'true' }) } });
});
const state = (v: string) => ssm.on(GetParameterCommand, { Name: '/s' }).resolves({ Parameter: { Value: v } });

// SIM-N-001：開關 / Kill switch
test('paused: no sign-in, no API call', async () => {
  state('paused');
  expect(await handler({})).toEqual({ outcome: 'paused' });
  expect(cog.commandCalls(AdminInitiateAuthCommand)).toHaveLength(0);
  expect(fetchCalls).toBe(0);
});

test.each([
  ['missing parameter', Object.assign(new Error('x'), { name: 'ParameterNotFound' })],
  ['access denied', Object.assign(new Error('x'), { name: 'AccessDeniedException' })],
])('fail safe: state %s → paused', async (_n, err) => {
  ssm.on(GetParameterCommand, { Name: '/s' }).rejects(err);
  expect(await handler({})).toEqual({ outcome: 'paused' });
  expect(fetchCalls).toBe(0);
});

test('running: signs in through the simulator client as sim-001 and reads the catalog', async () => {
  state('running');
  expect(await handler({})).toEqual({ outcome: 'probe_ok', state: 'running', status: 200, products: 8, synthetic: true });
  expect(cog.commandCalls(AdminInitiateAuthCommand)[0]!.args[0].input).toMatchObject({
    UserPoolId: 'pool', ClientId: 'sim-client', AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
    AuthParameters: { USERNAME: 'sim-001@example.com', PASSWORD: 'Password-123456!' },
  });
  expect(ssm.commandCalls(GetParameterCommand).find((c) => c.args[0].input.Name === '/p')!.args[0].input.WithDecryption).toBe(true);
});

test('manual probe works while paused', async () => {
  state('paused');
  expect((await handler({ probe: true })).outcome).toBe('probe_ok');
});

test.each([
  ['API 403', () => { apiStatus = 403; }],
  ['empty catalog', () => { apiItems = 0; }],
  ['token without the synthetic claim', () => { cog.on(AdminInitiateAuthCommand).resolves({ AuthenticationResult: { AccessToken: jwt({}) } }); }],
])('negative: %s → throws (Errors alarm)', async (_n, arrange) => {
  state('running');
  arrange();
  await expect(handler({})).rejects.toThrow('probe failed');
});

test('negative: invalid config → throws before signing in', async () => {
  state('running');
  ssm.on(GetParameterCommand, { Name: '/c' }).resolves({ Parameter: { Value: JSON.stringify({ ...CONFIG, extra: 1 }) } });
  await expect(handler({})).rejects.toThrow();
  expect(cog.commandCalls(AdminInitiateAuthCommand)).toHaveLength(0);
});

test('negative: missing env → throws', async () => {
  delete process.env.API_ENDPOINT;
  await expect(handler({})).rejects.toThrow('API_ENDPOINT');
});
