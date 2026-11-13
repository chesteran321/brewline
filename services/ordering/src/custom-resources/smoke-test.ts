import { randomBytes } from 'node:crypto';
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminInitiateAuthCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { Logger } from '@aws-lambda-powertools/logger';
import type { CloudFormationCustomResourceEvent } from 'aws-lambda';

/**
 * A1＋A2 smoke test（只在 Dev；CloudFormation custom resource，每次部署都執行，失敗就讓部署失敗並 rollback）。
 * A1 smoke test (Dev only). Runs on every deploy; a failure fails the deploy and rolls back.
 *
 * 建立暫時的使用者 → 以 ADMIN_USER_PASSWORD_AUTH 取得 token → 呼叫真正的 API → 刪除使用者。
 * Creates throwaway users, gets tokens, calls the real API, deletes the users.
 * 密碼每次隨機產生、只存在記憶體，不寫入任何地方 / Passwords are random, in memory only.
 */

const logger = new Logger({ serviceName: 'ordering-smoke-a1' });
const cognito = new CognitoIdentityProviderClient({});

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const USER_PREFIX = 'smoke-a1-';
/** 固定的測試租戶：smoke 角色只能刪這兩個分割區 / Fixed test tenants; the smoke role may delete only these partitions. */
export const TENANT_ID = 't_01SMKTEST000000000000000A1';
export const TENANT_B_ID = 't_01SMKTEST000000000000000B1';
/** 每次測試前把測試商品庫存重設為這個值 / Test product stock is reset to this before each run. */
export const SMOKE_STOCK_KG = 100;
/** Dev 的 POST /orders 路由限流 2 req/s、突發 5 → 每次下單間隔 / Pace POSTs under the Dev route throttle. */
const POST_GAP_MS = 600;

export interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

interface Config {
  readonly apiUrl: string;
  readonly userPoolId: string;
  readonly clientId: string;
  readonly productId: string;
  /** 下單用的 Dev 測試商品（p-9002，不在目錄）/ Dev test product for orders (hidden from the catalog). */
  readonly orderProductId: string;
  readonly tableName: string;
}

interface Tokens {
  readonly access: string;
  readonly id: string;
}

type Role = 'cafe' | 'cafeB' | 'staff' | 'simulator' | 'conflict';

function decodeClaims(jwt: string): Record<string, unknown> {
  const payload = jwt.split('.')[1] ?? '';
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
}

const randomPassword = () => `${randomBytes(18).toString('base64url')}Aa1!`;

async function createUser(cfg: Config, runId: string, role: Role): Promise<{ username: string; tokens: Tokens }> {
  const username = `${USER_PREFIX}${runId}-${role}@example.com`; // 保留網域 / reserved domain
  const password = randomPassword();
  const attrs = [
    { Name: 'email', Value: username },
    { Name: 'email_verified', Value: 'true' },
    ...(role === 'staff' ? [] : [{ Name: 'custom:tenant_id', Value: role === 'cafeB' ? TENANT_B_ID : TENANT_ID }]),
  ];
  await cognito.send(
    new AdminCreateUserCommand({ UserPoolId: cfg.userPoolId, Username: username, UserAttributes: attrs, MessageAction: 'SUPPRESS' }),
  );
  await cognito.send(
    new AdminSetUserPasswordCommand({ UserPoolId: cfg.userPoolId, Username: username, Password: password, Permanent: true }),
  );
  const groups: string[] = role === 'conflict' ? ['cafe', 'staff'] : role === 'cafeB' ? ['cafe'] : [role];
  for (const g of groups) {
    await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: cfg.userPoolId, Username: username, GroupName: g }));
  }
  const auth = await cognito.send(
    new AdminInitiateAuthCommand({
      UserPoolId: cfg.userPoolId,
      ClientId: cfg.clientId,
      AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
      AuthParameters: { USERNAME: username, PASSWORD: password },
    }),
  );
  const access = auth.AuthenticationResult?.AccessToken;
  const id = auth.AuthenticationResult?.IdToken;
  if (!access || !id) throw new Error(`No tokens for ${role} (challenge: ${auth.ChallengeName ?? 'none'})`);
  return { username, tokens: { access, id } };
}

async function call(
  cfg: Config,
  path: string,
  token?: string,
  post?: { body: unknown; key?: string; method?: 'POST' | 'PATCH' },
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  if (post) {
    if ((post.method ?? 'POST') === 'POST') await new Promise((r) => setTimeout(r, POST_GAP_MS));
    headers['content-type'] = 'application/json';
    if (post.key) headers['idempotency-key'] = post.key;
  }
  const res = await fetch(new URL(path, cfg.apiUrl), {
    method: post ? (post.method ?? 'POST') : 'GET',
    headers,
    body: post ? JSON.stringify(post.body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* 非 JSON / not JSON */
  }
  return { status: res.status, body };
}

/** 公開 DTO 不可出現的欄位 / Fields that must never appear in the public DTO. */
const INTERNAL_FIELDS = ['pk', 'sk', 'gsi1pk', 'gsi1sk', 'available_kg', 'reserved_kg', 'version', 'low_threshold_kg', 'entity'];

export async function runChecks(cfg: Config, tokens: Record<Role, Tokens>): Promise<Check[]> {
  const checks: Check[] = [];
  const expect = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const p = cfg.productId;

  // --- 驗證（401）/ Authentication ---
  let r = await call(cfg, '/products');
  expect('no token → 401', r.status === 401, `got ${r.status}`);

  // --- 正向 / Positive ---
  r = await call(cfg, '/products', tokens.cafe.access);
  const items: any[] = Array.isArray(r.body?.items) ? r.body.items : [];
  expect('cafe GET /products → 200', r.status === 200, `got ${r.status}`);
  expect('catalog has ≥ 1 product', items.length >= 1, `count ${items.length}`);
  const leaked = items.flatMap((i) => INTERNAL_FIELDS.filter((f) => f in i));
  expect('public DTO leaks no internal fields', leaked.length === 0, leaked.join(',') || 'none');
  expect(
    'every product has stock_status',
    items.every((i) => ['in_stock', 'low', 'out'].includes(i.stock_status)),
    'checked',
  );

  r = await call(cfg, `/products/${p}`, tokens.cafe.access);
  expect(`cafe GET /products/${p} → 200`, r.status === 200 && r.body?.id === p, `got ${r.status}`);

  r = await call(cfg, `/admin/products/${p}/stock`, tokens.staff.access);
  expect(
    'staff GET /admin/.../stock → 200 with kg',
    r.status === 200 && typeof r.body?.available_kg === 'number',
    `got ${r.status}`,
  );

  r = await call(cfg, '/products', tokens.simulator.access);
  expect('simulator GET /products → 200', r.status === 200, `got ${r.status}`);

  // --- 反向：授權（403）/ Negative: authorization ---
  r = await call(cfg, `/admin/products/${p}/stock`, tokens.cafe.access);
  expect('cafe GET /admin/... → 403', r.status === 403, `got ${r.status}`);

  r = await call(cfg, `/admin/products/${p}/stock`, tokens.simulator.access);
  expect('simulator GET /admin/... → 403', r.status === 403, `got ${r.status}`);

  r = await call(cfg, '/products', tokens.conflict.access);
  expect('cafe+staff (fail closed) GET /products → 403', r.status === 403, `got ${r.status}`);

  // ID token 沒有 scope → 有 scope 要求的路由拒絕 / ID tokens carry no scope.
  r = await call(cfg, '/products', tokens.cafe.id);
  expect('cafe ID token → 401/403', r.status === 401 || r.status === 403, `got ${r.status}`);

  // --- 反向：輸入 / Negative: input ---
  r = await call(cfg, '/products/p-9999', tokens.cafe.access);
  expect('unknown product → 404', r.status === 404, `got ${r.status}`);
  r = await call(cfg, '/products/DROP-TABLE', tokens.cafe.access);
  expect('invalid product id → 400', r.status === 400, `got ${r.status}`);

  // --- Token 內容 / Token claims ---
  const cafe = decodeClaims(tokens.cafe.access);
  const staff = decodeClaims(tokens.staff.access);
  expect('cafe access token has tenant_id', cafe.tenant_id === TENANT_ID, String(cafe.tenant_id));
  expect('cafe access token has no admin scope', !String(cafe.scope).includes('brewline/admin'), String(cafe.scope));
  expect('staff access token has admin scope', String(staff.scope).includes('brewline/admin'), String(staff.scope));
  expect('staff access token has no tenant_id', staff.tenant_id === undefined, String(staff.tenant_id));

  const orders = await orderChecks(cfg, tokens);
  checks.push(...orders.checks);
  if (orders.orderId && orders.simOrderId) checks.push(...(await adminChecks(cfg, tokens, orders.orderId, orders.simOrderId)));
  else checks.push({ name: 'admin checks need both smoke orders', ok: false, detail: 'missing order ids' });
  return checks;
}

/**
 * A2 訂單檢查（ADR-025）。使用 Dev 測試商品，開始前庫存已重設為 SMOKE_STOCK_KG。
 * A2 order checks against the Dev test product, whose stock was reset to SMOKE_STOCK_KG.
 */
export async function orderChecks(
  cfg: Config,
  tokens: Record<Role, Tokens>,
): Promise<{ checks: Check[]; orderId?: string; simOrderId?: string }> {
  const checks: Check[] = [];
  const expect = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const p = cfg.orderProductId;
  const run = randomBytes(6).toString('hex');
  const k1 = `smoke-${run}-k1`;
  const one = (qty: number, id = p) => ({ items: [{ product_id: id, qty_kg: qty }] });

  // --- 反向：驗證與輸入 / Negative: auth and input ---
  let r = await call(cfg, '/orders', undefined, { body: one(1), key: k1 });
  expect('POST /orders without token → 401', r.status === 401, `got ${r.status}`);
  r = await call(cfg, '/orders', tokens.cafe.access, { body: one(1) });
  expect('POST /orders without Idempotency-Key → 400', r.status === 400, `got ${r.status}`);
  r = await call(cfg, '/orders', tokens.cafe.access, { body: one(0), key: `smoke-${run}-k0` });
  expect('qty 0 → 400', r.status === 400, `got ${r.status}`);
  const lines26 = Array.from({ length: 26 }, (_, i) => ({ product_id: `p-${String(i + 1).padStart(4, '0')}`, qty_kg: 1 }));
  r = await call(cfg, '/orders', tokens.cafe.access, { body: { items: lines26 }, key: `smoke-${run}-k26` });
  expect('26 lines → 400 with limits', r.status === 400 && r.body?.error?.limits?.max_lines === 25, `got ${r.status}`);
  r = await call(cfg, '/orders', tokens.cafe.access, { body: one(1, 'p-9999'), key: `smoke-${run}-kx` });
  expect('unknown product → 400', r.status === 400 && r.body?.error?.code === 'unknown_products', `got ${r.status}`);

  // --- 正向：下單與冪等 / Positive: create and idempotency ---
  r = await call(cfg, '/orders', tokens.cafe.access, { body: one(3), key: k1 });
  const orderId: string | undefined = r.body?.order_id;
  expect(
    'cafe POST /orders → 201 CREATED / PAID_MOCK',
    r.status === 201 && r.body?.status === 'CREATED' && r.body?.payment_status === 'PAID_MOCK',
    `got ${r.status}`,
  );
  expect('server-side total = price × qty', r.body?.total === r.body?.items?.[0]?.price_per_kg * 3, `total ${r.body?.total}`);
  expect('order DTO has no internal fields', !['pk', 'sk', 'tenant_id', 'created_by'].some((f) => f in (r.body ?? {})), 'checked');
  r = await call(cfg, '/orders', tokens.cafe.access, { body: one(3), key: k1 });
  expect('replay same key + body → 200, same order_id', r.status === 200 && r.body?.order_id === orderId, `got ${r.status}`);
  r = await call(cfg, '/orders', tokens.cafe.access, { body: one(4), key: k1 });
  expect('same key, different body → 422', r.status === 422, `got ${r.status}`);

  // --- 反向：庫存不足時什麼都不扣 / Negative: nothing is reserved when stock is short ---
  r = await call(cfg, '/orders', tokens.cafe.access, { body: one(500), key: `smoke-${run}-k2` });
  expect('qty > stock → 409', r.status === 409 && r.body?.error?.code === 'insufficient_stock', `got ${r.status}`);
  r = await call(cfg, `/admin/products/${p}/stock`, tokens.staff.access);
  expect(
    `stock after (1 order + replay + 409) = ${SMOKE_STOCK_KG - 3}/3`,
    r.body?.available_kg === SMOKE_STOCK_KG - 3 && r.body?.reserved_kg === 3,
    `available ${r.body?.available_kg}, reserved ${r.body?.reserved_kg}`,
  );

  // --- 授權 / Authorization ---
  r = await call(cfg, '/orders', tokens.staff.access, { body: one(1), key: `smoke-${run}-ks` });
  expect('staff POST /orders → 403', r.status === 403, `got ${r.status}`);
  r = await call(cfg, '/orders', tokens.cafe.id, { body: one(1), key: `smoke-${run}-ki` });
  expect('cafe ID token POST → 401/403', r.status === 401 || r.status === 403, `got ${r.status}`);
  r = await call(cfg, '/orders', tokens.simulator.access, { body: one(2), key: `smoke-${run}-k3` });
  const simOrderId: string | undefined = r.body?.order_id;
  expect('simulator POST /orders → 201', r.status === 201, `got ${r.status}`);

  // --- 查詢與租戶隔離 / Reads and tenant isolation ---
  r = await call(cfg, '/orders', tokens.cafe.access);
  const ids: string[] = Array.isArray(r.body?.items) ? r.body.items.map((o: any) => o.order_id) : [];
  expect('cafe GET /orders → both tenant orders', r.status === 200 && !!orderId && ids.includes(orderId) && !!simOrderId && ids.includes(simOrderId), `ids ${ids.length}`);
  r = await call(cfg, `/orders/${orderId}`, tokens.cafe.access);
  expect('cafe GET /orders/{id} → 200', r.status === 200 && r.body?.order_id === orderId, `got ${r.status}`);
  r = await call(cfg, `/orders/${orderId}`, tokens.cafeB.access);
  expect("tenant B GET tenant A's order → 404", r.status === 404, `got ${r.status}`);
  r = await call(cfg, '/orders', tokens.cafeB.access);
  expect('tenant B GET /orders → 200, empty', r.status === 200 && Array.isArray(r.body?.items) && r.body.items.length === 0, `got ${r.status}`);
  r = await call(cfg, '/orders/o_bad', tokens.cafe.access);
  expect('invalid order id → 400', r.status === 400, `got ${r.status}`);
  r = await call(cfg, '/orders', tokens.staff.access);
  expect('staff GET /orders → 403', r.status === 403, `got ${r.status}`);

  const cafe = decodeClaims(tokens.cafe.access);
  const staff = decodeClaims(tokens.staff.access);
  expect('cafe token has orders.write', String(cafe.scope).includes('brewline/orders.write'), String(cafe.scope));
  expect('staff token has no orders scope', !String(staff.scope).includes('brewline/orders.'), String(staff.scope));
  return { checks, orderId, simOrderId };
}

/**
 * A3c staff 狀態轉換（ADR-027）。進入時：cafe 訂單 3 kg（CREATED）、simulator 訂單 2 kg（CREATED），
 * 測試商品庫存 available 95／reserved 5。
 * Staff transitions. On entry: cafe order 3 kg and simulator order 2 kg, both CREATED; stock 95/5.
 */
export async function adminChecks(cfg: Config, tokens: Record<Role, Tokens>, orderId: string, simOrderId: string): Promise<Check[]> {
  const checks: Check[] = [];
  const expect = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const path = (id: string) => `/admin/tenants/${TENANT_ID}/orders/${id}`;
  const patch = (id: string, status: string, token = tokens.staff.access) =>
    call(cfg, path(id), token, { body: { status }, method: 'PATCH' });
  const stock = async () => (await call(cfg, `/admin/products/${cfg.orderProductId}/stock`, tokens.staff.access)).body;

  // --- 反向：授權與輸入 / Negative: authorization and input ---
  let r = await patch(orderId, 'CONFIRMED', tokens.cafe.access);
  expect('cafe PATCH admin order → 403', r.status === 403, `got ${r.status}`);
  r = await call(cfg, path(orderId), undefined, { body: { status: 'CONFIRMED' }, method: 'PATCH' });
  expect('PATCH without token → 401', r.status === 401, `got ${r.status}`);
  r = await patch(orderId, 'LOST');
  expect('unknown status → 400', r.status === 400, `got ${r.status}`);
  r = await patch(orderId, 'SHIPPED');
  expect('skip CREATED → SHIPPED → 409 with allowed list', r.status === 409 && Array.isArray(r.body?.error?.allowed), `got ${r.status}`);
  r = await call(cfg, `/admin/tenants/${TENANT_B_ID}/orders/${orderId}`, tokens.staff.access);
  expect('wrong tenant in path → 404', r.status === 404, `got ${r.status}`);

  // --- 正向：staff 列表與明細 / Positive: staff list and detail ---
  r = await call(cfg, '/admin/orders?status=CREATED&limit=50', tokens.staff.access);
  const listed = Array.isArray(r.body?.items) ? r.body.items : [];
  expect(
    'staff GET /admin/orders?status=CREATED lists smoke orders with tenant_id',
    r.status === 200 && listed.some((o: any) => o.order_id === orderId && o.tenant_id === TENANT_ID),
    `items ${listed.length}`,
  );
  r = await call(cfg, '/admin/orders', tokens.cafe.access);
  expect('cafe GET /admin/orders → 403', r.status === 403, `got ${r.status}`);

  // --- 正向：完整流程與庫存 / Positive: full lifecycle and stock ---
  let ok = true;
  for (const s of ['CONFIRMED', 'ROASTING_SCHEDULED', 'ROASTED']) {
    r = await patch(orderId, s);
    ok &&= r.status === 200 && r.body?.status === s;
  }
  expect('CREATED → CONFIRMED → ROASTING_SCHEDULED → ROASTED', ok, `last ${r.status} ${r.body?.status}`);
  r = await patch(orderId, 'CANCELLED');
  expect('cancel after roasting is scheduled → 409', r.status === 409, `got ${r.status}`);
  r = await patch(orderId, 'SHIPPED');
  let st = await stock();
  expect('SHIPPED consumes the reservation: 95/2', r.status === 200 && st?.available_kg === 95 && st?.reserved_kg === 2, `available ${st?.available_kg}, reserved ${st?.reserved_kg}`);
  r = await patch(orderId, 'COMPLETED');
  expect('SHIPPED → COMPLETED', r.status === 200 && r.body?.status === 'COMPLETED', `got ${r.status}`);
  r = await patch(simOrderId, 'CANCELLED');
  st = await stock();
  expect('CANCELLED releases the reservation: 97/0', r.status === 200 && st?.available_kg === 97 && st?.reserved_kg === 0, `available ${st?.available_kg}, reserved ${st?.reserved_kg}`);
  r = await patch(simOrderId, 'CANCELLED');
  expect('cancel twice → 409 (no double release)', r.status === 409, `got ${r.status}`);
  st = await stock();
  expect('stock unchanged after the rejected cancel', st?.available_kg === 97 && st?.reserved_kg === 0, `available ${st?.available_kg}`);

  // --- 咖啡廳看到的結果 / What the café sees ---
  r = await call(cfg, `/orders/${orderId}`, tokens.cafe.access);
  const hist = Array.isArray(r.body?.status_history) ? r.body.status_history : [];
  expect(
    'cafe sees COMPLETED with 5 history entries, without staff identity',
    r.status === 200 && r.body?.status === 'COMPLETED' && hist.length === 5 && hist.every((h: any) => !('by' in h)),
    `status ${r.body?.status}, history ${hist.length}`,
  );
  r = await call(cfg, path(orderId), tokens.staff.access);
  expect(
    'staff detail shows who changed it',
    r.status === 200 && (r.body?.status_history ?? []).every((h: any) => typeof h.by === 'string' && h.by.startsWith('staff:')),
    `got ${r.status}`,
  );
  return checks;
}

/** 測試商品庫存重設（只有 Dev 測試商品，IAM 限定 key）/ Reset the test product's stock. */
async function resetStock(tableName: string, productId: string): Promise<void> {
  await doc.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        pk: `PRODUCT#${productId}`,
        sk: 'STOCK',
        entity: 'Stock',
        available_kg: SMOKE_STOCK_KG,
        reserved_kg: 0,
        low_threshold_kg: 10,
        version: 1,
        updated_at: new Date().toISOString(),
      },
    }),
  );
}

/** 刪除測試租戶的所有項目（訂單、冪等記錄）/ Delete every item of the fixed test tenants. */
async function cleanTenants(tableName: string): Promise<number> {
  let deleted = 0;
  for (const t of [TENANT_ID, TENANT_B_ID]) {
    let startKey: Record<string, unknown> | undefined;
    do {
      const out = await doc.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: 'pk = :pk',
          ExpressionAttributeValues: { ':pk': `TENANT#${t}` },
          ProjectionExpression: 'pk, sk',
          ExclusiveStartKey: startKey,
        }),
      );
      for (const item of out.Items ?? []) {
        await doc.send(new DeleteCommand({ TableName: tableName, Key: { pk: item.pk, sk: item.sk } }));
        deleted++;
      }
      startKey = out.LastEvaluatedKey;
    } while (startKey);
  }
  return deleted;
}

async function deleteUsers(userPoolId: string, usernames: string[]): Promise<void> {
  for (const username of usernames) {
    try {
      await cognito.send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: username }));
    } catch (err) {
      logger.warn('Could not delete smoke user', { error: (err as Error).name });
    }
  }
}

/** 清掉上次中斷留下的使用者 / Remove users left over from an interrupted run. */
async function deleteLeftovers(userPoolId: string): Promise<void> {
  const out = await cognito.send(
    new ListUsersCommand({ UserPoolId: userPoolId, Filter: `email ^= "${USER_PREFIX}"`, Limit: 60 }),
  );
  await deleteUsers(userPoolId, (out.Users ?? []).map((u) => u.Username).filter((u): u is string => !!u));
}

export const handler = async (event: CloudFormationCustomResourceEvent) => {
  const physicalResourceId = 'brewline-a1-smoke-test';
  const props = event.ResourceProperties;
  const cfg: Config = {
    apiUrl: String(props.ApiUrl),
    userPoolId: String(props.UserPoolId),
    clientId: String(props.ClientId),
    productId: String(props.ProductId),
    orderProductId: String(props.OrderProductId),
    tableName: String(props.TableName),
  };
  if (event.RequestType === 'Delete') {
    await deleteLeftovers(cfg.userPoolId).catch(() => undefined);
    return { PhysicalResourceId: physicalResourceId };
  }

  await deleteLeftovers(cfg.userPoolId);
  await cleanTenants(cfg.tableName);
  await resetStock(cfg.tableName, cfg.orderProductId);
  const runId = randomBytes(4).toString('hex');
  const created: string[] = [];
  let checks: Check[] = [];
  try {
    const tokens = {} as Record<Role, Tokens>;
    for (const role of ['cafe', 'cafeB', 'staff', 'simulator', 'conflict'] as const) {
      const u = await createUser(cfg, runId, role);
      created.push(u.username);
      tokens[role] = u.tokens;
    }
    checks = await runChecks(cfg, tokens);
  } finally {
    await deleteUsers(cfg.userPoolId, created);
    const deleted = await cleanTenants(cfg.tableName).catch((err: Error) => {
      logger.warn('Could not clean test tenants', { error: err.name });
      return -1;
    });
    logger.info('Test tenant items deleted', { deleted });
  }

  const failed = checks.filter((c) => !c.ok);
  for (const c of checks) logger.info(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}`, { detail: c.detail });
  const summary = `${checks.length - failed.length}/${checks.length} passed (commit ${String(props.Commit).slice(0, 7)})`;
  if (failed.length > 0) {
    // 讓 CloudFormation 顯示失敗原因並 rollback / Surface the reason in CloudFormation and roll back.
    throw new Error(`Smoke test failed: ${failed.map((c) => `${c.name} [${c.detail}]`).join('; ')}`);
  }
  return { PhysicalResourceId: physicalResourceId, Data: { Summary: summary } };
};
