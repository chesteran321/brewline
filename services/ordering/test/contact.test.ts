import { DecryptCommand, EncryptCommand, KMSClient } from '@aws-sdk/client-kms';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { handler as getContact } from '../src/handlers/get-contact';
import { handler as putContact } from '../src/handlers/put-contact';
import { CONTACT_SK, ContactSchema } from '../src/lib/contact-model';
import { ContactRepo } from '../src/lib/contact-repo';
import { setContactRepoForTesting } from '../src/lib/runtime';

const A = `t_${'A'.repeat(26)}`;
const KEY = 'arn:aws:kms:ap-east-2:610935435571:key/test';
const NOW = new Date('2026-11-16T04:00:00.000Z');
const contact = { name: 'Lin Mei', email: 'mei@example.com', phone: '+886912345678', address: '台北市信義區\n1 號' };

describe('ContactSchema', () => {
  test('normalizes email to lower case and trims', () => {
    expect(ContactSchema.parse({ name: ' Lin ', email: ' Mei@Example.COM ' })).toEqual({ name: 'Lin', email: 'mei@example.com' });
  });
  // 反向 / Negative
  test.each<[Record<string, unknown>, string]>([
    [{ email: 'a@example.com' }, 'name required'],
    [{ name: 'x' }, 'email required'],
    [{ name: 'x', email: 'not-an-email' }, 'bad email'],
    [{ name: 'x', email: 'a@example.com', phone: '0912345678' }, 'phone not E.164'],
    [{ name: 'x', email: 'a@example.com', phone: '+1234' }, 'phone too short'],
    [{ name: 'x\u0007', email: 'a@example.com' }, 'control char in name'],
    [{ name: 'x\ny', email: 'a@example.com' }, 'newline in name'],
    [{ name: 'x'.repeat(101), email: 'a@example.com' }, 'name too long'],
    [{ name: 'x', email: 'a@example.com', address: 'a'.repeat(501) }, 'address too long'],
    [{ name: 'x', email: 'a@example.com', tenant_id: A }, 'unknown field (tenant_id)'],
  ])('%j is rejected (%s)', (body) => {
    expect(ContactSchema.safeParse(body).success).toBe(false);
  });
});

describe('ContactRepo', () => {
  const ddb = mockClient(DynamoDBDocumentClient);
  const kms = mockClient(KMSClient);
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-east-2' }));
  const kmsClient = new KMSClient({ region: 'ap-east-2' });
  const tenants: string[] = [];
  const repo = new ContactRepo((t) => (tenants.push(t), doc), (t) => (tenants.push(t), kmsClient), 'tbl', KEY);

  beforeEach(() => {
    ddb.reset();
    kms.reset();
    tenants.length = 0;
    // 假 KMS：密文 = "ct:" + context JSON + plaintext；解密時檢查 context 一致
    // Fake KMS: ciphertext embeds the context; decrypt verifies it matches.
    kms.on(EncryptCommand).callsFake((i) =>
      ({ CiphertextBlob: Buffer.from(`ct:${JSON.stringify(i.EncryptionContext)}:${Buffer.from(i.Plaintext).toString('utf8')}`) }));
    kms.on(DecryptCommand).callsFake((i) => {
      const s = Buffer.from(i.CiphertextBlob).toString('utf8');
      const prefix = `ct:${JSON.stringify(i.EncryptionContext)}:`;
      if (!s.startsWith(prefix)) throw Object.assign(new Error('bad context'), { name: 'InvalidCiphertextException' });
      return { Plaintext: Buffer.from(s.slice(prefix.length)) };
    });
  });

  test('put encrypts every field with {tenant_id, field} and stores no plaintext', async () => {
    ddb.on(PutCommand).resolves({});
    const saved = await repo.put(A, contact, 'sub-1', NOW);
    expect(saved).toEqual({ ...contact, updated_at: NOW.toISOString() });

    const encs = kms.commandCalls(EncryptCommand).map((c) => c.args[0].input);
    expect(encs.map((e) => e.EncryptionContext)).toEqual(
      expect.arrayContaining(['name', 'email', 'phone', 'address'].map((field) => ({ tenant_id: A, field }))),
    );
    expect(encs.every((e) => e.KeyId === KEY)).toBe(true);

    const item = ddb.commandCalls(PutCommand)[0]!.args[0].input.Item!;
    expect(item).toMatchObject({ pk: `TENANT#${A}`, sk: CONTACT_SK, entity: 'Contact', updated_by: 'sub-1' });
    expect(Object.keys(item.enc).sort()).toEqual(['address', 'email', 'name', 'phone']);
    // 項目的頂層沒有任何明文欄位 / No plaintext attribute at the top level.
    for (const f of ['name', 'email', 'phone', 'address']) expect(item).not.toHaveProperty(f);
    expect(tenants.every((t) => t === A)).toBe(true);
  });

  test('optional fields are omitted, not stored empty', async () => {
    ddb.on(PutCommand).resolves({});
    await repo.put(A, { name: 'x', email: 'a@example.com' }, 'sub-1', NOW);
    expect(Object.keys(ddb.commandCalls(PutCommand)[0]!.args[0].input.Item!.enc).sort()).toEqual(['email', 'name']);
    expect(kms.commandCalls(EncryptCommand)).toHaveLength(2);
  });

  test('get round-trips through decrypt with the same context', async () => {
    ddb.on(PutCommand).resolves({});
    await repo.put(A, contact, 'sub-1', NOW);
    const stored = ddb.commandCalls(PutCommand)[0]!.args[0].input.Item!;
    ddb.on(GetCommand).resolves({ Item: stored });
    expect(await repo.get(A)).toEqual({ ...contact, updated_at: NOW.toISOString() });
    expect(ddb.commandCalls(GetCommand)[0]!.args[0].input).toMatchObject({ Key: { pk: `TENANT#${A}`, sk: CONTACT_SK }, ConsistentRead: true });
    expect(kms.commandCalls(DecryptCommand).every((c) => c.args[0].input.KeyId === KEY)).toBe(true);
  });

  test('get returns undefined when there is no contact', async () => {
    ddb.on(GetCommand).resolves({});
    expect(await repo.get(A)).toBeUndefined();
  });

  // 反向：把租戶 B 的密文搬到 A 的項目 → context 不符 → 解密失敗
  // Negative: ciphertext copied from tenant B fails because the context does not match.
  test("another tenant's ciphertext does not decrypt", async () => {
    const B = `t_${'B'.repeat(26)}`;
    const foreign = (field: string, v: string) =>
      Buffer.from(`ct:${JSON.stringify({ tenant_id: B, field })}:${v}`).toString('base64');
    ddb.on(GetCommand).resolves({
      Item: { pk: `TENANT#${A}`, sk: CONTACT_SK, entity: 'Contact', enc: { name: foreign('name', 'x'), email: foreign('email', 'b@example.com') }, updated_at: 'x', updated_by: 'y' },
    });
    await expect(repo.get(A)).rejects.toMatchObject({ name: 'InvalidCiphertextException' });
  });
});

describe('GET/PUT /tenant/contact handlers', () => {
  let stored: { tenant: string; contact: unknown; by: string } | undefined;
  let fail: Error | undefined;
  const fake = {
    get: async (t: string) => {
      if (fail) throw fail;
      return t === A && stored ? { ...(stored.contact as object), updated_at: NOW.toISOString() } : undefined;
    },
    put: async (t: string, c: unknown, by: string) => {
      if (fail) throw fail;
      stored = { tenant: t, contact: c, by };
      return { ...(c as object), updated_at: NOW.toISOString() };
    },
  } as unknown as ContactRepo;

  const event = (o: { scopes?: string[]; tenant?: string | null; body?: unknown } = {}) => {
    const scopes = o.scopes ?? ['brewline/profile.read', 'brewline/profile.write'];
    const claims: Record<string, string> = { sub: 'sub-1', scope: scopes.join(' ') };
    if (o.tenant !== null) claims.tenant_id = o.tenant ?? A;
    return {
      headers: {},
      body: o.body === undefined ? undefined : typeof o.body === 'string' ? o.body : JSON.stringify(o.body),
      isBase64Encoded: false,
      requestContext: { authorizer: { jwt: { claims, scopes } } },
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
  };
  const parse = (r: { body?: string }) => JSON.parse(r.body ?? '{}');

  beforeAll(() => setContactRepoForTesting(fake));
  afterAll(() => setContactRepoForTesting(undefined));
  beforeEach(() => {
    stored = undefined;
    fail = undefined;
  });

  test('GET before any PUT → 404', async () => {
    expect((await getContact(event())).statusCode).toBe(404);
  });

  test('PUT → 200, tenant and sub from the JWT; then GET returns it', async () => {
    const r = await putContact(event({ body: contact }));
    expect(r.statusCode).toBe(200);
    expect(stored).toMatchObject({ tenant: A, by: 'sub-1' });
    const g = await getContact(event());
    expect(g.statusCode).toBe(200);
    expect(parse(g)).toMatchObject({ email: 'mei@example.com', updated_at: NOW.toISOString() });
  });

  // 反向 / Negative
  test.each([
    ['GET without profile.read', () => getContact(event({ scopes: ['brewline/orders.read'] })), 403],
    ['PUT without profile.write', () => putContact(event({ scopes: ['brewline/profile.read'], body: contact })), 403],
    ['GET without tenant_id', () => getContact(event({ tenant: null })), 403],
    ['PUT with malformed tenant_id', () => putContact(event({ tenant: 'acme', body: contact })), 403],
    ['PUT with invalid JSON', () => putContact(event({ body: '{nope' })), 400],
    ['PUT with oversized body', () => putContact(event({ body: { ...contact, address: 'a'.repeat(5000) } })), 400],
  ])('%s → %i', async (_n, call, status) => {
    expect((await call()).statusCode).toBe(status);
  });

  test('400 lists field paths but never echoes the submitted values', async () => {
    const r = await putContact(event({ body: { name: 'x', email: 'secret-value-not-an-email' } }));
    expect(r.statusCode).toBe(400);
    expect(parse(r).error.fields).toEqual(['email']);
    expect(r.body).not.toContain('secret-value');
  });

  test('a tenant_id in the body is rejected (cannot write for another tenant)', async () => {
    const r = await putContact(event({ body: { ...contact, tenant_id: `t_${'B'.repeat(26)}` } }));
    expect(r.statusCode).toBe(400);
    expect(stored).toBeUndefined();
  });

  test('KMS/DynamoDB AccessDenied → 500 without details', async () => {
    fail = Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
    const r = await getContact(event());
    expect(r.statusCode).toBe(500);
    expect(r.body).not.toContain('denied');
  });
});
