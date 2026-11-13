import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { loadSeed, seed } from '../src/custom-resources/seed-catalog';

const ddb = mockClient(DynamoDBDocumentClient);
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-east-2' }));

beforeEach(() => ddb.reset());

describe('seed()', () => {
  test('upserts META (with GSI1 keys) and creates STOCK only if absent', async () => {
    ddb.on(PutCommand).resolves({});
    const products = loadSeed().slice(0, 2);
    const out = await seed(doc, 'brewline-dev-core', products);
    expect(out).toEqual({ products: 2, stockCreated: 2, stockKept: 0 });

    const puts = ddb.commandCalls(PutCommand).map((c) => c.args[0].input);
    const metaPut = puts.find((p) => p.Item?.sk === 'META')!;
    expect(metaPut.ConditionExpression).toBeUndefined();
    expect(metaPut.Item).toMatchObject({ pk: 'PRODUCT#p-0001', gsi1pk: 'CATALOG', gsi1sk: 'PRODUCT#p-0001', status: 'active' });
    expect(metaPut.Item).not.toHaveProperty('initial_stock_kg');

    const stockPut = puts.find((p) => p.Item?.sk === 'STOCK')!;
    expect(stockPut.ConditionExpression).toBe('attribute_not_exists(pk)');
    expect(stockPut.Item).toMatchObject({ available_kg: 120, reserved_kg: 0, version: 1 });
    expect(stockPut.Item).not.toHaveProperty('gsi1pk'); // STOCK 不進目錄索引 / not in the catalog index
  });

  // 反向：重新部署不可重設既有庫存 / Negative: a redeploy must not reset existing stock.
  test('keeps existing STOCK on redeploy', async () => {
    ddb.on(PutCommand).callsFake((input) => {
      if (input.Item?.sk === 'STOCK') {
        throw new ConditionalCheckFailedException({ message: 'exists', $metadata: {} });
      }
      return {};
    });
    const out = await seed(doc, 't', loadSeed().slice(0, 3));
    expect(out).toEqual({ products: 3, stockCreated: 0, stockKept: 3 });
  });

  test('other errors fail the seed (and therefore the deploy)', async () => {
    ddb.on(PutCommand).rejects(new Error('AccessDeniedException'));
    await expect(seed(doc, 't', loadSeed().slice(0, 1))).rejects.toThrow('AccessDeniedException');
  });
});
