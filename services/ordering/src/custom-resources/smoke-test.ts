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
import { Logger } from '@aws-lambda-powertools/logger';
import type { CloudFormationCustomResourceEvent } from 'aws-lambda';

/**
 * A1 smoke test（只在 Dev；CloudFormation custom resource，每次部署都執行，失敗就讓部署失敗並 rollback）。
 * A1 smoke test (Dev only). Runs on every deploy; a failure fails the deploy and rolls back.
 *
 * 建立暫時的使用者 → 以 ADMIN_USER_PASSWORD_AUTH 取得 token → 呼叫真正的 API → 刪除使用者。
 * Creates throwaway users, gets tokens, calls the real API, deletes the users.
 * 密碼每次隨機產生、只存在記憶體，不寫入任何地方 / Passwords are random, in memory only.
 */

const logger = new Logger({ serviceName: 'ordering-smoke-a1' });
const cognito = new CognitoIdentityProviderClient({});

const USER_PREFIX = 'smoke-a1-';
const TENANT_ID = 't_01SMKTEST000000000000000A1';

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
}

interface Tokens {
  readonly access: string;
  readonly id: string;
}

type Role = 'cafe' | 'staff' | 'simulator' | 'conflict';

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
    ...(role === 'staff' ? [] : [{ Name: 'custom:tenant_id', Value: TENANT_ID }]),
  ];
  await cognito.send(
    new AdminCreateUserCommand({ UserPoolId: cfg.userPoolId, Username: username, UserAttributes: attrs, MessageAction: 'SUPPRESS' }),
  );
  await cognito.send(
    new AdminSetUserPasswordCommand({ UserPoolId: cfg.userPoolId, Username: username, Password: password, Permanent: true }),
  );
  const groups: string[] = role === 'conflict' ? ['cafe', 'staff'] : [role];
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

async function call(cfg: Config, path: string, token?: string): Promise<{ status: number; body: any }> {
  const res = await fetch(new URL(path, cfg.apiUrl), {
    headers: token ? { authorization: `Bearer ${token}` } : {},
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

  return checks;
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
  };
  if (event.RequestType === 'Delete') {
    await deleteLeftovers(cfg.userPoolId).catch(() => undefined);
    return { PhysicalResourceId: physicalResourceId };
  }

  await deleteLeftovers(cfg.userPoolId);
  const runId = randomBytes(4).toString('hex');
  const created: string[] = [];
  let checks: Check[] = [];
  try {
    const tokens = {} as Record<Role, Tokens>;
    for (const role of ['cafe', 'staff', 'simulator', 'conflict'] as const) {
      const u = await createUser(cfg, runId, role);
      created.push(u.username);
      tokens[role] = u.tokens;
    }
    checks = await runChecks(cfg, tokens);
  } finally {
    await deleteUsers(cfg.userPoolId, created);
  }

  const failed = checks.filter((c) => !c.ok);
  for (const c of checks) logger.info(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}`, { detail: c.detail });
  const summary = `${checks.length - failed.length}/${checks.length} passed (commit ${String(props.Commit).slice(0, 7)})`;
  if (failed.length > 0) {
    // 讓 CloudFormation 顯示失敗原因並 rollback / Surface the reason in CloudFormation and roll back.
    throw new Error(`A1 smoke test failed: ${failed.map((c) => `${c.name} [${c.detail}]`).join('; ')}`);
  }
  return { PhysicalResourceId: physicalResourceId, Data: { Summary: summary } };
};
