import { AdminInitiateAuthCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { Logger } from '@aws-lambda-powertools/logger';
import { CredentialsSchema, SimulatorConfigSchema, SimulatorState, parseState } from './config';
import { simUsername } from './tenants';

/**
 * 模擬器排程函數（ADR-030）。S1b：只有開關與探測；S1c 才產生訂單。
 * Scheduled simulator. S1b: kill switch and a probe only; order generation arrives in S1c.
 *
 * - 每一輪先讀 SSM `state`：不是 `running` 就什麼都不做（SIM-N-001；讀不到也當成 paused）。
 * - `running`：用第一個模擬帳號經由 simulator client 登入，呼叫 `GET /products`（不寫入任何資料）。
 * - 手動呼叫帶 `{ "probe": true }`：不論開關都做一次探測（Prod 開啟前驗證登入路徑）。
 * - 預期沒達成就丟錯 → Lambda `Errors` 告警（D9）；非同步重試為 0，失敗事件進 DLQ。
 *
 * Reads the state first and does nothing unless it is "running" (unreadable counts as paused). When running,
 * signs in as the first simulated café through the simulator client and calls GET /products (writes nothing).
 * A manual `{ "probe": true }` probes regardless of the state. Unmet expectations throw → Errors alarm.
 */

const logger = new Logger({ serviceName: 'simulator-run' });
let cognito = new CognitoIdentityProviderClient({});
let ssm = new SSMClient({});
let http: typeof fetch = (...a) => fetch(...a);

/** 測試用 / For tests. */
export function setDepsForTesting(d: { cognito?: CognitoIdentityProviderClient; ssm?: SSMClient; fetch?: typeof fetch }): void {
  if (d.cognito) cognito = d.cognito;
  if (d.ssm) ssm = d.ssm;
  if (d.fetch) http = d.fetch;
}

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
    // 讀不到開關就停（fail safe）；記錄後由下一輪再試 / Unreadable switch → stop; the next run retries.
    logger.warn('state unreadable, treating as paused', { error: (err as Error).name });
    return 'paused';
  }
}

export async function signIn(env: RunEnv, username: string): Promise<string> {
  const raw = await param(env.credentialsParam, true);
  const creds = CredentialsSchema.parse(JSON.parse(raw ?? '{}'));
  const password = creds[username];
  if (!password) throw new Error('no stored password for the probe account');
  const out = await cognito.send(
    new AdminInitiateAuthCommand({
      UserPoolId: env.userPoolId,
      ClientId: env.clientId,
      AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
      AuthParameters: { USERNAME: username, PASSWORD: password },
    }),
  );
  const token = out.AuthenticationResult?.AccessToken;
  if (!token) throw new Error(`sign-in returned no access token (challenge: ${out.ChallengeName ?? 'none'})`);
  return token;
}

export interface ProbeResult {
  readonly status: number;
  readonly products: number;
  readonly synthetic: boolean;
}

/** 探測：登入＋讀目錄，不寫入 / Probe: sign in and read the catalog; writes nothing. */
export async function probe(env: RunEnv): Promise<ProbeResult> {
  const token = await signIn(env, simUsername(1));
  const claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
  const res = await http(new URL('/products', env.apiEndpoint), {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json().catch(() => undefined)) as { items?: unknown[] } | undefined;
  return { status: res.status, products: Array.isArray(body?.items) ? body.items.length : -1, synthetic: claims.synthetic === 'true' };
}

export interface RunEvent {
  readonly probe?: boolean;
}

export type RunOutcome = { readonly outcome: 'paused' } | ({ readonly outcome: 'probe_ok'; readonly state: SimulatorState } & ProbeResult);

export const handler = async (event: RunEvent = {}): Promise<RunOutcome> => {
  const env = readEnv();
  const state = await readState(env);
  if (state !== 'running' && event.probe !== true) {
    logger.info('simulator paused; nothing to do', { state });
    return { outcome: 'paused' };
  }
  // 設定格式錯誤 → 丟錯（告警），而不是用預設值繼續 / A bad config fails loudly instead of running on defaults.
  SimulatorConfigSchema.parse(JSON.parse((await param(env.configParam)) ?? 'null'));
  const r = await probe(env);
  logger.info('probe', { state, manual: event.probe === true, ...r });
  if (r.status !== 200 || r.products < 1 || !r.synthetic) {
    throw new Error(`probe failed: status ${r.status}, products ${r.products}, synthetic ${r.synthetic}`);
  }
  return { outcome: 'probe_ok', state, ...r };
};
