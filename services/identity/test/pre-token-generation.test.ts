import type { PreTokenGenerationV2TriggerEvent } from 'aws-lambda';
import { decide, handler } from '../src/pre-token-generation';
import { SCOPES, TENANT_ID_PATTERN } from '../src/scopes';

const TENANT = 't_01JD8Z3K5M7N9P0Q2R4S6T8V0W';
const CAFE_SCOPES = [SCOPES.catalogRead, SCOPES.ordersRead, SCOPES.ordersWrite].sort();

function event(groups: string[], attrs: Record<string, string> = {}): PreTokenGenerationV2TriggerEvent {
  return {
    version: '2',
    triggerSource: 'TokenGeneration_Authentication',
    region: 'ap-east-2',
    userPoolId: 'ap-east-2_example',
    userName: 'user',
    callerContext: { awsSdkVersion: 'x', clientId: 'client' },
    request: { userAttributes: { sub: 'abc', ...attrs }, groupConfiguration: { groupsToOverride: groups } },
    response: { claimsAndScopeOverrideDetails: {} },
  } as PreTokenGenerationV2TriggerEvent;
}

describe('decide()', () => {
  // 正向 / Positive
  test('cafe with a valid tenant gets catalog.read and the tenant claim', () => {
    expect(decide(['cafe'], TENANT)).toEqual({ scopes: CAFE_SCOPES, tenantId: TENANT });
  });

  test('simulator is treated like a café (ADR-011)', () => {
    expect(decide(['simulator'], TENANT)).toEqual({ scopes: CAFE_SCOPES, tenantId: TENANT });
  });

  // staff 沒有租戶，不可拿到下單 scope / Staff have no tenant and must never get order scopes.
  test('staff never get orders.read / orders.write', () => {
    const { scopes } = decide(['staff'], undefined);
    expect(scopes).not.toContain(SCOPES.ordersRead);
    expect(scopes).not.toContain(SCOPES.ordersWrite);
  });

  test('staff gets admin + catalog.read and never a tenant claim', () => {
    expect(decide(['staff'], undefined)).toEqual({ scopes: [SCOPES.admin, SCOPES.catalogRead].sort() });
    expect(decide(['staff'], TENANT)).toEqual({ scopes: [SCOPES.admin, SCOPES.catalogRead].sort() });
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
  test('writes scopes and tenant claim into the access token only', async () => {
    const out = await handler(event(['cafe'], { 'custom:tenant_id': TENANT }));
    expect(out.response.claimsAndScopeOverrideDetails).toEqual({
      accessTokenGeneration: { scopesToAdd: CAFE_SCOPES, claimsToAddOrOverride: { tenant_id: TENANT } },
    });
  });

  test('staff: scopes but no claimsToAddOrOverride', async () => {
    const out = await handler(event(['staff']));
    expect(out.response.claimsAndScopeOverrideDetails.accessTokenGeneration).toEqual({
      scopesToAdd: [SCOPES.admin, SCOPES.catalogRead].sort(),
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
