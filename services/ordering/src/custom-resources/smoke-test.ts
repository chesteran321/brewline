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
import { DeleteScheduleCommand, GetScheduleCommand, SchedulerClient } from '@aws-sdk/client-scheduler';
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
const scheduler = new SchedulerClient({});

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
  /** 模擬器 app client（ADR-030 D2）/ Simulator app client. */
  readonly simulatorClientId: string;
  readonly productId: string;
  /** 下單用的 Dev 測試商品（p-9002，不在目錄）/ Dev test product for orders (hidden from the catalog). */
  readonly orderProductId: string;
  readonly tableName: string;
  /** 定期補貨的 Scheduler 群組（A4e）/ Replenishment schedule group. */
  readonly scheduleGroup: string;
  /** 測試商品的生豆批次（S2a，seed/test-lots.json）/ The test product's green lot. */
  readonly orderLotId: string;
}

interface Tokens {
  readonly access: string;
  readonly id: string;
}

/** 經由 simulator client 登入的 token（ADR-030 D2）/ Tokens obtained through the simulator client. */
export interface SimClientTokens {
  readonly simulator: Tokens;
  readonly cafe: Tokens;
  readonly staff: Tokens;
  /** 模擬烘焙廠（S2a，ADR-031 D6）/ Simulated roastery operator. */
  readonly roaster: Tokens;
}

type Role = 'cafe' | 'cafeB' | 'staff' | 'simulator' | 'conflict' | 'roaster';

function decodeClaims(jwt: string): Record<string, unknown> {
  const payload = jwt.split('.')[1] ?? '';
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
}

const randomPassword = () => `${randomBytes(18).toString('base64url')}Aa1!`;

async function login(userPoolId: string, clientId: string, username: string, password: string, label: string): Promise<Tokens> {
  const auth = await cognito.send(
    new AdminInitiateAuthCommand({
      UserPoolId: userPoolId,
      ClientId: clientId,
      AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
      AuthParameters: { USERNAME: username, PASSWORD: password },
    }),
  );
  const access = auth.AuthenticationResult?.AccessToken;
  const id = auth.AuthenticationResult?.IdToken;
  if (!access || !id) throw new Error(`No tokens for ${label} (challenge: ${auth.ChallengeName ?? 'none'})`);
  return { access, id };
}

async function createUser(
  cfg: Config,
  runId: string,
  role: Role,
): Promise<{ username: string; tokens: Tokens; password: string }> {
  const username = `${USER_PREFIX}${runId}-${role}@example.com`; // 保留網域 / reserved domain
  const password = randomPassword();
  const attrs = [
    { Name: 'email', Value: username },
    { Name: 'email_verified', Value: 'true' },
    ...(role === 'staff' || role === 'roaster' ? [] : [{ Name: 'custom:tenant_id', Value: role === 'cafeB' ? TENANT_B_ID : TENANT_ID }]),
  ];
  await cognito.send(
    new AdminCreateUserCommand({ UserPoolId: cfg.userPoolId, Username: username, UserAttributes: attrs, MessageAction: 'SUPPRESS' }),
  );
  await cognito.send(
    new AdminSetUserPasswordCommand({ UserPoolId: cfg.userPoolId, Username: username, Password: password, Permanent: true }),
  );
  const groups: string[] =
    role === 'conflict' ? ['cafe', 'staff'] : role === 'cafeB' ? ['cafe'] : role === 'roaster' ? ['simulator-roastery'] : [role];
  for (const g of groups) {
    await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: cfg.userPoolId, Username: username, GroupName: g }));
  }
  return { username, tokens: await login(cfg.userPoolId, cfg.clientId, username, password, role), password };
}

async function call(
  cfg: Config,
  path: string,
  token?: string,
  post?: { body: unknown; key?: string; method?: 'POST' | 'PATCH' | 'PUT' | 'DELETE' },
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

/**
 * 模擬器 client 與 synthetic claim（ADR-030 D2／D6）。不下單，不影響後面的庫存斷言。
 * Simulator client and the synthetic claim. Places no orders, so later stock assertions are unaffected.
 */
export async function simulatorClientChecks(cfg: Config, tokens: Record<Role, Tokens>, sim: SimClientTokens): Promise<Check[]> {
  const checks: Check[] = [];
  const expect = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  // 正向 / Positive
  const s = decodeClaims(sim.simulator.access);
  expect('simulator via simulator client: client_id', s.client_id === cfg.simulatorClientId, String(s.client_id));
  expect('simulator via simulator client: orders.write scope', String(s.scope).includes('brewline/orders.write'), String(s.scope));
  expect('simulator via simulator client: synthetic claim', s.synthetic === 'true', String(s.synthetic));
  let r = await call(cfg, '/products', sim.simulator.access);
  expect('simulator-client token GET /products → 200 (audience)', r.status === 200, `got ${r.status}`);
  r = await call(cfg, '/orders', sim.simulator.access);
  expect('simulator-client token GET /orders → 200', r.status === 200, `got ${r.status}`);
  // synthetic 來自群組，與 client 無關 / Synthetic follows the group, not the client.
  expect('simulator via smoke client: synthetic claim', decodeClaims(tokens.simulator.access).synthetic === 'true', '');
  expect('cafe token has no synthetic claim', decodeClaims(tokens.cafe.access).synthetic === undefined, '');

  // 反向：simulator client 只服務 simulator 群組 / Negative: the simulator client serves the simulator group only.
  const c = decodeClaims(sim.cafe.access);
  expect('cafe via simulator client: no brewline scopes', !String(c.scope).includes('brewline/'), String(c.scope));
  r = await call(cfg, '/products', sim.cafe.access);
  expect('cafe via simulator client GET /products → 403', r.status === 403, `got ${r.status}`);
  const st = decodeClaims(sim.staff.access);
  expect('staff via simulator client: no brewline scopes', !String(st.scope).includes('brewline/'), String(st.scope));
  r = await call(cfg, `/admin/products/${cfg.productId}/stock`, sim.staff.access);
  expect('staff via simulator client GET /admin/... → 403', r.status === 403, `got ${r.status}`);

  // S2a：模擬烘焙廠經由 simulator client：roastery scope、synthetic、沒有 admin、沒有租戶
  // Simulated roastery through the simulator client: roastery scope, synthetic, no admin, no tenant.
  const ro = decodeClaims(sim.roaster.access);
  expect(
    'roaster via simulator client: roastery scope, no admin, no tenant, synthetic',
    String(ro.scope).includes('brewline/roastery') && !String(ro.scope).includes('brewline/admin') && ro.tenant_id === undefined && ro.synthetic === 'true',
    String(ro.scope),
  );
  r = await call(cfg, `/admin/products/${cfg.productId}/stock`, sim.roaster.access);
  expect('roaster GET /admin/products/{id}/stock → 200 (roastery scope)', r.status === 200, `got ${r.status}`);
  r = await call(cfg, '/orders', sim.roaster.access);
  expect('roaster GET /orders → 403 (not a tenant)', r.status === 403, `got ${r.status}`);
  return checks;
}

export async function runChecks(cfg: Config, tokens: Record<Role, Tokens>, roaster: Tokens = tokens.roaster): Promise<Check[]> {
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

  checks.push(...(await contactChecks(cfg, tokens)));
  checks.push(...(await replenishmentChecks(cfg, tokens)));
  const orders = await orderChecks(cfg, tokens);
  checks.push(...orders.checks);
  if (orders.orderId && orders.simOrderId) checks.push(...(await adminChecks(cfg, tokens, orders.orderId, orders.simOrderId, roaster)));
  else checks.push({ name: 'admin checks need both smoke orders', ok: false, detail: 'missing order ids' });
  checks.push(...(await shipmentChecks(cfg, tokens, roaster)));
  return checks;
}

/** Smoke 訂艙用的虛構船（api-stack 的 SMOKE_VESSELS；IAM 只允許清理這兩艘的邊）/ Smoke vessels (IAM-scoped cleanup). */
export const SMOKE_VESSELS = { real: 'SIMV-98', synthetic: 'SIMV-99' } as const;

/**
 * P2b-1 訂艙（ADR-032 補充 E3／E10）：模擬烘焙廠建立模擬貨運、staff 建立真實貨運；POL／POD 由伺服器依批次決定；
 * 冪等、TW 批次沒有海運、synthetic 隔離。測試批次 L-9999-002 → BRSSZ → TWKHH。
 * Bookings: idempotency, server-side POL/POD, the domestic lot, synthetic isolation. Test lot → BRSSZ → TWKHH.
 */
export async function shipmentChecks(cfg: Config, tokens: Record<Role, Tokens>, roaster: Tokens): Promise<Check[]> {
  const checks: Check[] = [];
  const expect = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const run = randomBytes(6).toString('hex');
  const day = 86_400_000;
  const dep = new Date(Math.ceil(Date.now() / day) * day + 2 * day).toISOString().replace('.000Z', 'Z');
  const arr = new Date(Date.parse(dep) + 30 * day).toISOString().replace('.000Z', 'Z');
  const body = (o: Record<string, unknown> = {}) => ({
    lot_id: cfg.orderLotId, planned_departure: dep, planned_arrival: arr, carrier_voyage_number: 'D999E',
    vessel_id: SMOKE_VESSELS.synthetic, vessel_name: 'Demo Smoke', ...o,
  });
  const post = (b: unknown, token?: string, key?: string) => call(cfg, '/admin/shipments', token, { body: b, key });
  const kSim = `smk-ship-${run}-sim`;
  const kReal = `smk-ship-${run}-real`;

  let r = await post(body(), roaster.access, kSim);
  const simId = typeof r.body?.shipment_id === 'string' ? (r.body.shipment_id as string) : undefined;
  expect(
    'roaster POST /admin/shipments → 201 synthetic, POL/POD from the lot (BRSSZ → TWKHH)',
    r.status === 201 && r.body?.synthetic === true && r.body?.pol === 'BRSSZ' && r.body?.pod === 'TWKHH' && r.body?.status === 'PLANNED',
    `got ${r.status} ${r.body?.pol}->${r.body?.pod}`,
  );
  expect(
    'booking and container numbers are fictional (BLDEMO…, DMQU…)',
    /^BLDEMO/.test(String(r.body?.carrier_booking_reference)) && /^DMQU\d{7}$/.test(String(r.body?.equipment?.[0]?.equipment_reference)),
    'checked',
  );
  r = await post(body(), roaster.access, kSim);
  expect('same Idempotency-Key → 200, same shipment', r.status === 200 && r.body?.shipment_id === simId, `got ${r.status}`);
  r = await post(body({ vessel_name: 'Demo Other' }), roaster.access, kSim);
  expect('same key, different body → 422', r.status === 422, `got ${r.status}`);
  r = await post(body({ vessel_id: SMOKE_VESSELS.real }), tokens.staff.access, kReal);
  const realId = typeof r.body?.shipment_id === 'string' ? (r.body.shipment_id as string) : undefined;
  expect('staff POST → 201 real (synthetic false)', r.status === 201 && r.body?.synthetic === false, `got ${r.status}`);

  // --- 反向 / Negative ---
  r = await post(body({ lot_id: 'L-2026-008' }), roaster.access, `smk-ship-${run}-tw`);
  expect('domestic lot L-2026-008 → 400 no_sea_route', r.status === 400 && r.body?.error?.code === 'no_sea_route', `got ${r.status} ${r.body?.error?.code}`);
  r = await post(body({ lot_id: 'L-0000-000' }), roaster.access, `smk-ship-${run}-unk`);
  expect('unknown lot → 400 lot_not_found', r.status === 400 && r.body?.error?.code === 'lot_not_found', `got ${r.status}`);
  r = await post(body(), roaster.access);
  expect('no Idempotency-Key → 400', r.status === 400, `got ${r.status}`);
  r = await post(body({ synthetic: false }), roaster.access, `smk-ship-${run}-syn`);
  expect('body with synthetic → 400 (never trust the client)', r.status === 400, `got ${r.status}`);
  r = await post(body({ vessel_id: 'IMO1234567' }), roaster.access, `smk-ship-${run}-imo`);
  expect('synthetic caller with a non-SIMV vessel → 400 invalid_vessel', r.status === 400 && r.body?.error?.code === 'invalid_vessel', `got ${r.status}`);
  r = await post(body(), tokens.cafe.access, `smk-ship-${run}-cafe`);
  expect('cafe POST /admin/shipments → 403', r.status === 403, `got ${r.status}`);
  r = await post(body(), undefined, `smk-ship-${run}-anon`);
  expect('no token → 401', r.status === 401, `got ${r.status}`);

  // --- 讀取與 synthetic 隔離 / Reads and synthetic isolation ---
  r = await call(cfg, `/admin/shipments/${simId}`, roaster.access);
  expect('roaster GET own synthetic shipment → 200 with events/track', r.status === 200 && Array.isArray(r.body?.events) && Array.isArray(r.body?.track), `got ${r.status}`);
  r = await call(cfg, `/admin/shipments/${realId}`, roaster.access);
  expect('roaster GET a real shipment → 404', r.status === 404, `got ${r.status}`);
  r = await call(cfg, `/admin/shipments/${realId}`, tokens.staff.access);
  expect('staff GET a real shipment → 200', r.status === 200 && r.body?.shipment_id === realId, `got ${r.status}`);
  r = await call(cfg, `/admin/shipments?lot=${cfg.orderLotId}`, tokens.staff.access);
  const staffIds = Array.isArray(r.body?.items) ? r.body.items.map((i: any) => i.shipment_id) : [];
  expect('staff lists both shipments of the lot', r.status === 200 && staffIds.includes(simId) && staffIds.includes(realId), `items ${staffIds.length}`);
  r = await call(cfg, `/admin/shipments?lot=${cfg.orderLotId}`, roaster.access);
  const roasterItems: any[] = Array.isArray(r.body?.items) ? r.body.items : [];
  expect('roaster list shows synthetic shipments only', r.status === 200 && roasterItems.length > 0 && roasterItems.every((i) => i.synthetic === true), `items ${roasterItems.length}`);
  r = await call(cfg, `/admin/shipments?lot=${cfg.orderLotId}`, tokens.simulator.access);
  expect('simulator café GET /admin/shipments → 403', r.status === 403, `got ${r.status}`);
  return checks;
}

/**
 * A4c 聯絡人（ADR-029 D2／D4）：只有 cafe 有 profile scope；租戶 B 讀不到 A；DynamoDB 裡只有密文。
 * Contacts: cafe-only scopes, tenant isolation, and ciphertext-only storage.
 */
export async function contactChecks(cfg: Config, tokens: Record<Role, Tokens>): Promise<Check[]> {
  const checks: Check[] = [];
  const expect = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  // 假資料：example.com 是保留網域（RFC 2606），不是任何人的信箱 / Reserved example domain, nobody's address.
  const contact = { name: 'Smoke Contact', email: `smoke-${randomBytes(4).toString('hex')}@example.com`, phone: '+886900000000' };
  const put = (body: unknown, token = tokens.cafe.access) => call(cfg, '/tenant/contact', token, { body, method: 'PUT' });

  let r = await call(cfg, '/tenant/contact', tokens.cafe.access);
  expect('contact: GET before PUT → 404', r.status === 404, `got ${r.status}`);
  r = await put(contact);
  expect('contact: cafe PUT → 200', r.status === 200 && r.body?.email === contact.email, `got ${r.status}`);
  r = await call(cfg, '/tenant/contact', tokens.cafe.access);
  expect(
    'contact: cafe GET → same values (KMS round trip)',
    r.status === 200 && r.body?.name === contact.name && r.body?.email === contact.email && r.body?.phone === contact.phone,
    `got ${r.status}`,
  );

  // 反向 / Negative
  r = await call(cfg, '/tenant/contact', tokens.cafeB.access);
  expect("contact: tenant B GET → 404 (cannot see A's)", r.status === 404, `got ${r.status}`);
  r = await call(cfg, '/tenant/contact', tokens.simulator.access);
  expect('contact: simulator GET → 403 (no profile scope)', r.status === 403, `got ${r.status}`);
  r = await put(contact, tokens.staff.access);
  expect('contact: staff PUT → 403', r.status === 403, `got ${r.status}`);
  r = await put({ name: 'x', email: 'not-an-email' });
  expect('contact: invalid email → 400', r.status === 400 && r.body?.error?.code === 'invalid_contact', `got ${r.status}`);
  r = await put({ ...contact, tenant_id: TENANT_B_ID });
  expect('contact: tenant_id in body → 400', r.status === 400, `got ${r.status}`);

  // DynamoDB 裡沒有明文 / No plaintext at rest (read with the fixture role, which cannot decrypt fields).
  const raw = await doc.send(
    new QueryCommand({
      TableName: cfg.tableName,
      KeyConditionExpression: 'pk = :pk AND sk = :sk',
      ExpressionAttributeValues: { ':pk': `TENANT#${TENANT_ID}`, ':sk': 'CONTACT#primary' },
    }),
  );
  const text = JSON.stringify(raw.Items ?? []);
  expect(
    'contact: stored item has ciphertext only',
    (raw.Items?.length ?? 0) === 1 && !text.includes(contact.email) && !text.includes(contact.name) && !text.includes(contact.phone),
    `items ${raw.Items?.length ?? 0}`,
  );
  const cafe = decodeClaims(tokens.cafe.access);
  const sim = decodeClaims(tokens.simulator.access);
  expect('cafe token has profile scopes', String(cafe.scope).includes('brewline/profile.write'), String(cafe.scope));
  expect('simulator token has no profile scope', !String(sim.scope).includes('brewline/profile.'), String(sim.scope));
  return checks;
}

/** 排程是否存在；回傳時區與運算式 / Whether the schedule exists, with its timezone and expression. */
async function getSchedule(group: string, name: string): Promise<{ tz?: string; expr?: string } | undefined> {
  try {
    const s = await scheduler.send(new GetScheduleCommand({ GroupName: group, Name: name }));
    return { tz: s.ScheduleExpressionTimezone, expr: s.ScheduleExpression };
  } catch (err) {
    if ((err as Error).name === 'ResourceNotFoundException') return undefined;
    throw err;
  }
}

/**
 * A4e 定期補貨（ADR-029 D6）：建立 → 排程存在（台北 09:00）→ 列出 → 上限 5 → 隔離 → 刪除後排程消失。
 * Replenishment: create → schedule exists (09:00 Asia/Taipei) → list → limit 5 → isolation → delete removes the schedule.
 */
export async function replenishmentChecks(cfg: Config, tokens: Record<Role, Tokens>): Promise<Check[]> {
  const checks: Check[] = [];
  const expect = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const body = { frequency: 'weekly', day_of_week: 'MON', items: [{ product_id: cfg.orderProductId, qty_kg: 1 }] };
  const create = (b: unknown = body, token = tokens.cafe.access) => call(cfg, '/replenishments', token, { body: b });
  const del = (id: string, token = tokens.cafe.access) => call(cfg, `/replenishments/${id}`, token, { body: undefined, method: 'DELETE' });

  let r = await create();
  const id: string | undefined = r.body?.replenishment_id;
  expect('repl: cafe POST → 201', r.status === 201 && !!id && r.body?.run_at === '09:00 Asia/Taipei', `got ${r.status}`);
  const sched = id ? await getSchedule(cfg.scheduleGroup, `${TENANT_ID}-${id}`) : undefined;
  expect('repl: schedule exists (Asia/Taipei, MON 09:00)', sched?.tz === 'Asia/Taipei' && sched?.expr === 'cron(0 9 ? * MON *)', JSON.stringify(sched ?? null));
  r = await call(cfg, '/replenishments', tokens.cafe.access);
  expect('repl: GET lists it', r.status === 200 && (r.body?.items ?? []).some((i: any) => i.replenishment_id === id), `got ${r.status}`);

  // 反向 / Negative
  r = await create({ frequency: 'monthly', day_of_month: 31, items: body.items });
  expect('repl: day_of_month 31 → 400', r.status === 400, `got ${r.status}`);
  r = await create({ ...body, items: [{ product_id: 'p-9999', qty_kg: 1 }] });
  expect('repl: unknown product → 400', r.status === 400 && r.body?.error?.code === 'unknown_products', `got ${r.status}`);
  r = await create(body, tokens.staff.access);
  expect('repl: staff POST → 403', r.status === 403, `got ${r.status}`);
  r = await call(cfg, '/replenishments', tokens.cafeB.access);
  expect("repl: tenant B GET → empty (cannot see A's)", r.status === 200 && (r.body?.items ?? []).length === 0, `got ${r.status}`);
  if (id) {
    r = await del(id, tokens.cafeB.access);
    const still = await getSchedule(cfg.scheduleGroup, `${TENANT_ID}-${id}`);
    expect("repl: tenant B DELETE A's → 204 but nothing removed", r.status === 204 && !!still, `got ${r.status}`);
  }
  const extra: string[] = [];
  for (let i = 0; i < 4; i++) {
    const x = await create();
    if (x.body?.replenishment_id) extra.push(x.body.replenishment_id);
  }
  r = await create();
  expect('repl: 6th → 409 limit_reached', r.status === 409 && r.body?.error?.code === 'limit_reached', `got ${r.status} (created ${extra.length + 1})`);

  // 刪除 → 排程消失、清單變空 / Delete → schedules gone, list empty.
  for (const x of [id, ...extra].filter((v): v is string => !!v)) await del(x);
  const left = await Promise.all([id, ...extra].filter((v): v is string => !!v).map((x) => getSchedule(cfg.scheduleGroup, `${TENANT_ID}-${x}`)));
  r = await call(cfg, '/replenishments', tokens.cafe.access);
  expect('repl: DELETE removes schedules and items', left.every((v) => !v) && (r.body?.items ?? []).length === 0, `left ${left.filter(Boolean).length}`);
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
export async function adminChecks(
  cfg: Config,
  tokens: Record<Role, Tokens>,
  orderId: string,
  simOrderId: string,
  roaster: Tokens,
): Promise<Check[]> {
  const checks: Check[] = [];
  const expect = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const path = (id: string) => `/admin/tenants/${TENANT_ID}/orders/${id}`;
  const patch = (id: string, status: string, token = tokens.staff.access) =>
    call(cfg, path(id), token, { body: { status }, method: 'PATCH' });
  const stock = async () => (await call(cfg, `/admin/products/${cfg.orderProductId}/stock`, tokens.staff.access)).body;

  // --- synthetic 標記（ADR-030 D6）：staff 看得到，咖啡廳的 DTO 沒有 / Staff see it; the café DTO never has it ---
  let r = await call(cfg, path(simOrderId), tokens.staff.access);
  expect('staff GET simulator order → synthetic true', r.status === 200 && r.body?.synthetic === true, `got ${r.status} ${r.body?.synthetic}`);
  r = await call(cfg, path(orderId), tokens.staff.access);
  expect('staff GET cafe order → synthetic false', r.status === 200 && r.body?.synthetic === false, `got ${r.status} ${r.body?.synthetic}`);
  r = await call(cfg, `/orders/${simOrderId}`, tokens.cafe.access);
  expect('public order DTO has no synthetic field', r.status === 200 && !('synthetic' in (r.body ?? {})), `got ${r.status}`);

  // --- 反向：授權與輸入 / Negative: authorization and input ---
  r = await patch(orderId, 'CONFIRMED', tokens.cafe.access);
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

  // --- S2a：模擬烘焙廠只碰模擬訂單 / The simulated roastery touches synthetic orders only ---
  r = await patch(orderId, 'CONFIRMED', roaster.access);
  expect('roaster PATCH real order → 403 synthetic_only', r.status === 403 && r.body?.error?.code === 'synthetic_only', `got ${r.status}`);
  r = await call(cfg, path(orderId), roaster.access);
  expect('roaster GET real order → 404', r.status === 404, `got ${r.status}`);
  r = await call(cfg, '/admin/orders?status=CREATED&limit=50', roaster.access);
  const roasterList = Array.isArray(r.body?.items) ? r.body.items : [];
  expect(
    'roaster list shows synthetic orders only',
    r.status === 200 && roasterList.length > 0 && roasterList.every((o: any) => o.synthetic === true),
    `items ${roasterList.length}`,
  );
  r = await patch(simOrderId, 'CONFIRMED', roaster.access);
  expect('roaster PATCH synthetic order CREATED → CONFIRMED', r.status === 200 && r.body?.status === 'CONFIRMED', `got ${r.status}`);

  // --- 正向：完整流程、烘焙批次與庫存 / Positive: lifecycle with a roast batch, and stock ---
  let ok = true;
  for (const s of ['CONFIRMED', 'ROASTING_SCHEDULED']) {
    r = await patch(orderId, s);
    ok &&= r.status === 200 && r.body?.status === s;
  }
  expect('CREATED → CONFIRMED → ROASTING_SCHEDULED', ok, `last ${r.status} ${r.body?.status}`);
  r = await patch(orderId, 'ROASTED');
  expect('ROASTED before any allocation → 409 not_fully_allocated', r.status === 409 && r.body?.error?.code === 'not_fully_allocated', `got ${r.status}`);
  const roast = await roastChecks(cfg, tokens, orderId, roaster, expect);
  r = await patch(orderId, 'ROASTED');
  expect('fully allocated to a roasted batch → ROASTED', r.status === 200 && r.body?.status === 'ROASTED', `got ${r.status}`);
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
  expect('cafe order DTO has no allocation details', !('allocations' in (await call(cfg, `/orders/${orderId}`, tokens.cafe.access)).body), '');
  if (roast) await traceChecks(cfg, tokens, orderId, roast, roaster, expect);
  await restockChecks(cfg, tokens, roaster, expect);
  return checks;
}

type Expect = (name: string, ok: boolean, detail: string) => void;

/**
 * S2a 烘焙批次（ADR-031 D5／D9）。進入時：smoke 訂單 3 kg 在 ROASTING_SCHEDULED。回傳批次 ID。
 * Roast batch checks. On entry the 3 kg smoke order is ROASTING_SCHEDULED. Returns the roast id.
 */
async function roastChecks(cfg: Config, tokens: Record<Role, Tokens>, orderId: string, roaster: Tokens, expect: Expect): Promise<string | undefined> {
  const key = `smoke-roast-${randomBytes(6).toString('hex')}`;
  const body = (kg: number, alloc = 3) => ({
    product_id: cfg.orderProductId,
    roast_date: new Date().toISOString().slice(0, 10),
    kg,
    allocations: [{ tenant_id: TENANT_ID, order_id: orderId, kg: alloc }],
  });
  const post = (b: unknown, token: string, k?: string) => call(cfg, '/admin/roasts', token, { body: b, key: k });

  // 反向 / Negative
  let r = await post(body(5), tokens.cafe.access, key);
  expect('cafe POST /admin/roasts → 403', r.status === 403, `got ${r.status}`);
  r = await post(body(5), roaster.access, key);
  expect('roaster allocates a real order → 403 synthetic_only', r.status === 403 && r.body?.error?.code === 'synthetic_only', `got ${r.status}`);
  r = await post(body(5), tokens.staff.access);
  expect('POST /admin/roasts without Idempotency-Key → 400', r.status === 400, `got ${r.status}`);
  r = await post(body(16, 3), tokens.staff.access, `${key}-big`);
  expect('batch > 15 kg → 400', r.status === 400, `got ${r.status}`);
  r = await post(body(5, 4), tokens.staff.access, `${key}-over`);
  expect('allocate 4 kg to a 3 kg line → 409 over_allocated', r.status === 409 && r.body?.error?.remaining_kg === 3, `got ${r.status}`);

  // 正向 / Positive
  r = await post(body(5), tokens.staff.access, key);
  const roastId: string | undefined = r.body?.roast_id;
  expect(
    'staff POST /admin/roasts → 201 SCHEDULED on the product lot',
    r.status === 201 && r.body?.status === 'SCHEDULED' && r.body?.lot_id === cfg.orderLotId && /^r_[0-9A-Z]{26}$/.test(roastId ?? ''),
    `got ${r.status} ${r.body?.lot_id}`,
  );
  r = await post(body(5), tokens.staff.access, key);
  expect('same key and body → 200 same batch (idempotent)', r.status === 200 && r.body?.roast_id === roastId, `got ${r.status}`);
  r = await post(body(6), tokens.staff.access, key);
  expect('same key, different body → 422', r.status === 422, `got ${r.status}`);
  if (!roastId) return undefined;

  r = await call(cfg, `/admin/tenants/${TENANT_ID}/orders/${orderId}`, undefined);
  r = await call(cfg, `/admin/tenants/${TENANT_ID}/orders/${orderId}`, tokens.staff.access, { body: { status: 'ROASTED' }, method: 'PATCH' });
  expect('order ROASTED while its batch is SCHEDULED → 409 roast_not_roasted', r.status === 409 && r.body?.error?.code === 'roast_not_roasted', `got ${r.status}`);
  r = await call(cfg, `/admin/roasts/${roastId}`, roaster.access, { body: { status: 'ROASTED' }, method: 'PATCH' });
  expect('roaster PATCH a real batch → 404', r.status === 404, `got ${r.status}`);
  r = await call(cfg, `/admin/roasts/${roastId}`, tokens.staff.access, { body: { status: 'ROASTED' }, method: 'PATCH' });
  expect('batch SCHEDULED → ROASTED mints a 22-char QR token', r.status === 200 && /^[A-Za-z0-9_-]{22}$/.test(r.body?.qr_token ?? ''), `got ${r.status}`);
  r = await call(cfg, `/admin/roasts/${roastId}`, tokens.staff.access, { body: { status: 'ROASTED' }, method: 'PATCH' });
  expect('roast twice → 409 (token minted once)', r.status === 409, `got ${r.status}`);
  return roastId;
}

/** S2a 雙向追溯與召回（TRC-F-006／008）/ Bidirectional trace and recall. */
async function traceChecks(cfg: Config, tokens: Record<Role, Tokens>, orderId: string, roastId: string, roaster: Tokens, expect: Expect): Promise<void> {
  let r = await call(cfg, `/admin/trace?tenant=${TENANT_ID}&order=${orderId}`, tokens.staff.access);
  expect(
    'trace order → roast batch → lot (back to the farm)',
    r.status === 200 && r.body?.lines?.[0]?.roasts?.[0]?.roast_id === roastId && r.body?.lots?.[0]?.lot_id === cfg.orderLotId &&
      typeof r.body?.lots?.[0]?.producer_display_name === 'string',
    `got ${r.status}`,
  );
  r = await call(cfg, `/admin/trace?roast=${roastId}`, tokens.staff.access);
  expect(
    'trace roast batch → orders and lot',
    r.status === 200 && r.body?.orders?.some((o: any) => o.order_id === orderId && o.kg === 3) && r.body?.lot?.lot_id === cfg.orderLotId,
    `got ${r.status}`,
  );
  r = await call(cfg, `/admin/trace?lot=${cfg.orderLotId}`, tokens.staff.access);
  expect('trace lot → roast batches', r.status === 200 && r.body?.roasts?.some((x: any) => x.roast_id === roastId), `got ${r.status}`);
  r = await call(cfg, `/admin/trace?lot=${cfg.orderLotId}`, tokens.cafe.access);
  expect('cafe GET /admin/trace → 403', r.status === 403, `got ${r.status}`);
  r = await call(cfg, `/admin/trace?roast=${roastId}`, roaster.access);
  expect('roaster traces a real batch → 404', r.status === 404, `got ${r.status}`);
  r = await call(cfg, `/admin/trace?lot=${cfg.orderLotId}&roast=${roastId}`, tokens.staff.access);
  expect('trace with two query forms → 400', r.status === 400, `got ${r.status}`);

  const notice = { notice: 'Smoke test recall notice: do not consume.' };
  r = await call(cfg, `/admin/roasts/${roastId}/recall`, roaster.access, { body: notice });
  expect('roaster recall → 403 (admin only)', r.status === 403, `got ${r.status}`);
  r = await call(cfg, `/admin/roasts/${roastId}/recall`, tokens.staff.access, { body: { notice: '<b>x</b> injected' } });
  expect('recall notice with markup → 400', r.status === 400, `got ${r.status}`);
  r = await call(cfg, `/admin/roasts/${roastId}/recall`, tokens.staff.access, { body: notice });
  expect('staff recall → 200 with notice', r.status === 200 && r.body?.recall?.notice === notice.notice, `got ${r.status}`);
  r = await call(cfg, `/admin/roasts/${roastId}/recall`, tokens.staff.access, { body: notice });
  expect('recall twice → 409', r.status === 409, `got ${r.status}`);
}

/** S2a 補貨（ADR-031 D7）。進入時測試商品 97／0 / Restock; stock is 97/0 on entry. */
async function restockChecks(cfg: Config, tokens: Record<Role, Tokens>, roaster: Tokens, expect: Expect): Promise<void> {
  const url = `/admin/products/${cfg.orderProductId}/restock`;
  const before = (await call(cfg, `/admin/products/${cfg.orderProductId}/stock`, tokens.staff.access)).body;
  const v = before?.version;
  let r = await call(cfg, url, tokens.cafe.access, { body: { kg: 5, expected_version: v } });
  expect('cafe restock → 403', r.status === 403, `got ${r.status}`);
  r = await call(cfg, url, tokens.staff.access, { body: { kg: 0, expected_version: v } });
  expect('restock 0 kg → 400', r.status === 400, `got ${r.status}`);
  r = await call(cfg, url, tokens.staff.access, { body: { kg: 5, expected_version: v } });
  expect('staff restock +5 kg → 102 available, version +1', r.status === 200 && r.body?.available_kg === 102 && r.body?.version === v + 1, `got ${r.status} ${r.body?.available_kg}`);
  r = await call(cfg, url, tokens.staff.access, { body: { kg: 5, expected_version: v } });
  expect('replayed restock (stale version) → 409, no double add', r.status === 409 && r.body?.error?.current_version === v + 1, `got ${r.status}`);
  r = await call(cfg, url, roaster.access, { body: { kg: 1, expected_version: v + 1 } });
  expect('roaster restock +1 kg → 103', r.status === 200 && r.body?.available_kg === 103, `got ${r.status} ${r.body?.available_kg}`);
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

/** 刪除測試租戶的所有項目（訂單、冪等記錄、補貨＋其排程）/ Delete every item of the test tenants (and replenishment schedules). */
async function cleanTenants(tableName: string, scheduleGroup?: string): Promise<number> {
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
        if (scheduleGroup && typeof item.sk === 'string' && item.sk.startsWith('REPL#')) {
          const name = `${t}-r_${item.sk.slice('REPL#'.length)}`;
          await scheduler.send(new DeleteScheduleCommand({ GroupName: scheduleGroup, Name: name })).catch(() => undefined);
        }
        await doc.send(new DeleteCommand({ TableName: tableName, Key: { pk: item.pk, sk: item.sk } }));
        deleted++;
      }
      startKey = out.LastEvaluatedKey;
    } while (startKey);
  }
  return deleted;
}

/**
 * 刪除 smoke 的烘焙批次：測試批次的邊 → 每個 ROAST#<id> 的所有項目 → 邊本身（IAM 只限測試批次與 ROAST#）。
 * Delete smoke roast batches via the test lot's edges (IAM: the test lot and ROAST# only).
 */
async function cleanRoasts(tableName: string, lotId: string): Promise<number> {
  let deleted = 0;
  const all = async (pk: string, prefix?: string) =>
    (
      await doc.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: prefix ? 'pk = :pk AND begins_with(sk, :p)' : 'pk = :pk',
          ExpressionAttributeValues: { ':pk': pk, ...(prefix ? { ':p': prefix } : {}) },
          ProjectionExpression: 'pk, sk, roast_id',
        }),
      )
    ).Items ?? [];
  for (const edge of await all(`LOT#${lotId}`, 'ROAST#')) {
    for (const item of await all(`ROAST#${String(edge.roast_id)}`)) {
      await doc.send(new DeleteCommand({ TableName: tableName, Key: { pk: item.pk, sk: item.sk } }));
      deleted++;
    }
    await doc.send(new DeleteCommand({ TableName: tableName, Key: { pk: edge.pk, sk: edge.sk } }));
    deleted++;
  }
  return deleted;
}

/**
 * 刪除 smoke 的貨運：測試批次的 SHIP# 邊 → SHIP#<id> 的所有項目 → smoke 船的邊 → 批次邊（IAM 只限這些前綴）。
 * Delete smoke shipments via the test lot's edges (IAM: the test lot, SHIP# and the smoke vessels only).
 */
async function cleanShipments(tableName: string, lotId: string): Promise<number> {
  let deleted = 0;
  const vessels = new Set<string>(Object.values(SMOKE_VESSELS));
  const del = async (pk: unknown, sk: unknown) => {
    await doc.send(new DeleteCommand({ TableName: tableName, Key: { pk, sk } }));
    deleted++;
  };
  const edges =
    (
      await doc.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: 'pk = :pk AND begins_with(sk, :p)',
          ExpressionAttributeValues: { ':pk': `LOT#${lotId}`, ':p': 'SHIP#' },
          ProjectionExpression: 'pk, sk, shipment_id, planned_departure',
        }),
      )
    ).Items ?? [];
  for (const edge of edges) {
    const items =
      (
        await doc.send(
          new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: 'pk = :pk',
            ExpressionAttributeValues: { ':pk': `SHIP#${String(edge.shipment_id)}` },
            ProjectionExpression: 'pk, sk, vessel',
          }),
        )
      ).Items ?? [];
    for (const item of items) {
      const vesselId = (item.vessel as { vessel_id?: string } | undefined)?.vessel_id;
      if (item.sk === 'META' && vesselId && vessels.has(vesselId)) {
        await del(`VESSEL#${vesselId}`, `VOY#${String(edge.planned_departure)}#${String(edge.shipment_id)}`);
      }
      await del(item.pk, item.sk);
    }
    await del(edge.pk, edge.sk);
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
    simulatorClientId: String(props.SimulatorClientId),
    productId: String(props.ProductId),
    orderProductId: String(props.OrderProductId),
    tableName: String(props.TableName),
    scheduleGroup: String(props.ScheduleGroup),
    orderLotId: String(props.OrderLotId),
  };
  if (event.RequestType === 'Delete') {
    await deleteLeftovers(cfg.userPoolId).catch(() => undefined);
    return { PhysicalResourceId: physicalResourceId };
  }

  await deleteLeftovers(cfg.userPoolId);
  await cleanTenants(cfg.tableName, cfg.scheduleGroup);
  await cleanRoasts(cfg.tableName, cfg.orderLotId);
  await cleanShipments(cfg.tableName, cfg.orderLotId);
  await resetStock(cfg.tableName, cfg.orderProductId);
  const runId = randomBytes(4).toString('hex');
  const created: string[] = [];
  let checks: Check[] = [];
  try {
    const tokens = {} as Record<Role, Tokens>;
    const users = {} as Record<Role, { username: string; password: string }>;
    for (const role of ['cafe', 'cafeB', 'staff', 'simulator', 'conflict', 'roaster'] as const) {
      const u = await createUser(cfg, runId, role);
      created.push(u.username);
      tokens[role] = u.tokens;
      users[role] = u;
    }
    // 同一批使用者再經由 simulator client 登入（密碼只在記憶體）/ Same users through the simulator client.
    const viaSim = (role: 'simulator' | 'cafe' | 'staff' | 'roaster') =>
      login(cfg.userPoolId, cfg.simulatorClientId, users[role].username, users[role].password, `${role} via simulator client`);
    const sim: SimClientTokens = {
      simulator: await viaSim('simulator'),
      cafe: await viaSim('cafe'),
      staff: await viaSim('staff'),
      roaster: await viaSim('roaster'),
    };
    // 模擬烘焙廠一律經由 simulator client（與正式運作相同）/ The roaster always goes through the simulator client, as in production.
    checks = [...(await simulatorClientChecks(cfg, tokens, sim)), ...(await runChecks(cfg, tokens, sim.roaster))];
  } finally {
    await deleteUsers(cfg.userPoolId, created);
    const deleted = await cleanTenants(cfg.tableName, cfg.scheduleGroup).catch((err: Error) => {
      logger.warn('Could not clean test tenants', { error: err.name });
      return -1;
    });
    const roastsDeleted = await cleanRoasts(cfg.tableName, cfg.orderLotId).catch((err: Error) => {
      logger.warn('Could not clean smoke roasts', { error: err.name });
      return -1;
    });
    const shipmentsDeleted = await cleanShipments(cfg.tableName, cfg.orderLotId).catch((err: Error) => {
      logger.warn('Could not clean smoke shipments', { error: err.name });
      return -1;
    });
    logger.info('Test tenant items deleted', { deleted, roastsDeleted, shipmentsDeleted });
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
