import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { SendEmailCommand } from '@aws-sdk/client-sesv2';
import { mockClient } from 'aws-sdk-client-mock';
import { NotifierDeps, RetryableError, notify } from '../src/notifications/order-notifier';
import { NotifyMarkerRepo, STALE_CLAIM_MS } from '../src/notifications/notify-marker-repo';
import { buildEmail, isReservedRecipient, kindOf } from '../src/notifications/order-email';

const A = `t_${'A'.repeat(26)}`;
const ORDER = `o_${'1'.repeat(26)}`;
const NOW = new Date('2026-11-16T07:00:00.000Z');
const detail = {
  event_id: 'evt-1', occurred_at: NOW.toISOString(), tenant_id: A, order_id: ORDER, status: 'CREATED',
  total: 12000, currency: 'TWD', items: [{ product_id: 'p-0001', qty_kg: 3 }],
};
const created = { 'detail-type': 'OrderCreated', detail };
const contact = { name: 'Lin Mei', email: 'mei@gmail.com', updated_at: 'x' };

describe('order-email', () => {
  test.each([
    ['OrderCreated', 'CREATED', 'created'],
    ['OrderStatusChanged', 'CONFIRMED', 'confirmed'],
    ['OrderStatusChanged', 'SHIPPED', 'shipped'],
    ['OrderStatusChanged', 'CANCELLED', 'cancelled'],
    // 反向：其他狀態不寄（ADR-029 D5）/ Negative: other statuses send nothing.
    ['OrderStatusChanged', 'ROASTING_SCHEDULED', undefined],
    ['OrderStatusChanged', 'COMPLETED', undefined],
    ['StockLow', 'x', undefined],
  ])('%s %s → %s', (type, status, kind) => {
    expect(kindOf(type, { status })).toBe(kind);
  });

  test.each([
    ['smoke-1@example.com', true], ['a@sub.example.org', true], ['a@foo.test', true], ['a@x.invalid', true],
    ['mei@gmail.com', false], ['a@example.com.tw', false], ['a@myexample.com', false],
  ])('reserved recipient %s → %s', (email, reserved) => {
    expect(isReservedRecipient(email)).toBe(reserved);
  });

  test('created e-mail: bilingual, items and total, demo disclaimer, env tag outside prod', () => {
    const m = buildEmail('created', detail, 'Lin Mei', 'dev');
    expect(m.subject).toBe(`[BrewLine Demo dev] 訂單已建立 / Order received: ${ORDER}`);
    expect(m.text).toContain('Lin Mei');
    expect(m.text).toContain('p-0001 × 3 kg');
    expect(m.text).toContain('12,000 TWD');
    expect(m.text).toMatch(/demo system/);
    expect(buildEmail('shipped', detail, 'x', 'prod').subject.startsWith('[BrewLine Demo] ')).toBe(true);
    // 反向：非建立的信不顯示金額 / Negative: only the "created" mail shows the total.
    expect(buildEmail('shipped', detail, 'x', 'prod').text).not.toContain('12,000');
  });
});

describe('notify()', () => {
  let markers: Array<[string, string?]>;
  let claimResult: 'claimed' | 'done' | 'in_flight';
  let contactResult: typeof contact | undefined;
  let sesError: Error | undefined;
  let sent: SendEmailCommand[];
  const deps = (): NotifierDeps => ({
    contacts: { get: async () => contactResult },
    markers: {
      claim: async () => claimResult,
      finish: async (_t, _e, _k, _o, status, _n, id) => void markers.push([status, id]),
    },
    ses: {
      send: async (cmd: any) => {
        if (sesError) throw sesError;
        sent.push(cmd);
        return { MessageId: 'm-1' };
      },
    } as NotifierDeps['ses'],
    fromAddress: 'orders@dev.brewline-demo.click',
    fromName: 'BrewLine (Demo)',
    configurationSet: 'brewline-dev-mail',
    envName: 'dev',
    now: () => NOW,
  });
  beforeEach(() => {
    markers = [];
    claimResult = 'claimed';
    contactResult = contact;
    sesError = undefined;
    sent = [];
  });

  test('sends with the configuration set and From display name, then records sent + message id', async () => {
    expect(await notify(created, deps())).toBe('sent');
    const input = sent[0]!.input;
    expect(input).toMatchObject({
      FromEmailAddress: '"BrewLine (Demo)" <orders@dev.brewline-demo.click>',
      Destination: { ToAddresses: ['mei@gmail.com'] },
      ConfigurationSetName: 'brewline-dev-mail',
    });
    expect(markers).toEqual([['sent', 'm-1']]);
  });

  // 反向 / Negative
  test('duplicate event (already handled) → nothing sent', async () => {
    claimResult = 'done';
    expect(await notify(created, deps())).toBe('duplicate');
    expect(sent).toHaveLength(0);
  });

  test('event being sent elsewhere → RetryableError', async () => {
    claimResult = 'in_flight';
    await expect(notify(created, deps())).rejects.toBeInstanceOf(RetryableError);
  });

  test('status that is not notified → nothing claimed or sent', async () => {
    const claim = jest.fn();
    const d = { ...deps(), markers: { claim, finish: jest.fn() } };
    expect(await notify({ 'detail-type': 'OrderStatusChanged', detail: { ...detail, status: 'ROASTED' } }, d)).toBe('not_notified');
    expect(claim).not.toHaveBeenCalled();
  });

  test('invalid detail (bad tenant id) → ignored', async () => {
    expect(await notify({ 'detail-type': 'OrderCreated', detail: { ...detail, tenant_id: 'acme' } }, deps())).toBe('invalid_event');
  });

  test('no contact → skipped_no_contact', async () => {
    contactResult = undefined;
    expect(await notify(created, deps())).toBe('skipped_no_contact');
    expect(markers).toEqual([['skipped_no_contact', undefined]]);
  });

  test('reserved test domain (smoke test contact) → skipped_reserved, not sent', async () => {
    contactResult = { ...contact, email: 'smoke-ab12@example.com' };
    expect(await notify(created, deps())).toBe('skipped_reserved');
    expect(sent).toHaveLength(0);
  });

  test('SES MessageRejected (sandbox, unverified recipient) → rejected, not retried', async () => {
    sesError = Object.assign(new Error('Email address is not verified: mei@gmail.com'), { name: 'MessageRejected' });
    expect(await notify(created, deps())).toBe('rejected');
    expect(markers).toEqual([['rejected', undefined]]);
  });

  test('SES throttling → marked failed and rethrown (async retry reclaims it)', async () => {
    sesError = Object.assign(new Error('slow down'), { name: 'TooManyRequestsException' });
    await expect(notify(created, deps())).rejects.toMatchObject({ name: 'TooManyRequestsException' });
    expect(markers).toEqual([['failed', undefined]]);
  });

  test('contact read fails (e.g. KMS AccessDenied) → marked failed and rethrown', async () => {
    const d = { ...deps(), contacts: { get: async () => Promise.reject(Object.assign(new Error('x'), { name: 'AccessDeniedException' })) } };
    await expect(notify(created, d)).rejects.toMatchObject({ name: 'AccessDeniedException' });
    expect(markers).toEqual([['failed', undefined]]);
  });
});

describe('NotifyMarkerRepo', () => {
  const ddb = mockClient(DynamoDBDocumentClient);
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-east-2' }), { marshallOptions: { removeUndefinedValues: true } });
  const repo = new NotifyMarkerRepo(() => doc, 'tbl');
  beforeEach(() => ddb.reset());

  test('claim: conditional put in the tenant partition with a 7-day TTL and no recipient data', async () => {
    ddb.on(PutCommand).resolves({});
    expect(await repo.claim(A, 'evt-1', 'created', ORDER, NOW)).toBe('claimed');
    const input = ddb.commandCalls(PutCommand)[0]!.args[0].input;
    expect(input.Item).toMatchObject({ pk: `TENANT#${A}`, sk: 'NOTIFY#evt-1', entity: 'Notification', status: 'sending', order_id: ORDER });
    expect(input.Item!.expires_at).toBe(Math.floor(NOW.getTime() / 1000) + 7 * 24 * 3600);
    expect(JSON.stringify(input.Item)).not.toMatch(/@/);
    expect(input.ConditionExpression).toContain('attribute_not_exists(pk)');
    expect(input.ExpressionAttributeValues![':stale']).toBe(NOW.getTime() - STALE_CLAIM_MS);
  });

  test.each([
    ['sent', 'done'],
    ['rejected', 'done'],
    ['skipped_no_contact', 'done'],
    ['sending', 'in_flight'],
  ])('claim when existing status is %s → %s', async (status, result) => {
    ddb.on(PutCommand).rejects(new ConditionalCheckFailedException({ message: 'x', $metadata: {} }));
    ddb.on(GetCommand).resolves({ Item: { status } });
    expect(await repo.claim(A, 'evt-1', 'created', ORDER, NOW)).toBe(result);
  });

  test('other DynamoDB errors propagate', async () => {
    ddb.on(PutCommand).rejects(Object.assign(new Error('x'), { name: 'AccessDeniedException' }));
    await expect(repo.claim(A, 'evt-1', 'created', ORDER, NOW)).rejects.toMatchObject({ name: 'AccessDeniedException' });
  });

  test('finish overwrites with the final status and message id', async () => {
    ddb.on(PutCommand).resolves({});
    await repo.finish(A, 'evt-1', 'created', ORDER, 'sent', NOW, 'm-1');
    expect(ddb.commandCalls(PutCommand)[0]!.args[0].input).toMatchObject({
      Item: { status: 'sent', message_id: 'm-1', sk: 'NOTIFY#evt-1' },
    });
    expect(ddb.commandCalls(PutCommand)[0]!.args[0].input.ConditionExpression).toBeUndefined();
  });
});
