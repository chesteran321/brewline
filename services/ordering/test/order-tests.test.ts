import { TENANT_ID_PATTERN } from '../../identity/src/scopes';
import { TENANT_A, TENANT_B, TEST_PRODUCT_ID, evaluateRace, probe, tally } from '../src/order-tests/run';
import { loadTestSeed } from '../src/custom-resources/seed-catalog';

const ok = (checks: ReturnType<typeof evaluateRace>) => checks.every((c) => c.ok);

test('fixed test tenants and product are valid and distinct from smoke fixtures', () => {
  expect(TENANT_ID_PATTERN.test(TENANT_A)).toBe(true);
  expect(TENANT_ID_PATTERN.test(TENANT_B)).toBe(true);
  expect(TENANT_A).not.toBe(TENANT_B);
  expect(loadTestSeed().map((p) => p.id)).toContain(TEST_PRODUCT_ID);
});

test('tally counts kinds and error names', () => {
  const err = Object.assign(new Error('x'), { name: 'Boom' });
  expect(tally([{ kind: 'throttled' }, { kind: 'throttled' }, err])).toEqual({ throttled: 2, 'error:Boom': 1 });
});

describe('evaluateRace', () => {
  const before = { available_kg: 10, reserved_kg: 1 };
  test('perfect run: 10 created, 90 insufficient', () => {
    expect(ok(evaluateRace({ created: 10, insufficient_stock: 90 }, before, { available_kg: 0, reserved_kg: 11 }, 10))).toBe(true);
  });
  test('throttled run with fewer successes is still a pass (no overselling)', () => {
    expect(ok(evaluateRace({ created: 6, throttled: 80, busy: 4, insufficient_stock: 10 }, before, { available_kg: 4, reserved_kg: 7 }, 6))).toBe(true);
  });
  // 反向 / Negative
  test('overselling fails', () => {
    expect(ok(evaluateRace({ created: 11 }, before, { available_kg: -1, reserved_kg: 12 }, 11))).toBe(false);
  });
  test('books out of balance fails (stock moved without an order)', () => {
    expect(ok(evaluateRace({ created: 5 }, before, { available_kg: 4, reserved_kg: 7 }, 5))).toBe(false);
  });
  test('orders in table differ from responses fails', () => {
    expect(ok(evaluateRace({ created: 5 }, before, { available_kg: 5, reserved_kg: 6 }, 6))).toBe(false);
  });
  test('unexpected errors fail', () => {
    expect(ok(evaluateRace({ created: 10, 'error:AccessDeniedException': 1 }, before, { available_kg: 0, reserved_kg: 11 }, 10))).toBe(false);
  });
});

describe('probe', () => {
  const denied = () => Promise.reject(Object.assign(new Error('no'), { name: 'AccessDeniedException' }));
  const other = () => Promise.reject(Object.assign(new Error('no'), { name: 'ResourceNotFoundException' }));
  test('expected deny: AccessDenied passes; success or other errors fail', async () => {
    expect((await probe('x', true, denied)).ok).toBe(true);
    expect((await probe('x', true, () => Promise.resolve({}))).ok).toBe(false);
    expect((await probe('x', true, other)).ok).toBe(false);
  });
  test('control: success passes; any error fails', async () => {
    expect((await probe('x', false, () => Promise.resolve({}))).ok).toBe(true);
    expect((await probe('x', false, denied)).ok).toBe(false);
  });
});
