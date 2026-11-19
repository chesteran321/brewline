import { randomBytes } from 'node:crypto';
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { DeleteParameterCommand, GetParameterCommand, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { Logger } from '@aws-lambda-powertools/logger';
import type { CloudFormationCustomResourceEvent } from 'aws-lambda';
import { Credentials, CredentialsSchema } from './config';
import { ROASTER_GROUP, ROASTER_USERNAME, SimUser, simUsers } from './tenants';

/**
 * 模擬咖啡廳帳號的 custom resource（ADR-030 D3）。只在部署時執行；執行中的模擬器沒有建立帳號的權限。
 * Custom resource that provisions the simulated café accounts. Runs at deploy time only; the scheduled
 * simulator itself cannot create users.
 *
 * - 帳號：`sim-NNN@example.com`，群組 `simulator`，`custom:tenant_id` 由種子決定（同一種子 → 同一批租戶）
 * - 密碼：每個帳號隨機一組，存進 SecureString（資料層 CMK）；**不寫日誌、不回傳給 CloudFormation**
 * - 已存在的帳號不重設密碼；只有新帳號或密碼參數裡缺少的帳號才設定
 * - `state` 參數只在不存在時建立為 `paused`（之後由人切換，部署不覆蓋）
 * - 帳號的 tenant_id 與種子不符 → 失敗（避免模擬器以錯的租戶下單）
 * - S2d：另建模擬烘焙廠 `sim-roaster@example.com`（群組 `simulator-roastery`，**不能有** tenant_id）
 *
 * Accounts get random passwords stored in a CMK-encrypted SecureString (never logged or returned to CloudFormation).
 * Existing accounts keep their passwords; the state parameter is created once as "paused" and never overwritten.
 */

const logger = new Logger({ serviceName: 'simulator-provision' });
let cognito = new CognitoIdentityProviderClient({});
let ssm = new SSMClient({});

/** 測試用 / For tests. */
export function setClientsForTesting(c: CognitoIdentityProviderClient, s: SSMClient): void {
  cognito = c;
  ssm = s;
}

export const SIMULATOR_GROUP = 'simulator';
export const INITIAL_STATE = 'paused';

export interface ProvisionProps {
  readonly userPoolId: string;
  readonly poolSize: number;
  readonly seed: string;
  readonly credentialsParam: string;
  readonly stateParam: string;
  readonly kmsKeyId: string;
  readonly retainOnDelete: boolean;
}

export function parseProps(raw: Record<string, unknown>): ProvisionProps {
  const str = (k: string) => {
    const v = raw[k];
    if (typeof v !== 'string' || v === '') throw new Error(`missing property ${k}`);
    return v;
  };
  return {
    userPoolId: str('UserPoolId'),
    poolSize: Number(str('PoolSize')),
    seed: str('Seed'),
    credentialsParam: str('CredentialsParam'),
    stateParam: str('StateParam'),
    kmsKeyId: str('KmsKeyId'),
    retainOnDelete: str('RetainOnDelete') === 'true',
  };
}

const randomPassword = () => `${randomBytes(24).toString('base64url')}Aa1!`;
const isName = (err: unknown, name: string) => (err as Error)?.name === name;

async function readCredentials(name: string): Promise<Credentials> {
  try {
    const out = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
    const parsed = CredentialsSchema.safeParse(JSON.parse(out.Parameter?.Value ?? '{}'));
    // 內容損壞 → 當成空的，全部重設密碼（只影響模擬帳號）/ Corrupt → start over (simulator accounts only).
    return parsed.success ? parsed.data : {};
  } catch (err) {
    if (isName(err, 'ParameterNotFound')) return {};
    throw err;
  }
}

/** 帳號存在就回傳它的 tenant_id；不存在回 undefined / Returns the account's tenant id, or undefined if absent. */
async function existingTenant(poolId: string, username: string): Promise<string | undefined> {
  try {
    const out = await cognito.send(new AdminGetUserCommand({ UserPoolId: poolId, Username: username }));
    return out.UserAttributes?.find((a) => a.Name === 'custom:tenant_id')?.Value ?? '';
  } catch (err) {
    if (isName(err, 'UserNotFoundException')) return undefined;
    throw err;
  }
}

/** 要建立的帳號：40 家咖啡廳（有租戶）＋ 1 個烘焙廠（tenantId 空字串＝沒有租戶）/ Cafés plus the roaster. */
interface Account {
  readonly username: string;
  readonly tenantId: string;
  readonly group: string;
}

export function accounts(seed: string, poolSize: number): Account[] {
  return [
    ...simUsers(seed, poolSize).map((u: SimUser) => ({ username: u.username, tenantId: u.tenantId, group: SIMULATOR_GROUP })),
    { username: ROASTER_USERNAME, tenantId: '', group: ROASTER_GROUP },
  ];
}

async function createUser(poolId: string, u: Account): Promise<void> {
  await cognito.send(
    new AdminCreateUserCommand({
      UserPoolId: poolId,
      Username: u.username,
      MessageAction: 'SUPPRESS', // 不寄邀請信 / no invitation e-mail
      UserAttributes: [
        { Name: 'email', Value: u.username },
        { Name: 'email_verified', Value: 'true' },
        ...(u.tenantId ? [{ Name: 'custom:tenant_id', Value: u.tenantId }] : []),
      ],
    }),
  );
  await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: poolId, Username: u.username, GroupName: u.group }));
}

export interface ProvisionResult {
  /** 咖啡廳帳號數（不含烘焙廠；CloudFormation 輸出 AccountCount）/ Café accounts, excluding the roaster. */
  readonly users: number;
  readonly roasters: number;
  readonly created: number;
  readonly passwordsSet: number;
  readonly stateCreated: boolean;
}

export async function provision(p: ProvisionProps): Promise<ProvisionResult> {
  const users = accounts(p.seed, p.poolSize);
  const creds = await readCredentials(p.credentialsParam);
  const next: Credentials = {};
  let created = 0;
  let passwordsSet = 0;

  for (const u of users) {
    const tenant = await existingTenant(p.userPoolId, u.username);
    if (tenant === undefined) {
      await createUser(p.userPoolId, u);
      created++;
    } else if (tenant !== u.tenantId) {
      // 不自動修正：tenant_id 決定資料歸屬，改錯會讓訂單掛到別的租戶 / Never auto-fix: it decides data ownership.
      throw new Error(`${u.username} has an unexpected tenant_id; check the seed or fix the account manually`);
    }
    const known = creds[u.username];
    if (tenant === undefined || !known) {
      const password = randomPassword();
      await cognito.send(
        new AdminSetUserPasswordCommand({ UserPoolId: p.userPoolId, Username: u.username, Password: password, Permanent: true }),
      );
      next[u.username] = password;
      passwordsSet++;
    } else {
      next[u.username] = known;
    }
  }

  // 只保留目前池子裡的帳號（縮小 poolSize 時移除多的）/ Keep only accounts in the current pool.
  const changed = passwordsSet > 0 || Object.keys(creds).length !== users.length;
  if (changed) {
    await ssm.send(
      new PutParameterCommand({
        Name: p.credentialsParam,
        Value: JSON.stringify(next),
        Type: 'SecureString',
        KeyId: p.kmsKeyId,
        Tier: 'Standard',
        Overwrite: true,
        Description: 'BrewLine simulator account passwords (ADR-030 D2/D3). Do not read manually.',
      }),
    );
  }

  let stateCreated = false;
  try {
    await ssm.send(
      new PutParameterCommand({
        Name: p.stateParam,
        Value: INITIAL_STATE,
        Type: 'String',
        Tier: 'Standard',
        Overwrite: false, // 已存在就不動（D7）/ Leave an existing value alone.
        Description: 'BrewLine simulator kill switch: paused | running (ADR-030 D7). Deploys never overwrite it.',
      }),
    );
    stateCreated = true;
  } catch (err) {
    if (!isName(err, 'ParameterAlreadyExists')) throw err;
  }

  const roasters = users.filter((u) => u.group === ROASTER_GROUP).length;
  return { users: users.length - roasters, roasters, created, passwordsSet, stateCreated };
}

export async function deprovision(p: ProvisionProps): Promise<number> {
  if (p.retainOnDelete) return 0;
  let deleted = 0;
  for (const u of accounts(p.seed, p.poolSize)) {
    try {
      await cognito.send(new AdminDeleteUserCommand({ UserPoolId: p.userPoolId, Username: u.username }));
      deleted++;
    } catch (err) {
      if (!isName(err, 'UserNotFoundException')) throw err;
    }
  }
  for (const name of [p.credentialsParam, p.stateParam]) {
    await ssm.send(new DeleteParameterCommand({ Name: name })).catch((err: unknown) => {
      if (!isName(err, 'ParameterNotFound')) throw err;
    });
  }
  return deleted;
}

export const handler = async (event: CloudFormationCustomResourceEvent) => {
  const physicalResourceId = 'brewline-simulator-accounts';
  const p = parseProps(event.ResourceProperties as Record<string, unknown>);
  if (event.RequestType === 'Delete') {
    const deleted = await deprovision(p);
    logger.info('simulator accounts removed', { deleted, retained: p.retainOnDelete });
    return { PhysicalResourceId: physicalResourceId };
  }
  const r = await provision(p);
  // 只記錄數量，不記錄帳號或密碼 / Counts only; never usernames or passwords.
  logger.info('simulator accounts provisioned', { ...r });
  return {
    PhysicalResourceId: physicalResourceId,
    Data: { Users: String(r.users), Roasters: String(r.roasters), Created: String(r.created), PasswordsSet: String(r.passwordsSet) },
  };
};
