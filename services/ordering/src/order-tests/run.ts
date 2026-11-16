import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DecryptCommand, EncryptCommand, GenerateDataKeyCommand, KMSClient } from '@aws-sdk/client-kms';
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
import { AdminOrderRepo } from '../lib/admin-order-repo';
import { CreateOrderResult, OrderRepo } from '../lib/order-repo';
import { ContactRepo } from '../lib/contact-repo';
import { ContactSchema } from '../lib/contact-model';
import { TenantCredentials } from '../lib/tenant-credentials';

/**
 * A2b-2：Dev 專用的訂單測試（手動觸發，ADR-025）。
 * Dev-only order tests, triggered manually.
 *
 * 1. 冪等風暴：同一個 Idempotency-Key 同時送 10 次 → 只產生 1 筆訂單（03 §11）。
 * 2. 搶庫存：100 個不同的 key 同時各訂 1 kg，庫存 10 kg → 不超賣（03 §11）。
 * 3. IAM 探測：用租戶 A 的**真實憑證**直接呼叫 DynamoDB，越權動作必須 AccessDeniedException（A2 決策 D4）。
 *    A4c 加上 KMS：encryption context 的 tenant_id 不是自己、多了鍵、或沒有 context → 拒絕。
 * 4. 逾時取消（A3d，兩段）：`timeout-setup` 建立兩筆訂單並確認其中一筆；等逾時後 `timeout-check`
 *    確認未確認的那筆被 `system:timeout` 取消、庫存釋放，已確認的那筆不受影響。
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
  /** 租戶範圍的 KMS client（A4c）/ Tenant-scoped KMS client. */
  readonly kmsFor?: (tenantId: string) => Pick<KMSClient, 'send'>;
  readonly keyArn?: string;
}

/**
 * KMS 探測（A4c，ADR-029 D2）：租戶 A 的真實憑證只能用 `{tenant_id: A, field}` 加解密。
 * KMS probe: tenant A's real credentials may only encrypt/decrypt with `{tenant_id: A, field}`.
 */
export async function kmsProbes(kms: Pick<KMSClient, 'send'>, keyArn: string): Promise<Check[]> {
  const pt = Buffer.from('probe@example.com');
  const own = { tenant_id: TENANT_A, field: 'email' };
  const enc = (EncryptionContext?: Record<string, string>) => kms.send(new EncryptCommand({ KeyId: keyArn, Plaintext: pt, EncryptionContext }));
  const checks: Check[] = [];
  let ciphertext: Uint8Array | undefined;
  checks.push(
    await probe('kms: A encrypts with own context (control)', false, async () => {
      ciphertext = (await enc(own)).CiphertextBlob;
    }),
  );
  checks.push(
    await probe('kms: A decrypts with own context (control)', false, () =>
      kms.send(new DecryptCommand({ KeyId: keyArn, CiphertextBlob: ciphertext ?? new Uint8Array([0]), EncryptionContext: own })),
    ),
    await probe("kms: A decrypts presenting B's context → AccessDenied", true, () =>
      kms.send(new DecryptCommand({ KeyId: keyArn, CiphertextBlob: ciphertext ?? new Uint8Array([0]), EncryptionContext: { ...own, tenant_id: TENANT_B } })),
    ),
    await probe("kms: A encrypts with B's context → AccessDenied", true, () => enc({ ...own, tenant_id: TENANT_B })),
    await probe('kms: A encrypts with an extra context key → AccessDenied', true, () => enc({ ...own, extra: 'x' })),
    await probe('kms: A encrypts with an unknown field → AccessDenied', true, () => enc({ ...own, field: 'notes' })),
    await probe('kms: A encrypts without context → AccessDenied', true, () => enc(undefined)),
    await probe('kms: A generates a data key directly → AccessDenied', true, () =>
      kms.send(new GenerateDataKeyCommand({ KeyId: keyArn, KeySpec: 'AES_256', EncryptionContext: own })),
    ),
  );
  return checks;
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
    if (d.kmsFor && d.keyArn) checks.push(...(await kmsProbes(d.kmsFor(TENANT_A), d.keyArn)));
    else checks.push({ name: 'kms probes need KMS_KEY_ARN', ok: false, detail: 'missing' });
  } finally {
    stats.cleaned = await cleanTenants(d).catch((e: Error) => `failed: ${e.name}`);
    await resetStock(d, RACE_STOCK_KG).catch(() => undefined);
  }
  return { passed: checks.every((c) => c.ok), checks, stats };
}

/**
 * 逾時取消測試，第一段：租戶 B 下兩筆 1 kg 訂單（X、Y），以 staff 邏輯確認 Y；X 保持 CREATED。
 * Timeout test, part 1: two 1 kg orders for tenant B; Y is confirmed, X stays CREATED.
 */
export async function timeoutSetup(d: Deps, admin: AdminOrderRepo, timeoutSeconds: number, beforeOrders?: () => Promise<void>) {
  await cleanTenants(d);
  await resetStock(d, RACE_STOCK_KG);
  if (beforeOrders) await beforeOrders();
  const repo = new OrderRepo(d.forTenant, d.tableName);
  const place = async () => {
    const r = await repo.createOrder({
      tenantId: TENANT_B,
      createdBy: 'order-tests',
      idempotencyKey: `timeout-${ulid()}`,
      request: { items: [{ product_id: TEST_PRODUCT_ID, qty_kg: 1 }] },
      orderId: `o_${ulid()}`,
      now: new Date(),
    });
    if (r.kind !== 'created') throw new Error(`setup order: ${r.kind}`);
    return r.order.order_id;
  };
  const cancelId = await place();
  const keepId = await place();
  const confirmed = await admin.transition({ tenantId: TENANT_B, orderId: keepId, to: 'CONFIRMED', actor: 'test:confirm', now: new Date() });
  if (confirmed.kind !== 'updated') throw new Error(`confirm: ${confirmed.kind}`);
  const stock = await readStock(d);
  return {
    tenant_id: TENANT_B,
    cancel_order_id: cancelId,
    keep_order_id: keepId,
    stock,
    check_after: new Date(Date.now() + (timeoutSeconds + 60) * 1000).toISOString(),
  };
}

/**
 * 第二段：逾時之後檢查。**只在全部通過時清理**；太早執行或資料不存在時不動任何資料，可以重跑。
 * Part 2: check after the timeout. Cleans up only when every check passes; running too early or after the
 * data is gone changes nothing, so it can be re-run.
 */
export async function timeoutCheck(
  d: Deps,
  admin: AdminOrderRepo,
  cancelId: string,
  keepId: string,
  timeoutSeconds: number,
  now: Date = new Date(),
) {
  const x = await admin.get(TENANT_B, cancelId, true);
  const y = await admin.get(TENANT_B, keepId, true);
  if (!x || !y) {
    // 被清理過（例如提早執行的舊版檢查、或完整測試）→ 必須重跑 setup
    // The data is gone (e.g. an earlier run cleaned it up) → run timeout-setup again.
    return {
      passed: false,
      state: 'data_missing',
      message: 'Test orders no longer exist; run {"mode":"timeout-setup"} again',
      checks: [{ name: 'timeout: test orders exist', ok: false, detail: `cancel=${x ? 'found' : 'missing'}, keep=${y ? 'found' : 'missing'}` }],
    };
  }
  // 逾時加 60 秒緩衝之前，工作流可能還在等待 → 不判定、不清理
  // Before timeout + 60 s the workflow may still be waiting → no verdict, no cleanup.
  const readyAt = new Date(new Date(x.created_at).getTime() + (timeoutSeconds + 60) * 1000);
  if (x.status === 'CREATED' && now < readyAt) {
    const wait = Math.ceil((readyAt.getTime() - now.getTime()) / 1000);
    return {
      passed: false,
      state: 'too_early',
      message: `The timeout has not elapsed; run timeout-check again after ${readyAt.toISOString()} (about ${wait} s)`,
      checks: [{ name: 'timeout: waited long enough', ok: false, detail: `ready at ${readyAt.toISOString()}` }],
    };
  }

  const last = x.status_history?.at(-1);
  const checks: Check[] = [
    { name: 'timeout: unconfirmed order is CANCELLED', ok: x.status === 'CANCELLED', detail: x.status },
    { name: 'timeout: cancelled by system:timeout', ok: last?.by === 'system:timeout' && last?.from === 'CREATED', detail: JSON.stringify(last ?? null) },
    { name: 'timeout: confirmed order untouched (CONFIRMED)', ok: y.status === 'CONFIRMED', detail: y.status },
  ];
  const stock = await readStock(d);
  checks.push({
    name: 'timeout: stock released for the cancelled order only (9/1)',
    ok: stock.available_kg === RACE_STOCK_KG - 1 && stock.reserved_kg === 1,
    detail: JSON.stringify(stock),
  });
  const passed = checks.every((c) => c.ok);
  if (passed) {
    await cleanTenants(d).catch(() => undefined);
    await resetStock(d, RACE_STOCK_KG).catch(() => undefined);
  }
  // 失敗時保留資料，方便查 DynamoDB 與工作流歷程 / Keep the data on failure for investigation.
  return { passed, state: passed ? 'passed' : 'failed_data_kept', checks };
}

/** Lambda 進入點（只由 scripts/run-order-tests.sh 手動呼叫）/ Entry point, invoked manually. */
export const handler = async (event: { mode?: string; cancel_order_id?: string; keep_order_id?: string; email?: string } = {}) => {
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
  const fixture = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
  const keyArn = process.env.KMS_KEY_ARN;
  const kmsClients = new Map<string, KMSClient>();
  const kmsFor = (tenantId: string) => {
    let c = kmsClients.get(tenantId);
    if (!c) {
      c = new KMSClient({ credentials: () => creds.get(tenantId) });
      kmsClients.set(tenantId, c);
    }
    return c;
  };
  const deps: Deps = { fixture, forTenant, tableName, kmsFor, keyArn };
  // 夾具角色只允許測試租戶與 p-9001（IAM 完全比對）/ The fixture role is limited to the test tenants and p-9001.
  const admin = new AdminOrderRepo(fixture, tableName, 'gsi1');
  const mode = event.mode ?? 'all';
  if (mode === 'timeout-setup') return timeoutSetup(deps, admin, Number(process.env.ORDER_TIMEOUT_SECONDS ?? '600'));
  if (mode === 'notify-setup') {
    // A4d 端到端：先替租戶 B 寫入聯絡人（Email 只在呼叫的 payload 裡，不進 repo、不寫日誌），
    // 再跑逾時測試的第一段 → 預期收到 2 封「已建立」、1 封「已確認」，逾時後 1 封「已取消」。
    // A4d end to end: write tenant B's contact (the address lives only in the invoke payload; never logged), then
    // run timeout-setup → expect 2 "received", 1 "confirmed", and 1 "cancelled" after the timeout.
    const contact = ContactSchema.safeParse({ name: 'BrewLine Tester', email: event.email });
    if (!contact.success || !keyArn) throw new Error('notify-setup needs {"email": "<SES-verified address>"} and KMS_KEY_ARN');
    const contacts = new ContactRepo(forTenant, kmsFor, tableName, keyArn);
    const r = await timeoutSetup(deps, admin, Number(process.env.ORDER_TIMEOUT_SECONDS ?? '600'), async () => {
      await contacts.put(TENANT_B, contact.data, 'order-tests', new Date());
    });
    return { ...r, expected_emails: { now: ['received ×2', 'confirmed ×1'], after_timeout: ['cancelled ×1'] } };
  }
  if (mode === 'timeout-check') {
    if (!event.cancel_order_id || !event.keep_order_id) throw new Error('cancel_order_id and keep_order_id are required');
    const r = await timeoutCheck(deps, admin, event.cancel_order_id, event.keep_order_id, Number(process.env.ORDER_TIMEOUT_SECONDS ?? '600'));
    logger.info('timeout check finished', { passed: r.passed, state: r.state, failed: r.checks.filter((c) => !c.ok) });
    return r;
  }
  if (mode !== 'all') throw new Error(`unknown mode ${mode}`);
  const result = await runAll(deps);
  logger.info('order tests finished', { passed: result.passed, stats: result.stats, failed: result.checks.filter((c) => !c.ok) });
  return result;
};
