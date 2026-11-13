import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchGetCommand, DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { CatalogRepo } from '../src/lib/catalog-repo';

const ddb = mockClient(DynamoDBDocumentClient);
const repo = new CatalogRepo(DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-east-2' })), 'tbl', 'gsi1');

const metaRaw = (id: string, status = 'active') => ({
  pk: `PRODUCT#${id}`, sk: 'META', gsi1pk: 'CATALOG', gsi1sk: `PRODUCT#${id}`, entity: 'Product', status, id,
  name: id, name_zh: id, origin_country: 'ET', region: 'Guji', process: 'natural', variety: 'X', altitude_m: 1,
  cup_score: 85, roast_level: 'light', flavor_notes: ['a'], price_per_kg: 1, currency: 'TWD', lot_id: 'L-2026-001',
});

beforeEach(() => ddb.reset());

test('listActiveProducts queries GSI1 with CATALOG, paginates, drops inactive and malformed items', async () => {
  ddb
    .on(QueryCommand)
    .resolvesOnce({ Items: [metaRaw('p-0001'), { pk: 'PRODUCT#bad' }], LastEvaluatedKey: { pk: 'x' } })
    .resolvesOnce({ Items: [metaRaw('p-0002', 'inactive'), metaRaw('p-0003')] });
  const items = await repo.listActiveProducts();
  expect(items.map((i) => i.id)).toEqual(['p-0001', 'p-0003']);
  const input = ddb.commandCalls(QueryCommand)[0]!.args[0].input;
  expect(input).toMatchObject({ IndexName: 'gsi1', KeyConditionExpression: 'gsi1pk = :pk', ExpressionAttributeValues: { ':pk': 'CATALOG' } });
});

test('getStocks retries UnprocessedKeys', async () => {
  const s = (id: string) => ({ pk: `PRODUCT#${id}`, sk: 'STOCK', available_kg: 1, reserved_kg: 0, low_threshold_kg: 0, version: 1 });
  ddb
    .on(BatchGetCommand)
    .resolvesOnce({ Responses: { tbl: [s('p-0001')] }, UnprocessedKeys: { tbl: { Keys: [{ pk: 'PRODUCT#p-0002', sk: 'STOCK' }] } } })
    .resolvesOnce({ Responses: { tbl: [s('p-0002')] } });
  const m = await repo.getStocks(['p-0001', 'p-0002']);
  expect([...m.keys()].sort()).toEqual(['p-0001', 'p-0002']);
  expect(ddb.commandCalls(BatchGetCommand)).toHaveLength(2);
});

// 反向：只能用 Query／BatchGet／Get，絕不 Scan（IAM 也沒給 Scan）/ Never Scan.
test('never issues a Scan', async () => {
  ddb.on(QueryCommand).resolves({ Items: [] });
  await repo.listActiveProducts();
  await repo.getProductWithStock('p-0001');
  const names = ddb.calls().map((c) => c.args[0].constructor.name);
  expect(names).not.toContain('ScanCommand');
});
