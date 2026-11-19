import { AdminInitiateAuthCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { Logger } from '@aws-lambda-powertools/logger';
import seedProducts from '../../ordering/seed/products.json';
import { Credentials, CredentialsSchema, SimulatorConfig, SimulatorConfigSchema, SimulatorState, parseState } from './config';
import { PlannedOrder, planDay, planHash, planHour, taipeiNow } from './generator';
import { ROASTERY_STEPS, Roastery, RoasteryStep, StepSummary, stepsForHour } from './roastery';
import { ROASTER_USERNAME, simUsername } from './tenants';

/**
 * 模擬器排程函數（ADR-030）。
 * Scheduled simulator.
 *
 * - 每一輪先讀 SSM `state`：不是 `running` 就什麼都不做（SIM-N-001；讀不到也當成 paused）。
 * - `running`：依產生器計畫，以各模擬咖啡廳身分經由 simulator client 登入，透過**公開 API** 下單（ADR-011）；
 *   每秒最多 1 個請求（SIM-N-002）；部分請求用同一個 Idempotency-Key 重送（SIM-F-008）。
 * - 預期：新單 201、重跑同一小時 200、庫存不足 409 都正常；重送必須 200 且同一個 `order_id`；其他結果算違規。
 *   有違規就在最後丟錯 → Lambda `Errors` 告警（D9）。非同步重試 0，失敗事件進 DLQ。
 * - S2d：咖啡廳下單之後，以模擬烘焙廠身分推進模擬訂單（`roastery.ts`，依台北時段）；兩段的違規分開記錄，
 *   烘焙廠出錯不會擋住下單，最後一起丟錯（同一個 `run-errors` 告警，方案 A）。
 * - 手動事件：`{ "roastery": "<步驟>" }` 不看時段、強制執行一個烘焙廠步驟（不論開關，與 probe 相同）；
 *   `{ "probe": true }` 不論開關都探測一次；`{ "dryRun": true, "date": "YYYY-MM-DD" }` 只回傳當天計畫的雜湊
 *   （SIM-F-009），不登入、不呼叫 API。
 *
 * Reads the switch first; when running, signs in as the planned cafés through the simulator client and orders through
 * the public API at ≤ 1 request/s, resending some requests with the same key. 201/200/409 are fine; a resend must
 * return 200 with the same order id; anything else is a violation and the run throws at the end (Errors alarm).
 */

const logger = new Logger({ serviceName: 'simulator-run' });
let cognito = new CognitoIdentityProviderClient({});
let ssm = new SSMClient({});
let http: typeof fetch = (...a) => fetch(...a);
let sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let clock = () => new Date();

/** 測試用 / For tests. */
export function setDepsForTesting(d: {
  cognito?: CognitoIdentityProviderClient;
  ssm?: SSMClient;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}): void {
  if (d.cognito) cognito = d.cognito;
  if (d.ssm) ssm = d.ssm;
  if (d.fetch) http = d.fetch;
  if (d.sleep) sleep = d.sleep;
  if (d.now) clock = d.now;
}

/** 請求間隔：每秒最多 1 個（Dev 路由限流 2 rps 的 50%，SIM-N-002）/ ≤ 1 request/s. */
export const PACE_MS = 1000;
export const SEED_PRODUCT_IDS: readonly string[] = (seedProducts as { id: string }[]).map((p) => p.id);

export interface RunEnv {
  readonly stateParam: string;
  readonly configParam: string;
  readonly credentialsParam: string;
  readonly userPoolId: string;
  readonly clientId: string;
  readonly apiEndpoint: string;
}

export function readEnv(env: NodeJS.ProcessEnv = process.env): RunEnv {
  const v = (k: string) => {
    const x = env[k];
    if (!x) throw new Error(`${k} is not set`);
    return x;
  };
  return {
    stateParam: v('STATE_PARAM'),
    configParam: v('CONFIG_PARAM'),
    credentialsParam: v('CREDENTIALS_PARAM'),
    userPoolId: v('USER_POOL_ID'),
    clientId: v('SIMULATOR_CLIENT_ID'),
    apiEndpoint: v('API_ENDPOINT'),
  };
}

async function param(name: string, decrypt = false): Promise<string | undefined> {
  try {
    return (await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: decrypt }))).Parameter?.Value;
  } catch (err) {
    if ((err as Error).name === 'ParameterNotFound') return undefined;
    throw err;
  }
}

export async function readState(env: RunEnv): Promise<SimulatorState> {
  try {
    return parseState(await param(env.stateParam));
  } catch (err) {
    // 讀不到開關就停（fail safe）；下一輪再試 / Unreadable switch → stop; the next run retries.
    logger.warn('state unreadable, treating as paused', { error: (err as Error).name });
    return 'paused';
  }
}

async function readConfig(env: RunEnv): Promise<SimulatorConfig> {
  // 設定格式錯誤 → 丟錯（告警），不用預設值繼續 / A bad config fails loudly instead of running on defaults.
  return SimulatorConfigSchema.parse(JSON.parse((await param(env.configParam)) ?? 'null'));
}

async function readCredentials(env: RunEnv): Promise<Credentials> {
  return CredentialsSchema.parse(JSON.parse((await param(env.credentialsParam, true)) ?? '{}'));
}

/** 登入並快取（同一輪內同一家咖啡廳只登入一次）/ Sign in, cached per run. */
class Sessions {
  private readonly tokens = new Map<string, Promise<string>>();
  constructor(
    private readonly env: RunEnv,
    private readonly creds: Credentials,
  ) {}

  token(username: string): Promise<string> {
    let t = this.tokens.get(username);
    if (!t) {
      t = this.signIn(username);
      this.tokens.set(username, t);
    }
    return t;
  }

  private async signIn(username: string): Promise<string> {
    const password = this.creds[username];
    if (!password) throw new Error('no stored password for a planned account');
    const out = await cognito.send(
      new AdminInitiateAuthCommand({
        UserPoolId: this.env.userPoolId,
        ClientId: this.env.clientId,
        AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
        AuthParameters: { USERNAME: username, PASSWORD: password },
      }),
    );
    const token = out.AuthenticationResult?.AccessToken;
    if (!token) throw new Error(`sign-in returned no access token (challenge: ${out.ChallengeName ?? 'none'})`);
    return token;
  }
}

interface ApiResponse {
  readonly status: number;
  readonly body: Record<string, unknown> | undefined;
}

async function call(env: RunEnv, path: string, token: string, init: { method?: string; key?: string; body?: unknown } = {}): Promise<ApiResponse> {
  const res = await http(new URL(path, env.apiEndpoint), {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.key ? { 'idempotency-key': init.key } : {}),
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  return { status: res.status, body: (await res.json().catch(() => undefined)) as Record<string, unknown> | undefined };
}

const claims = (token: string) =>
  JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;

export interface ProbeResult {
  readonly status: number;
  readonly products: number;
  readonly synthetic: boolean;
}

/** 探測：sim-001 登入＋讀目錄，不寫入 / Probe: sign in as sim-001 and read the catalog; writes nothing. */
async function probe(env: RunEnv, sessions: Sessions): Promise<ProbeResult & { readonly catalog: Map<string, string> }> {
  const token = await sessions.token(simUsername(1));
  const r = await call(env, '/products', token);
  const items = Array.isArray(r.body?.items) ? (r.body.items as { id: string; stock_status: string }[]) : [];
  return {
    status: r.status,
    products: r.status === 200 ? items.length : -1,
    synthetic: claims(token).synthetic === 'true',
    catalog: new Map(items.map((i) => [i.id, i.stock_status])),
  };
}

export type OrderOutcome = 'created' | 'replayed' | 'insufficient_stock' | 'key_conflict' | 'skipped_no_stock' | 'violation';

export interface HourSummary {
  readonly date: string;
  readonly hour: number;
  readonly planned: number;
  readonly outcomes: Record<OrderOutcome, number>;
  readonly duplicatesSent: number;
  readonly duplicatesOk: number;
  readonly requests: number;
  readonly violations: readonly string[];
}

/**
 * 執行一個小時的計畫。缺貨或庫存偏低的商品先拿掉（D4：避免佔滿庫存）；全部拿掉就跳過這筆。
 * Runs one hour of the plan. Lines for low or out-of-stock products are dropped first; an order with no lines left
 * is skipped.
 */
export async function simulateHour(
  env: RunEnv,
  cfg: SimulatorConfig,
  sessions: Sessions,
  catalog: Map<string, string>,
  date: string,
  hour: number,
): Promise<HourSummary> {
  const plan = planHour(cfg, date, hour, SEED_PRODUCT_IDS);
  const outcomes: Record<OrderOutcome, number> = {
    created: 0, replayed: 0, insufficient_stock: 0, key_conflict: 0, skipped_no_stock: 0, violation: 0,
  };
  const violations: string[] = [];
  let duplicatesSent = 0;
  let duplicatesOk = 0;
  let requests = 0;

  const send = async (order: PlannedOrder, items: unknown[]): Promise<ApiResponse> => {
    if (requests > 0) await sleep(PACE_MS);
    requests++;
    const token = await sessions.token(simUsername(order.tenantIndex));
    let r = await call(env, '/orders', token, { method: 'POST', key: order.idempotencyKey, body: { items } });
    if (r.status === 503) {
      // 交易衝突／節流：用同一個 key 重試一次（API 合約）/ Conflict or throttle: retry once with the same key.
      await sleep(PACE_MS);
      requests++;
      r = await call(env, '/orders', token, { method: 'POST', key: order.idempotencyKey, body: { items } });
    }
    return r;
  };

  for (const order of plan) {
    const items = order.items.filter((l) => catalog.get(l.product_id) === 'in_stock');
    if (items.length === 0) {
      outcomes.skipped_no_stock++;
      continue;
    }
    const r = await send(order, items);
    const ref = `${order.date}T${order.hour}#${order.seq}`;
    if (r.status === 201) outcomes.created++;
    else if (r.status === 200) outcomes.replayed++; // 重跑同一小時 / a re-run of the same hour
    else if (r.status === 409) outcomes.insufficient_stock++;
    else if (r.status === 422) {
      // 同一小時重跑、但期間庫存狀態變了 → 商品不同 / Re-run after stock status changed: different lines, same key.
      outcomes.key_conflict++;
      logger.warn('idempotency key reused with different lines (re-run after a stock change?)', { ref });
    } else {
      outcomes.violation++;
      violations.push(`${ref}: POST /orders → ${r.status}`);
      continue;
    }

    if (order.duplicate && (r.status === 201 || r.status === 200)) {
      duplicatesSent++;
      const d = await send(order, items);
      if (d.status === 200 && d.body?.order_id === r.body?.order_id) duplicatesOk++;
      else violations.push(`${ref}: duplicate → ${d.status} (order ${String(d.body?.order_id)} vs ${String(r.body?.order_id)})`);
    }
  }
  return { date, hour, planned: plan.length, outcomes, duplicatesSent, duplicatesOk, requests, violations };
}

export interface RunEvent {
  readonly source?: string;
  readonly roastery?: string;
  readonly probe?: boolean;
  readonly dryRun?: boolean;
  readonly date?: string;
}

export type RunOutcome =
  | { readonly outcome: 'paused' }
  | { readonly outcome: 'dry_run'; readonly date: string; readonly orders: number; readonly perHour: number[]; readonly hash: string }
  | ({ readonly outcome: 'probe_ok'; readonly state: SimulatorState } & ProbeResult)
  | ({ readonly outcome: 'simulated'; readonly roastery: readonly StepSummary[] } & HourSummary)
  | { readonly outcome: 'roastery'; readonly roastery: readonly StepSummary[] };

/** 依序執行烘焙廠步驟；每一步失敗不影響下一步（各自記錄違規）/ Run roastery steps; one step failing does not stop the next. */
export async function runRoastery(env: RunEnv, sessions: Sessions, steps: readonly RoasteryStep[], date: string): Promise<StepSummary[]> {
  const token = await sessions.token(ROASTER_USERNAME);
  if (claims(token).synthetic !== 'true') throw new Error('roaster token has no synthetic claim');
  const roastery = new Roastery((path, init) => call(env, path, token, init), sleep, date);
  const out: StepSummary[] = [];
  for (const step of steps) {
    try {
      out.push(await roastery.run(step));
    } catch (err) {
      out.push({ step, counts: {}, violations: [`${step} threw ${(err as Error).name}`] });
    }
  }
  return out;
}

export const handler = async (event: RunEvent = {}): Promise<RunOutcome> => {
  const env = readEnv();

  // 計畫重現性（SIM-F-009）：不看開關、不登入、不呼叫 API / Plan reproducibility: no switch, no sign-in, no API.
  if (event.dryRun === true) {
    const cfg = await readConfig(env);
    const date = event.date ?? taipeiNow(clock()).date;
    const plan = planDay(cfg, date, SEED_PRODUCT_IDS);
    const perHour = Array.from({ length: 12 }, (_, i) => plan.filter((o) => o.hour === i + 8).length);
    const out = { outcome: 'dry_run' as const, date, orders: plan.length, perHour, hash: planHash(plan) };
    logger.info('dry run', out);
    return out;
  }

  const state = await readState(env);
  const manualStep = event.roastery;
  if (manualStep !== undefined && !(ROASTERY_STEPS as readonly string[]).includes(manualStep)) {
    throw new Error(`unknown roastery step; use one of ${ROASTERY_STEPS.join(', ')}`);
  }
  if (state !== 'running' && event.probe !== true && manualStep === undefined) {
    logger.info('simulator paused; nothing to do', { state });
    return { outcome: 'paused' };
  }

  const cfg = await readConfig(env);
  const sessions = new Sessions(env, await readCredentials(env));
  const p = await probe(env, sessions);
  const probeResult: ProbeResult = { status: p.status, products: p.products, synthetic: p.synthetic };
  if (p.status !== 200 || p.products < 1 || !p.synthetic) {
    throw new Error(`probe failed: status ${p.status}, products ${p.products}, synthetic ${p.synthetic}`);
  }
  if (event.probe === true) {
    logger.info('probe', { state, manual: true, ...probeResult });
    return { outcome: 'probe_ok', state, ...probeResult };
  }

  const { date, hour } = taipeiNow(clock());
  if (manualStep !== undefined) {
    const roastery = await runRoastery(env, sessions, [manualStep as RoasteryStep], date);
    logger.info('roastery (manual)', { state, roastery });
    const v = roastery.flatMap((r) => r.violations);
    if (v.length > 0) throw new Error(`roastery expectations failed (${v.length}): ${v.slice(0, 5).join('; ')}`);
    return { outcome: 'roastery', roastery };
  }

  // 先下單（咖啡廳），再推進（烘焙廠）；烘焙廠出錯不影響下單 / Cafés first, then the roastery.
  const summary = await simulateHour(env, cfg, sessions, p.catalog, date, hour);
  let roastery: StepSummary[];
  try {
    roastery = await runRoastery(env, sessions, stepsForHour(hour), date);
  } catch (err) {
    roastery = [{ step: 'confirm', counts: {}, violations: [`roaster sign-in failed: ${(err as Error).name}`] }];
  }
  // 只記錄數量與參考編號，不記錄帳號或 token / Counts and references only; no accounts or tokens.
  logger.info('simulated hour', { ...summary, roastery });
  const cafe = summary.violations;
  const roast = roastery.flatMap((r) => r.violations);
  if (cafe.length + roast.length > 0) {
    throw new Error(
      `simulator expectations failed (cafe ${cafe.length}, roastery ${roast.length}): ${[...cafe, ...roast].slice(0, 5).join('; ')}`,
    );
  }
  return { outcome: 'simulated', ...summary, roastery };
};
