import { ConflictException, CreateScheduleCommand, DeleteScheduleCommand, ResourceNotFoundException, SchedulerClient } from '@aws-sdk/client-scheduler';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { handler as createRepl } from '../src/handlers/create-replenishment';
import { handler as deleteRepl } from '../src/handlers/delete-replenishment';
import { handler as listRepl } from '../src/handlers/list-replenishments';
import { NotifierDeps, notify } from '../src/notifications/order-notifier';
import type { OrderRepo } from '../src/lib/order-repo';
import {
  CreateReplenishmentSchema,
  ReplenishmentItem,
  isRunWeek,
  newReplenishmentItem,
  replenishIdempotencyKey,
  scheduleExpression,
  scheduleName,
  taipeiDate,
} from '../src/lib/replenishment-model';
import type { ReplenishmentRepo } from '../src/lib/replenishment-repo';
import { ReplenishmentScheduler } from '../src/lib/replenishment-scheduler';
import { setOrderRepoForTesting, setReplenishmentDepsForTesting } from '../src/lib/runtime';
import { RetryableError, runReplenishment } from '../src/replenish/run-replenishment';

const A = `t_${'A'.repeat(26)}`;
const RID = `r_${'1'.repeat(26)}`;
const lines = [{ product_id: 'p-0001', qty_kg: 5 }];
// 2026-11-16（一）01:00Z = 台北 09:00 / Monday 09:00 Taipei
const MON = new Date('2026-11-16T01:00:00.000Z');
const sub = (over: Partial<ReplenishmentItem> = {}): ReplenishmentItem =>
  ({ ...newReplenishmentItem(A, RID, { frequency: 'weekly', day_of_week: 'MON', items: lines }, 'sub-1', MON), ...over });

describe('replenishment model', () => {
  test.each([
    [{ frequency: 'weekly', day_of_week: 'MON', items: lines }, true],
    [{ frequency: 'biweekly', day_of_week: 'FRI', items: lines }, true],
    [{ frequency: 'monthly', day_of_month: 28, items: lines }, true],
    // 反向 / Negative
    [{ frequency: 'monthly', day_of_month: 29, items: lines }, false],
    [{ frequency: 'monthly', day_of_month: 0, items: lines }, false],
    [{ frequency: 'weekly', day_of_month: 3, items: lines }, false],
    [{ frequency: 'daily', items: lines }, false],
    [{ frequency: 'weekly', day_of_week: 'MON', items: [] }, false],
    [{ frequency: 'weekly', day_of_week: 'MON', items: [...lines, ...lines] }, false],
    [{ frequency: 'weekly', day_of_week: 'MON', items: [{ product_id: 'p-0001', qty_kg: 501 }] }, false],
    [{ frequency: 'weekly', day_of_week: 'MON', items: lines, tenant_id: A }, false],
  ])('%j valid = %s', (body, ok) => {
    expect(CreateReplenishmentSchema.safeParse(body).success).toBe(ok);
  });

  test('cron in Asia/Taipei at 09:00; biweekly fires weekly', () => {
    expect(scheduleExpression({ frequency: 'weekly', day_of_week: 'TUE' })).toBe('cron(0 9 ? * TUE *)');
    expect(scheduleExpression({ frequency: 'biweekly', day_of_week: 'TUE' })).toBe('cron(0 9 ? * TUE *)');
    expect(scheduleExpression({ frequency: 'monthly', day_of_month: 15 })).toBe('cron(0 9 15 * ? *)');
  });

  test('Taipei date crosses midnight UTC correctly', () => {
    expect(taipeiDate(new Date('2026-11-15T16:30:00Z'))).toBe('2026-11-16');
    expect(taipeiDate(new Date('2026-11-15T15:59:00Z'))).toBe('2026-11-15');
  });

  test('biweekly: anchor week and every second week run; the weeks in between are skipped', () => {
    const r = { frequency: 'biweekly' as const, anchor_date: '2026-11-18' }; // 建立於週三 / created Wednesday
    const at = (d: string) => new Date(`${d}T01:00:00Z`);
    expect(isRunWeek(r, at('2026-11-20'))).toBe(true); // same week
    expect(isRunWeek(r, at('2026-11-27'))).toBe(false);
    expect(isRunWeek(r, at('2026-12-04'))).toBe(true);
    expect(isRunWeek(r, at('2026-12-11'))).toBe(false);
    expect(isRunWeek({ frequency: 'weekly', anchor_date: '2026-11-18' }, at('2026-11-27'))).toBe(true);
  });

  test('idempotency key: same firing day → same key, valid for Idempotency-Key rules', () => {
    const k = replenishIdempotencyKey(RID, MON);
    expect(k).toBe(`rp-${'1'.repeat(26)}-20261116`);
    expect(k).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(replenishIdempotencyKey(RID, new Date('2026-11-16T03:00:00Z'))).toBe(k);
    expect(replenishIdempotencyKey(RID, new Date('2026-11-23T01:00:00Z'))).not.toBe(k);
  });

  test('schedule name ≤ 64 characters and tenant-prefixed', () => {
    const n = scheduleName(A, RID);
    expect(n.length).toBeLessThanOrEqual(64);
    expect(n.startsWith(A)).toBe(true);
  });
});

describe('ReplenishmentScheduler', () => {
  const sched = mockClient(SchedulerClient);
  const s = new ReplenishmentScheduler(new SchedulerClient({ region: 'ap-east-2' }), {
    groupName: 'brewline-dev-replenish', functionArn: 'arn:fn', roleArn: 'arn:role', dlqArn: 'arn:dlq',
  });
  beforeEach(() => sched.reset());

  test('create: Taipei timezone, no flexible window, ids + scheduled-time placeholder only, retry + DLQ', async () => {
    sched.on(CreateScheduleCommand).resolves({});
    await s.create(sub());
    const input = sched.commandCalls(CreateScheduleCommand)[0]!.args[0].input;
    expect(input).toMatchObject({
      Name: scheduleName(A, RID), GroupName: 'brewline-dev-replenish', ScheduleExpression: 'cron(0 9 ? * MON *)',
      ScheduleExpressionTimezone: 'Asia/Taipei', FlexibleTimeWindow: { Mode: 'OFF' },
      Target: { Arn: 'arn:fn', RoleArn: 'arn:role', DeadLetterConfig: { Arn: 'arn:dlq' }, RetryPolicy: { MaximumRetryAttempts: 2 } },
    });
    expect(JSON.parse(input.Target!.Input!)).toEqual({ tenant_id: A, replenishment_id: RID, scheduled_time: '<aws.scheduler.scheduled-time>' });
  });

  test('create is idempotent (ConflictException), delete is idempotent (ResourceNotFound)', async () => {
    sched.on(CreateScheduleCommand).rejects(new ConflictException({ message: 'x', Message: 'x', $metadata: {} }));
    await expect(s.create(sub())).resolves.toBeUndefined();
    sched.on(DeleteScheduleCommand).rejects(new ResourceNotFoundException({ message: 'x', Message: 'x', $metadata: {} }));
    await expect(s.delete(sub())).resolves.toBeUndefined();
  });

  test('other errors propagate', async () => {
    sched.on(CreateScheduleCommand).rejects(Object.assign(new Error('x'), { name: 'AccessDeniedException' }));
    await expect(s.create(sub())).rejects.toMatchObject({ name: 'AccessDeniedException' });
  });
});

describe('replenishment API handlers', () => {
  let store: ReplenishmentItem[];
  let unknown: string[];
  let schedFail: boolean;
  const scheduled: string[] = [];
  const deleted: string[] = [];
  const repo = {
    listActive: async () => store.filter((r) => r.status === 'active'),
    get: async (t: string, id: string) => store.find((r) => r.tenant_id === t && r.replenishment_id === id),
    put: async (r: ReplenishmentItem) => void store.push(r),
    markDeleted: async (r: ReplenishmentItem) => {
      store = store.map((x) => (x.replenishment_id === r.replenishment_id ? { ...x, status: 'deleted' } : x));
    },
  } as unknown as ReplenishmentRepo;
  const scheduler = {
    create: async (r: ReplenishmentItem) => {
      if (schedFail) throw Object.assign(new Error('x'), { name: 'ValidationException' });
      scheduled.push(r.schedule_name);
    },
    delete: async (r: ReplenishmentItem) => void deleted.push(r.schedule_name),
  } as unknown as ReplenishmentScheduler;
  const orders = { unknownProducts: async () => unknown } as unknown as OrderRepo;

  const event = (o: { scopes?: string[]; body?: unknown; id?: string; tenant?: string } = {}) => {
    const scopes = o.scopes ?? ['brewline/orders.read', 'brewline/orders.write'];
    return {
      headers: {},
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
      isBase64Encoded: false,
      pathParameters: o.id ? { id: o.id } : undefined,
      requestContext: { authorizer: { jwt: { claims: { sub: 'sub-1', tenant_id: o.tenant ?? A, scope: scopes.join(' ') }, scopes } } },
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
  };
  const body = { frequency: 'weekly', day_of_week: 'MON', items: lines };
  const parse = (r: { body?: string }) => JSON.parse(r.body ?? '{}');

  beforeAll(() => {
    setReplenishmentDepsForTesting(repo, scheduler);
    setOrderRepoForTesting(orders);
  });
  afterAll(() => {
    setReplenishmentDepsForTesting();
    setOrderRepoForTesting(undefined);
  });
  beforeEach(() => {
    store = [];
    unknown = [];
    schedFail = false;
    scheduled.length = 0;
    deleted.length = 0;
  });

  test('POST → 201, item stored and schedule created; GET lists it with run_at 09:00 Asia/Taipei', async () => {
    const r = await createRepl(event({ body }));
    expect(r.statusCode).toBe(201);
    const created = parse(r);
    expect(created.replenishment_id).toMatch(/^r_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(created.run_at).toBe('09:00 Asia/Taipei');
    expect(created).not.toHaveProperty('tenant_id');
    expect(scheduled).toEqual([scheduleName(A, created.replenishment_id)]);
    const l = parse(await listRepl(event()));
    expect(l.items.map((i: any) => i.replenishment_id)).toEqual([created.replenishment_id]);
    expect(l.limit).toBe(5);
  });

  // 反向 / Negative
  test('6th replenishment → 409 limit_reached, nothing scheduled', async () => {
    for (let i = 0; i < 5; i++) expect((await createRepl(event({ body }))).statusCode).toBe(201);
    const r = await createRepl(event({ body }));
    expect(r.statusCode).toBe(409);
    expect(parse(r).error.code).toBe('limit_reached');
    expect(scheduled).toHaveLength(5);
  });

  test('unknown product → 400, nothing stored', async () => {
    unknown = ['p-9999'];
    const r = await createRepl(event({ body: { ...body, items: [{ product_id: 'p-9999', qty_kg: 1 }] } }));
    expect(r.statusCode).toBe(400);
    expect(store).toHaveLength(0);
  });

  test('schedule creation fails → compensated (soft-deleted) and 500', async () => {
    schedFail = true;
    expect((await createRepl(event({ body }))).statusCode).toBe(500);
    expect(store).toHaveLength(1);
    expect(store[0]!.status).toBe('deleted');
  });

  test.each([
    ['POST without orders.write', () => createRepl(event({ scopes: ['brewline/orders.read'], body })), 403],
    ['GET without orders.read', () => listRepl(event({ scopes: ['brewline/catalog.read'] })), 403],
    ['DELETE without orders.write', () => deleteRepl(event({ scopes: ['brewline/orders.read'], id: RID })), 403],
    ['POST with a bad tenant claim', () => createRepl(event({ tenant: 'acme', body })), 403],
    ['POST day_of_month 31', () => createRepl(event({ body: { frequency: 'monthly', day_of_month: 31, items: lines } })), 400],
    ['DELETE with a malformed id', () => deleteRepl(event({ id: 'r_bad' })), 400],
  ])('%s → %i', async (_n, call, status) => {
    expect((await call()).statusCode).toBe(status);
  });

  test('DELETE: soft-deletes then removes the schedule; repeat and unknown ids are 204', async () => {
    const id = parse(await createRepl(event({ body }))).replenishment_id;
    expect((await deleteRepl(event({ id }))).statusCode).toBe(204);
    expect(store[0]!.status).toBe('deleted');
    expect(deleted).toEqual([scheduleName(A, id)]);
    expect((await deleteRepl(event({ id }))).statusCode).toBe(204);
    expect(deleted).toHaveLength(1);
    expect((await deleteRepl(event({ id: RID }))).statusCode).toBe(204);
  });

  test("another tenant's id is invisible (repo is tenant-scoped) → 204, nothing deleted", async () => {
    const id = parse(await createRepl(event({ body }))).replenishment_id;
    expect((await deleteRepl(event({ id, tenant: `t_${'B'.repeat(26)}` }))).statusCode).toBe(204);
    expect(store[0]!.status).toBe('active');
  });
});

describe('runReplenishment()', () => {
  const input = { tenant_id: A, replenishment_id: RID, scheduled_time: MON.toISOString() };
  let current: ReplenishmentItem | undefined;
  let result: any;
  const published: Array<Record<string, unknown>> = [];
  const calls: any[] = [];
  const deps = () => ({
    repo: { get: async () => current },
    orders: { createOrder: async (i: any) => (calls.push(i), result) },
    publish: async (_t: string, d: Record<string, unknown>) => void published.push(d),
    now: () => MON,
  });
  beforeEach(() => {
    current = sub();
    result = { kind: 'created', order: { order_id: 'o_X' } };
    published.length = 0;
    calls.length = 0;
  });

  test('places the order with the subscription items, system actor and the day key', async () => {
    expect(await runReplenishment(input, deps())).toEqual({ outcome: 'ordered', order_id: 'o_X' });
    expect(calls[0]).toMatchObject({
      tenantId: A, createdBy: 'system:replenish', idempotencyKey: replenishIdempotencyKey(RID, MON), request: { items: lines },
    });
  });

  test('a retried firing replays the same order', async () => {
    result = { kind: 'replayed', order: { order_id: 'o_X' } };
    expect((await runReplenishment(input, deps())).outcome).toBe('replayed');
  });

  test('insufficient stock → ReplenishmentFailed with a stable event id, no retry', async () => {
    result = { kind: 'insufficient_stock', productIds: ['p-0001'] };
    expect((await runReplenishment(input, deps())).outcome).toBe('failed_stock');
    expect(published).toEqual([expect.objectContaining({
      event_id: `rf-${RID}-2026-11-16`, reason: 'insufficient_stock', product_ids: ['p-0001'], tenant_id: A,
    })]);
  });

  // 反向 / Negative
  test('deleted or missing subscription → nothing ordered', async () => {
    current = sub({ status: 'deleted' });
    expect((await runReplenishment(input, deps())).outcome).toBe('skipped_inactive');
    current = undefined;
    expect((await runReplenishment(input, deps())).outcome).toBe('skipped_inactive');
    expect(calls).toHaveLength(0);
  });

  test('biweekly off week → nothing ordered', async () => {
    current = sub({ frequency: 'biweekly', anchor_date: '2026-11-09' });
    expect((await runReplenishment(input, deps())).outcome).toBe('skipped_off_week');
    expect(calls).toHaveLength(0);
  });

  test('throttled → RetryableError; malformed input → error', async () => {
    result = { kind: 'throttled' };
    await expect(runReplenishment(input, deps())).rejects.toBeInstanceOf(RetryableError);
    await expect(runReplenishment({ ...input, tenant_id: 'acme' }, deps())).rejects.toThrow();
  });
});

describe('notifier: ReplenishmentFailed (A4e)', () => {
  test('sends a replenish_failed e-mail keyed by the replenishment id', async () => {
    const sent: any[] = [];
    const marks: any[] = [];
    const d: NotifierDeps = {
      contacts: { get: async () => ({ name: 'Lin', email: 'lin@gmail.com', updated_at: 'x' }) },
      markers: { claim: async () => 'claimed', finish: async (...a) => void marks.push(a) },
      ses: { send: async (c: any) => (sent.push(c.input), { MessageId: 'm' }) } as NotifierDeps['ses'],
      fromAddress: 'orders@dev.brewline-demo.click', fromName: 'BrewLine (Demo)', configurationSet: 'cs', envName: 'dev',
    };
    const detail = {
      event_id: `rf-${RID}-2026-11-16`, occurred_at: MON.toISOString(), tenant_id: A, replenishment_id: RID,
      scheduled_date: '2026-11-16', reason: 'insufficient_stock', product_ids: ['p-0001'],
    };
    expect(await notify({ 'detail-type': 'ReplenishmentFailed', detail }, d)).toBe('sent');
    expect(sent[0].Content.Simple.Subject.Data).toContain('定期補貨未下單');
    expect(sent[0].Content.Simple.Body.Text.Data).toContain('p-0001');
    expect(marks[0]).toEqual(expect.arrayContaining([A, detail.event_id, 'replenish_failed', RID, 'sent']));
    // 反向：detail 不合格 → 不寄 / Negative: invalid detail sends nothing.
    expect(await notify({ 'detail-type': 'ReplenishmentFailed', detail: { ...detail, reason: 'other' } }, d)).toBe('invalid_event');
  });
});
