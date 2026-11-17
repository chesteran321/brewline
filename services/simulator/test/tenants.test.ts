import { TENANT_ID_PATTERN } from '../../identity/src/scopes';
import { SimulatorConfigSchema, parseState } from '../src/config';
import { simTenantId, simUsername, simUsers } from '../src/tenants';

describe('simulated accounts (ADR-030 D3)', () => {
  test('deterministic: same seed → same tenants; different seed → different tenants (SIM-F-009)', () => {
    expect(simUsers('s1', 5)).toEqual(simUsers('s1', 5));
    expect(simTenantId('s1', 1)).not.toBe(simTenantId('s2', 1));
  });

  test('valid, unique tenant ids on the reserved domain', () => {
    const users = simUsers('brewline-prod-sim-2026', 40);
    expect(new Set(users.map((u) => u.tenantId)).size).toBe(40);
    for (const u of users) {
      expect(u.tenantId).toMatch(TENANT_ID_PATTERN);
      expect(u.username).toMatch(/^sim-\d{3}@example\.com$/);
    }
    expect(simUsername(7)).toBe('sim-007@example.com');
  });

  test('growing the pool keeps the existing tenants', () => {
    expect(simUsers('s', 40).slice(0, 30)).toEqual(simUsers('s', 30));
  });

  test.each([0, 61, 1.5])('rejects pool size %p', (n) => expect(() => simUsers('s', n)).toThrow());
});

describe('state and config', () => {
  test('only "running" runs; anything else is paused (fail safe)', () => {
    expect(parseState('running')).toBe('running');
    expect(parseState(' running\n')).toBe('running');
    for (const v of [undefined, '', 'paused', 'RUNNING', 'on', 'true']) expect(parseState(v)).toBe('paused');
  });

  const ok = {
    poolSize: 40, initialActive: 30, ordersPerDay: { min: 5, max: 40 }, linesPerOrder: { min: 1, max: 3 },
    kgPerLine: { min: 1, max: 5 }, duplicateOrderRate: 0.02, seed: 'x',
  };
  test('config schema accepts the deployed shape', () => expect(SimulatorConfigSchema.parse(ok)).toEqual(ok));
  test.each([
    ['min > max', { ...ok, ordersPerDay: { min: 9, max: 1 } }],
    ['unknown key', { ...ok, extra: 1 }],
    ['duplicate rate > 0.5', { ...ok, duplicateOrderRate: 0.9 }],
  ])('config schema rejects %s', (_n, v) => expect(SimulatorConfigSchema.safeParse(v).success).toBe(false));
});
