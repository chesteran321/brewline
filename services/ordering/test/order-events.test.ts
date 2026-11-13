import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { marshall } from '@aws-sdk/util-dynamodb';
import type { DynamoDBRecord, DynamoDBStreamEvent } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { toDomainEvent } from '../src/events/order-events';
import { handler, setClientForTesting } from '../src/events/stream-publisher';

const T = 't_01AAAAAAAAAAAAAAAAAAAAAAAA';
const order = (status: string) => ({
  pk: `TENANT#${T}`, sk: 'ORDER#X', entity: 'Order', tenant_id: T, order_id: `o_${'1'.repeat(26)}`, status,
  payment_status: 'PAID_MOCK', total: 300, currency: 'TWD', created_by: 'user-sub-secret', idempotency_key: 'k'.repeat(16),
  items: [{ product_id: 'p-0001', name: 'A', qty_kg: 3, price_per_kg: 100, line_total: 300 }],
});
const stock = (available: number, threshold = 10) => ({ pk: 'PRODUCT#p-0001', sk: 'STOCK', available_kg: available, reserved_kg: 0, low_threshold_kg: threshold });

let seq = 0;
function rec(eventName: 'INSERT' | 'MODIFY' | 'REMOVE', now?: object, old?: object): DynamoDBRecord {
  seq++;
  return {
    eventID: `evt-${seq}`,
    eventName,
    dynamodb: {
      ApproximateCreationDateTime: 1_794_540_000,
      SequenceNumber: String(seq).padStart(5, '0'),
      ...(now ? { NewImage: marshall(now, { removeUndefinedValues: true }) as never } : {}),
      ...(old ? { OldImage: marshall(old, { removeUndefinedValues: true }) as never } : {}),
    },
  };
}

describe('toDomainEvent', () => {
  test('INSERT order → OrderCreated with an allow-listed detail', () => {
    const e = toDomainEvent(rec('INSERT', order('CREATED')))!;
    expect(e.detailType).toBe('OrderCreated');
    expect(e.detail).toMatchObject({ event_id: expect.stringMatching(/^evt-/), tenant_id: T, status: 'CREATED', total: 300, items: [{ product_id: 'p-0001', qty_kg: 3 }] });
    // 反向：不含使用者 sub、鍵、冪等鍵、價格明細以外的內部欄位 / Negative: no sub, keys or idempotency key.
    const json = JSON.stringify(e.detail);
    for (const f of ['user-sub-secret', 'created_by', 'pk', 'idempotency_key', 'TENANT#']) expect(json).not.toContain(f);
  });
  test('status change → OrderStatusChanged with previous_status', () => {
    expect(toDomainEvent(rec('MODIFY', order('CONFIRMED'), order('CREATED')))).toMatchObject({
      detailType: 'OrderStatusChanged',
      detail: { previous_status: 'CREATED', status: 'CONFIRMED' },
    });
  });
  test('MODIFY without a status change → nothing', () => {
    expect(toDomainEvent(rec('MODIFY', order('CREATED'), order('CREATED')))).toBeUndefined();
  });
  test('StockLow only when crossing below the threshold', () => {
    expect(toDomainEvent(rec('MODIFY', stock(9), stock(12)))).toMatchObject({
      detailType: 'StockLow',
      detail: { product_id: 'p-0001', available_kg: 9, low_threshold_kg: 10 },
    });
    expect(toDomainEvent(rec('MODIFY', stock(8), stock(9)))).toBeUndefined(); // 已經低於 / already below
    expect(toDomainEvent(rec('MODIFY', stock(20), stock(5)))).toBeUndefined(); // 回補 / restock
    expect(toDomainEvent(rec('MODIFY', stock(0, 0), stock(5, 0)))).toBeUndefined(); // 門檻 0 = 不告警 / threshold 0 disables
  });
  test.each([
    ['REMOVE of an order (cleanup)', rec('REMOVE', undefined, order('CREATED'))],
    ['idempotency record', rec('INSERT', { pk: `TENANT#${T}`, sk: 'IDEMP#k', entity: 'Idempotency' })],
    ['product META', rec('MODIFY', { pk: 'PRODUCT#p-0001', sk: 'META', entity: 'Product' }, { pk: 'PRODUCT#p-0001', sk: 'META' })],
    ['order missing tenant_id', rec('INSERT', { ...order('CREATED'), tenant_id: undefined })],
  ])('ignores %s', (_n, r) => {
    expect(toDomainEvent(r)).toBeUndefined();
  });
});

describe('stream publisher', () => {
  const eb = mockClient(EventBridgeClient);
  beforeAll(() => {
    process.env.EVENT_BUS_NAME = 'brewline-test';
    setClientForTesting(new EventBridgeClient({ region: 'ap-east-2' }));
  });
  beforeEach(() => eb.reset());
  const event = (records: DynamoDBRecord[]): DynamoDBStreamEvent => ({ Records: records });

  test('publishes mapped events in batches of 10 to the bus with source brewline.ordering', async () => {
    eb.on(PutEventsCommand).resolves({ FailedEntryCount: 0, Entries: [] });
    const records = Array.from({ length: 12 }, () => rec('INSERT', order('CREATED')));
    records.push(rec('INSERT', { pk: 'x', sk: 'IDEMP#1', entity: 'Idempotency' }));
    expect(await handler(event(records))).toEqual({ batchItemFailures: [] });
    const calls = eb.commandCalls(PutEventsCommand);
    expect(calls.map((c) => c.args[0].input.Entries!.length)).toEqual([10, 2]);
    expect(calls[0]!.args[0].input.Entries![0]).toMatchObject({ EventBusName: 'brewline-test', Source: 'brewline.ordering', DetailType: 'OrderCreated' });
  });

  test('partial PutEvents failure → retry from the first failed record', async () => {
    const records = [rec('INSERT', order('CREATED')), rec('INSERT', order('CREATED')), rec('INSERT', order('CREATED'))];
    eb.on(PutEventsCommand).resolves({ FailedEntryCount: 1, Entries: [{ EventId: '1' }, { ErrorCode: 'InternalFailure' }, { EventId: '3' }] });
    expect(await handler(event(records))).toEqual({ batchItemFailures: [{ itemIdentifier: records[1]!.dynamodb!.SequenceNumber }] });
  });

  test('PutEvents throws → retry from the first record of that chunk', async () => {
    const records = [rec('INSERT', order('CREATED'))];
    eb.on(PutEventsCommand).rejects(new Error('boom'));
    expect(await handler(event(records))).toEqual({ batchItemFailures: [{ itemIdentifier: records[0]!.dynamodb!.SequenceNumber }] });
  });

  test('nothing to publish → no PutEvents call', async () => {
    expect(await handler(event([rec('REMOVE', undefined, order('CREATED'))]))).toEqual({ batchItemFailures: [] });
    expect(eb.commandCalls(PutEventsCommand)).toHaveLength(0);
  });
});
