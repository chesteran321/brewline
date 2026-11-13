import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { STSClient } from '@aws-sdk/client-sts';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { Logger } from '@aws-lambda-powertools/logger';
import { ulid } from '../lib/ulid';
import { CreateOrderResult, OrderRepo } from '../lib/order-repo';
import { TenantCredentials } from '../lib/tenant-credentials';

/**
 * A2b-2：Dev 專用的訂單測試（手動觸發，ADR-025）。
 * Dev-only order tests, triggered manually.
 *
 * 1. 冪等風暴：同一個 Idempotency-Key 同時送 10 次 → 只產生 1 筆訂單（03 §11）。
 * 2. 搶庫存：100 個不同的 key 同時各訂 1 kg，庫存 10 kg → 不超賣（03 §11）。
 * 3. IAM 探測：用租戶 A 的**真實憑證**直接呼叫 DynamoDB，越權動作必須 AccessDeniedException（A2 決策 D4）。
 *
 * 1. Idempotency storm  2. Stock race (no overselling)  3. IAM probe with real tenant credentials.
 */

export const TEST_PRODUCT_ID = 'p-9001';
export const TENANT_A = 't_01CNCRTST000000000000000A1';
export const TENANT_B = 't_01CNCRTST000000000000000B1';
export const RACE_STOCK_KG = 10;
export const RACE_REQUESTS = 100;
export const STORM_REQUESTS = 10;

const logger = new Logger({ serviceName: 'ordering-order-tests' });

export interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface StockState {
  readonly available_kg: number;
  readonly reserved_kg: number;
}

/** 依結果種類計數 / Count results by kind ('error:<name>' for exceptions). */
export function tally(results: ReadonlyArray<CreateOrderResult | Error>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of results) {
    const k = r instanceof Error ? `error:${r.name}` : r.kind;
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}

/**
 * 搶庫存的判定（純函數，方便單元測試）。重點是**不超賣**與帳目一致；成功數小於庫存
 * 可能是 Dev 表的寫入上限（25 WRU/s）造成 throttle，屬預期。
 * Race verdict: no overselling and consistent books. Fewer successes than stock can be throttling (expected in Dev).
 */
export function evaluateRace(
  counts: Record<string, number>,
  before: StockState,
  after: StockState,
  ordersCreated: number,
): Check[] {
  const created = counts.created ?? 0;
  const unexpected = Object.entries(counts).filter(([k]) => !['created', 'insufficient_stock', 'throttled', 'busy'].includes(k));
  return [
    { name: `race: created ≤ ${before.available_kg} (no overselling)`, ok: created <= before.available_kg, detail: `created ${created}` },
    {
      name: 'race: available + created = stock before',
      ok: after.available_kg + created === before.available_kg,
      detail: `available ${after.available_kg} + created ${created} vs ${before.available_kg}`,
    },
    {
      name: 'race: reserved increased by created',
      ok: after.reserved_kg - before.reserved_kg === created,
      detail: `reserved ${before.reserved_kg} → ${after.reserved_kg}`,
    },
    { name: 'race: available never negative', ok: after.available_kg >= 0, detail: `available ${after.available_kg}` },
    { name: 'race: orders in table = created', ok: ordersCreated === created, detail: `orders ${ordersCreated}` },
    {
      name: 'race: only expected outcomes',
      ok: unexpected.length === 0,
      detail: unexpected.length ? JSON.stringify(Object.fromEntries(unexpected)) : 'none',
    },
  ];
}

/** 探測結果：期望被拒卻成功 → 失敗 / A probe that should be denied but succeeds is a failure. */
export async function probe(name: string, expectDenied: boolean, action: () => Promise<unknown>): Promise<Check> {
  try {
    await action();
    return { name, ok: !expectDenied, detail: 'succeeded' };
  } catch (err) {
    const n = (err as Error).name;
    const denied = n === 'AccessDeniedException';
    return { name, ok: expectDenied ? denied : false, detail: n };
  }
}

interface Deps {
  /** 函數自己的角色：只能動測試商品與測試租戶（夾具）/ The function's own role: fixtures only. */
  readonly fixture: DynamoDBDocumentClient;
  /** 租戶範圍的 client（扮演租戶角色）/ Tenant-scoped client (assumed tenant role). */
  readonly forTenant: (tenantId: string) => DynamoDBDocumentClient;
  readonly tableName: string;
}

async function resetStock(d: Deps, availableKg: number): Promise<void> {
  await d.fixture.send(
    new PutCommand({
      TableName: d.tableName,
      Item: {
        pk: `PRODUCT#${TEST_PRODUCT_ID}`,
        sk: 'STOCK',
        entity: 'Stock',
        available_kg: availableKg,
        reserved_kg: 0,
        low_threshold_kg: 0,
        version: 1,
        updated_at: new Date().toISOString(),
      },
    }),
  );
}

async function readStock(d: Deps): Promise<StockState> {
  const out = await d.fixture.send(
    new GetCommand({ TableName: d.tableName, Key: { pk: `PRODUCT#${TEST_PRODUCT_ID}`, sk: 'STOCK' }, ConsistentRead: true }),
  );
  return { available_kg: Number(out.Item?.available_kg), reserved_kg: Number(out.Item?.reserved_kg) };
}

async function listKeys(d: Deps, tenantId: string): Promise<Array<{ pk: string; sk: string }>> {
  const keys: Array<{ pk: string; sk: string }> = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const out = await d.fixture.send(
      new QueryCommand({
        TableName: d.tableName,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': `TENANT#${tenantId}` },
        ProjectionExpression: 'pk, sk',
        ConsistentRead: true,
        ExclusiveStartKey: startKey,
      }),
    );
    for (const i of out.Items ?? []) keys.push({ pk: String(i.pk), sk: String(i.sk) });
    startKey = out.LastEvaluatedKey;
  } while (startKey);
  return keys;
}

async function cleanTenants(d: Deps): Promise<number> {
  let n = 0;
  for (const t of [TENANT_A, TENANT_B]) {
    for (const key of await listKeys(d, t)) {
      await d.fixture.send(new DeleteCommand({ TableName: d.tableName, Key: key }));
      n++;
    }
  }
  return n;
}

const countOrders = async (d: Deps, t: string) => (await listKeys(d, t)).filter((k) => k.sk.startsWith('ORDER#')).length;

export async function runAll(d: Deps): Promise<{ passed: boolean; checks: Check[]; stats: Record<string, unknown> }> {
  const checks: Check[] = [];
  const stats: Record<string, unknown> = {};
  const repo = new OrderRepo(d.forTenant, d.tableName);
  const order = (key: string) =>
    repo
      .createOrder({
        tenantId: TENANT_A,
        createdBy: 'order-tests',
        idempotencyKey: key,
        request: { items: [{ product_id: TEST_PRODUCT_ID, qty_kg: 1 }] },
        orderId: `o_${ulid()}`,
        now: new Date(),
      })
      .catch((e: Error) => e);

  await cleanTenants(d);
  try {
    // --- 1) 冪等風暴 / Idempotency storm ---
    await resetStock(d, RACE_STOCK_KG + 1);
    const stormKey = `storm-${ulid()}`;
    const storm = await Promise.all(Array.from({ length: STORM_REQUESTS }, () => order(stormKey)));
    const stormCounts = tally(storm);
    stats.storm = stormCounts;
    const stormIds = new Set(storm.flatMap((r) => (r instanceof Error || !('order' in r) ? [] : [r.order.order_id])));
    const stormOrders = await countOrders(d, TENANT_A);
    const afterStorm = await readStock(d);
    checks.push(
      { name: `storm: ${STORM_REQUESTS} × same key → 1 order in table`, ok: stormOrders === 1, detail: `orders ${stormOrders}` },
      {
        // throttle／busy 在 Dev 可能出現（client 會用同一個 key 重試），但不可有第二個 order_id
        // throttled/busy may happen in Dev (clients retry with the same key), but never a second order_id.
        name: 'storm: exactly one created, all others replayed/retryable, one order_id',
        ok:
          stormCounts.created === 1 &&
          stormIds.size === 1 &&
          Object.keys(stormCounts).every((k) => ['created', 'replayed', 'throttled', 'busy'].includes(k)),
        detail: JSON.stringify(stormCounts),
      },
      { name: 'storm: stock reserved once (1 kg)', ok: afterStorm.available_kg === RACE_STOCK_KG && afterStorm.reserved_kg === 1, detail: JSON.stringify(afterStorm) },
    );

    // --- 2) 搶庫存 / Stock race ---
    const before = await readStock(d);
    const ordersBefore = await countOrders(d, TENANT_A);
    const started = Date.now();
    const race = await Promise.all(Array.from({ length: RACE_REQUESTS }, (_, i) => order(`race-${ulid()}-${i}`)));
    stats.raceMs = Date.now() - started;
    const raceCounts = tally(race);
    stats.race = raceCounts;
    const after = await readStock(d);
    stats.stock = { before, after };
    checks.push(...evaluateRace(raceCounts, before, after, (await countOrders(d, TENANT_A)) - ordersBefore));

    // --- 3) IAM 探測（真實憑證）/ IAM probe with real tenant credentials ---
    const a = d.forTenant(TENANT_A);
    const t = d.tableName;
    const ownOrderSk = (await listKeys(d, TENANT_A)).find((k) => k.sk.startsWith('ORDER#'))?.sk ?? 'ORDER#none';
    const foreign = { pk: `TENANT#${TENANT_B}`, sk: `ORDER#${ulid()}` };
    checks.push(
      await probe('probe: A reads own order (control)', false, () => a.send(new GetCommand({ TableName: t, Key: { pk: `TENANT#${TENANT_A}`, sk: ownOrderSk } }))),
      await probe("probe: A reads B's partition → AccessDenied", true, () => a.send(new GetCommand({ TableName: t, Key: foreign }))),
      await probe("probe: A queries B's partition → AccessDenied", true, () =>
        a.send(new QueryCommand({ TableName: t, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': foreign.pk } })),
      ),
      await probe('probe: A writes into B → AccessDenied', true, () => a.send(new PutCommand({ TableName: t, Item: { ...foreign, entity: 'Probe' } }))),
      await probe('probe: A changes a price → AccessDenied', true, () =>
        a.send(
          new UpdateCommand({
            TableName: t,
            Key: { pk: `PRODUCT#${TEST_PRODUCT_ID}`, sk: 'META' },
            UpdateExpression: 'SET price_per_kg = :p',
            ExpressionAttributeValues: { ':p': 1 },
          }),
        ),
      ),
      await probe("probe: A queries GSI1 (all tenants' orders) → AccessDenied", true, () =>
        a.send(
          new QueryCommand({
            TableName: t,
            IndexName: 'gsi1',
            KeyConditionExpression: 'gsi1pk = :s',
            ExpressionAttributeValues: { ':s': 'STATUS#CREATED' },
          }),
        ),
      ),
      await probe('probe: A scans the table → AccessDenied', true, () => a.send(new ScanCommand({ TableName: t, Limit: 1 }))),
      await probe('probe: A deletes own order → AccessDenied', true, () =>
        a.send(new DeleteCommand({ TableName: t, Key: { pk: `TENANT#${TENANT_A}`, sk: ownOrderSk } })),
      ),
    );
  } finally {
    stats.cleaned = await cleanTenants(d).catch((e: Error) => `failed: ${e.name}`);
    await resetStock(d, RACE_STOCK_KG).catch(() => undefined);
  }
  return { passed: checks.every((c) => c.ok), checks, stats };
}

/** Lambda 進入點（只由 scripts/run-order-tests.sh 手動呼叫）/ Entry point, invoked manually. */
export const handler = async () => {
  const tableName = process.env.TABLE_NAME;
  const roleArn = process.env.TENANT_ROLE_ARN;
  if (!tableName || !roleArn) throw new Error('TABLE_NAME and TENANT_ROLE_ARN are required');
  const creds = new TenantCredentials(new STSClient({}), roleArn, 'order-tests');
  const clients = new Map<string, DynamoDBDocumentClient>();
  const forTenant = (tenantId: string) => {
    let c = clients.get(tenantId);
    if (!c) {
      c = DynamoDBDocumentClient.from(new DynamoDBClient({ credentials: () => creds.get(tenantId) }));
      clients.set(tenantId, c);
    }
    return c;
  };
  const result = await runAll({ fixture: DynamoDBDocumentClient.from(new DynamoDBClient({})), forTenant, tableName });
  logger.info('order tests finished', { passed: result.passed, stats: result.stats, failed: result.checks.filter((c) => !c.ok) });
  return result;
};
