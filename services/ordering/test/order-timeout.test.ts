import type { AdminOrderRepo } from '../src/lib/admin-order-repo';
import { handler } from '../src/handlers/order-timeout';
import { setAdminOrderRepoForTesting } from '../src/lib/runtime';

const T = 't_01AAAAAAAAAAAAAAAAAAAAAAAA';
const O = `o_${'1'.repeat(26)}`;
let result: unknown;
const calls: any[] = [];
beforeAll(() => setAdminOrderRepoForTesting({ transition: async (i: unknown) => (calls.push(i), result) } as unknown as AdminOrderRepo));
afterAll(() => setAdminOrderRepoForTesting(undefined));
beforeEach(() => (calls.length = 0));

test('cancels only from CREATED, as system:timeout', async () => {
  result = { kind: 'updated', order: { status: 'CANCELLED' } };
  expect(await handler({ tenant_id: T, order_id: O })).toEqual({ outcome: 'cancelled', status: 'CANCELLED' });
  expect(calls[0]).toMatchObject({ tenantId: T, orderId: O, to: 'CANCELLED', actor: 'system:timeout', onlyFrom: ['CREATED'] });
});

test('already confirmed/cancelled → already_moved; deleted → not_found (both succeed, no retry)', async () => {
  result = { kind: 'invalid_transition', current: 'CONFIRMED' };
  expect(await handler({ tenant_id: T, order_id: O })).toEqual({ outcome: 'already_moved', status: 'CONFIRMED' });
  result = { kind: 'not_found' };
  expect(await handler({ tenant_id: T, order_id: O })).toEqual({ outcome: 'not_found' });
});

test('conflict / busy → RetryableError (Step Functions retries)', async () => {
  for (const kind of ['conflict', 'busy']) {
    result = { kind };
    await expect(handler({ tenant_id: T, order_id: O })).rejects.toMatchObject({ name: 'RetryableError' });
  }
});

test('malformed input fails without touching the repo', async () => {
  await expect(handler({ tenant_id: 't_1', order_id: O })).rejects.toThrow();
  await expect(handler({})).rejects.toThrow();
  expect(calls).toHaveLength(0);
});
