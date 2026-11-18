import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import type { PreTokenGenerationV2TriggerEvent } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { decide, handler, resetSimulatorClientIdCache } from '../src/pre-token-generation';
import { SCOPES, TENANT_ID_PATTERN } from '../src/scopes';

const TENANT = 't_01JD8Z3K5M7N9P0Q2R4S6T8V0W';
const SIM_SCOPES = [SCOPES.catalogRead, SCOPES.ordersRead, SCOPES.ordersWrite].sort();
const CAFE_SCOPES = [...SIM_SCOPES, SCOPES.profileRead, SCOPES.profileWrite].sort();
const STAFF_SCOPES = [SCOPES.admin, SCOPES.catalogRead, SCOPES.roastery].sort();
const ROASTER_SCOPES = [SCOPES.catalogRead, SCOPES.roastery].sort();

const SIM_CLIENT = 'sim-client-id';
const PARAM = '/brewline/dev/auth/simulator-client-id';
const ssmMock = mockClient(SSMClient);

function event(groups: string[], attrs: Record<string, string> = {}, clientId = 'web-client-id'): PreTokenGenerationV2TriggerEvent {
  return {
    version: '2',
    triggerSource: 'TokenGeneration_Authentication',
    region: 'ap-east-2',
    userPoolId: 'ap-east-2_example',
    userName: 'user',
    callerContext: { awsSdkVersion: 'x', clientId },
    request: { userAttributes: { sub: 'abc', ...attrs }, groupConfiguration: { groupsToOverride: groups } },
    response: { claimsAndScopeOverrideDetails: {} },
  } as PreTokenGenerationV2TriggerEvent;
}

describe('decide()', () => {
  // 正向 / Positive
  test('cafe with a valid tenant gets catalog.read and the tenant claim', () => {
    expect(decide(['cafe'], TENANT)).toEqual({ scopes: CAFE_SCOPES, tenantId: TENANT });
  });

  test('simulator is treated like a café for orders (ADR-011) but gets no profile scopes (ADR-029 D4), and is synthetic', () => {
    expect(decide(['simulator'], TENANT)).toEqual({ scopes: SIM_SCOPES, tenantId: TENANT, synthetic: true });
  });

  // ADR-030 D2：simulator client 只服務 simulator 群組 / The simulator client serves the simulator group only.
  test('simulator via the simulator client: same scopes, synthetic', () => {
    expect(decide(['simulator'], TENANT, { viaSimulatorClient: true })).toEqual({ scopes: SIM_SCOPES, tenantId: TENANT, synthetic: true });
  });

  test.each([
    [['cafe'], TENANT],
    [['staff'], undefined],
    [['cafe', 'simulator'], TENANT],
    [['simulator', 'staff'], TENANT],
  ] as const)('groups %j via the simulator client → no scopes (client-not-allowed)', (groups, tenant) => {
    expect(decide(groups, tenant, { viaSimulatorClient: true })).toEqual({ scopes: [], denyReason: 'client-not-allowed' });
  });

  test('cafe and staff are never synthetic', () => {
    expect(decide(['cafe'], TENANT).synthetic).toBeUndefined();
    expect(decide(['staff'], undefined).synthetic).toBeUndefined();
  });

  test('only cafe gets profile.read / profile.write', () => {
    for (const [groups, tenant] of [[['simulator'], TENANT], [['staff'], undefined]] as const) {
      const { scopes } = decide(groups, tenant);
      expect(scopes).not.toContain(SCOPES.profileRead);
      expect(scopes).not.toContain(SCOPES.profileWrite);
    }
  });

  // staff 沒有租戶，不可拿到下單 scope / Staff have no tenant and must never get order scopes.
  test('staff never get orders.read / orders.write', () => {
    const { scopes } = decide(['staff'], undefined);
    expect(scopes).not.toContain(SCOPES.ordersRead);
    expect(scopes).not.toContain(SCOPES.ordersWrite);
  });

  test('staff gets admin + catalog.read + roastery and never a tenant claim', () => {
    expect(decide(['staff'], undefined)).toEqual({ scopes: STAFF_SCOPES });
    expect(decide(['staff'], TENANT)).toEqual({ scopes: STAFF_SCOPES });
  });

  // S2（ADR-031 D6）：模擬烘焙廠操作員 / Simulated roastery operator
  test('simulator-roastery: catalog.read + roastery, synthetic, no tenant, no admin', () => {
    expect(decide(['simulator-roastery'], undefined)).toEqual({ scopes: ROASTER_SCOPES, synthetic: true });
    expect(decide(['simulator-roastery'], TENANT)).toEqual({ scopes: ROASTER_SCOPES, synthetic: true });
    expect(decide(['simulator-roastery'], undefined, { viaSimulatorClient: true })).toEqual({ scopes: ROASTER_SCOPES, synthetic: true });
    expect(decide(['simulator-roastery'], undefined).scopes).not.toContain(SCOPES.admin);
  });

  test('unknown groups are ignored, duplicates collapse', () => {
    expect(decide(['cafe', 'cafe', 'beta-testers'], TENANT).scopes).toEqual(CAFE_SCOPES);
  });

  // 反向：一律 fail closed / Negative: always fail closed
  test.each([
    [[], TENANT, 'no-known-group'],
    [['beta-testers'], TENANT, 'no-known-group'],
    [['cafe', 'staff'], TENANT, 'conflicting-groups'],
    [['simulator', 'staff'], TENANT, 'conflicting-groups'],
    // 模擬帳號不能同時是 staff（RSK-018）；操作員不能同時屬於租戶 / A simulator account is never staff; operators have no tenant.
    [['simulator-roastery', 'staff'], undefined, 'conflicting-groups'],
    [['simulator-roastery', 'simulator'], TENANT, 'conflicting-groups'],
    [['simulator-roastery', 'cafe'], TENANT, 'conflicting-groups'],
    [['cafe', 'simulator'], TENANT, 'conflicting-groups'],
    [['cafe'], undefined, 'missing-tenant-id'],
    [['cafe'], '', 'missing-tenant-id'],
    [['cafe'], 'acme-coffee', 'invalid-tenant-id'],
    [['cafe'], `${TENANT}X`, 'invalid-tenant-id'],
    [['cafe'], 't_01jd8z3k5m7n9p0q2r4s6t8v0w', 'invalid-tenant-id'],
  ] as const)('groups %j tenant %j → no scopes (%s)', (groups, tenant, reason) => {
    expect(decide(groups, tenant)).toEqual({ scopes: [], denyReason: reason });
  });
});

describe('TENANT_ID_PATTERN', () => {
  test.each(['t_01JD8Z3K5M7N9P0Q2R4S6T8V0W', 't_7ZZZZZZZZZZZZZZZZZZZZZZZZZ'])('accepts %s', (v) => {
    expect(TENANT_ID_PATTERN.test(v)).toBe(true);
  });
  // ULID 不使用 I、L、O、U；前綴必須是 t_ / ULIDs exclude I, L, O, U; prefix must be t_.
  test.each(['01JD8Z3K5M7N9P0Q2R4S6T8V0W', 't_01JD8Z3K5M7N9P0Q2R4S6T8V0I', 'T_01JD8Z3K5M7N9P0Q2R4S6T8V0W', 't_1'])(
    'rejects %s',
    (v) => expect(TENANT_ID_PATTERN.test(v)).toBe(false),
  );
});

describe('handler', () => {
  beforeEach(() => {
    ssmMock.reset();
    resetSimulatorClientIdCache();
    process.env.SIMULATOR_CLIENT_ID_PARAM = PARAM;
    ssmMock.on(GetParameterCommand, { Name: PARAM }).resolves({ Parameter: { Value: SIM_CLIENT } });
  });

  test('simulator: synthetic claim next to tenant_id', async () => {
    const out = await handler(event(['simulator'], { 'custom:tenant_id': TENANT }, SIM_CLIENT));
    expect(out.response.claimsAndScopeOverrideDetails).toEqual({
      accessTokenGeneration: { scopesToAdd: SIM_SCOPES, claimsToAddOrOverride: { tenant_id: TENANT, synthetic: 'true' } },
    });
  });

  test('cafe via the simulator client: no scopes, no claims', async () => {
    const out = await handler(event(['cafe'], { 'custom:tenant_id': TENANT }, SIM_CLIENT));
    expect(out.response.claimsAndScopeOverrideDetails.accessTokenGeneration).toEqual({ scopesToAdd: [] });
  });

  test('client id is read from SSM once and cached', async () => {
    await handler(event(['cafe'], { 'custom:tenant_id': TENANT }));
    await handler(event(['staff']));
    expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(1);
  });

  test('fail closed: SSM error fails the sign-in and is not cached', async () => {
    ssmMock.on(GetParameterCommand).rejectsOnce(new Error('ThrottlingException'));
    await expect(handler(event(['cafe'], { 'custom:tenant_id': TENANT }))).rejects.toThrow('ThrottlingException');
    ssmMock.on(GetParameterCommand, { Name: PARAM }).resolves({ Parameter: { Value: SIM_CLIENT } });
    await expect(handler(event(['cafe'], { 'custom:tenant_id': TENANT }))).resolves.toBeDefined();
    expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(2);
  });

  test('fail closed: missing parameter name', async () => {
    delete process.env.SIMULATOR_CLIENT_ID_PARAM;
    await expect(handler(event(['cafe'], { 'custom:tenant_id': TENANT }))).rejects.toThrow('SIMULATOR_CLIENT_ID_PARAM');
  });

  test('writes scopes and tenant claim into the access token only', async () => {
    const out = await handler(event(['cafe'], { 'custom:tenant_id': TENANT }));
    expect(out.response.claimsAndScopeOverrideDetails).toEqual({
      accessTokenGeneration: { scopesToAdd: CAFE_SCOPES, claimsToAddOrOverride: { tenant_id: TENANT } },
    });
  });

  test('staff: scopes but no claimsToAddOrOverride', async () => {
    const out = await handler(event(['staff']));
    expect(out.response.claimsAndScopeOverrideDetails.accessTokenGeneration).toEqual({ scopesToAdd: STAFF_SCOPES });
  });

  test('simulator-roastery: synthetic claim without tenant_id', async () => {
    const out = await handler(event(['simulator-roastery'], { 'custom:tenant_id': TENANT }, SIM_CLIENT));
    expect(out.response.claimsAndScopeOverrideDetails.accessTokenGeneration).toEqual({
      scopesToAdd: ROASTER_SCOPES,
      claimsToAddOrOverride: { synthetic: 'true' },
    });
  });

  test('fail closed: empty scopesToAdd, no claims', async () => {
    const out = await handler(event(['cafe'], { 'custom:tenant_id': 'bad' }));
    expect(out.response.claimsAndScopeOverrideDetails.accessTokenGeneration).toEqual({ scopesToAdd: [] });
  });

  test('handles a missing groupsToOverride', async () => {
    const e = event([]);
    e.request.groupConfiguration = {};
    const out = await handler(e);
    expect(out.response.claimsAndScopeOverrideDetails.accessTokenGeneration).toEqual({ scopesToAdd: [] });
  });
});
