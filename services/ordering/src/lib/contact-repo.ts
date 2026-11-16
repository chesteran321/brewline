import { DecryptCommand, EncryptCommand, KMSClient } from '@aws-sdk/client-kms';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import {
  CONTACT_ENTITY,
  CONTACT_FIELDS,
  CONTACT_SK,
  Contact,
  ContactField,
  ContactItem,
  ContactItemSchema,
  PublicContact,
  encryptionContext,
} from './contact-model';
import { tenantPk } from './order-model';

/**
 * 聯絡人讀寫（A4c）。DynamoDB 與 KMS 都用**租戶範圍的憑證**（ADR-024）：
 * IAM 讓憑證只碰得到 TENANT#<自己>，也只能用 tenant_id = 自己 的 encryption context。
 * Contact reads/writes. Both DynamoDB and KMS use tenant-scoped credentials, so IAM limits them to TENANT#<own>
 * and to encryption contexts whose tenant_id is the caller's own.
 */
export class ContactRepo {
  constructor(
    private readonly docFor: (tenantId: string) => DynamoDBDocumentClient,
    private readonly kmsFor: (tenantId: string) => Pick<KMSClient, 'send'>,
    private readonly tableName: string,
    private readonly keyArn: string,
  ) {}

  async get(tenantId: string): Promise<PublicContact | undefined> {
    const out = await this.docFor(tenantId).send(
      new GetCommand({ TableName: this.tableName, Key: { pk: tenantPk(tenantId), sk: CONTACT_SK }, ConsistentRead: true }),
    );
    if (!out.Item) return undefined;
    const item = ContactItemSchema.parse(out.Item);
    const kms = this.kmsFor(tenantId);
    const plain: Partial<Record<ContactField, string>> = {};
    // 每個欄位一次 Decrypt（最多 4 次，作品集規模的請求費用約 0）/ One Decrypt per field (≤ 4).
    await Promise.all(
      CONTACT_FIELDS.map(async (field) => {
        const b64 = item.enc[field];
        if (b64) plain[field] = await this.decrypt(kms, tenantId, field, b64);
      }),
    );
    if (!plain.name || !plain.email) throw new Error('Contact item is missing required fields');
    return {
      name: plain.name,
      email: plain.email,
      ...(plain.phone ? { phone: plain.phone } : {}),
      ...(plain.address ? { address: plain.address } : {}),
      updated_at: item.updated_at,
    };
  }

  /** 整筆取代（PUT 語意）/ Full replacement (PUT semantics). */
  async put(tenantId: string, contact: Contact, updatedBy: string, now: Date): Promise<PublicContact> {
    const kms = this.kmsFor(tenantId);
    const enc: Partial<Record<ContactField, string>> = {};
    await Promise.all(
      CONTACT_FIELDS.map(async (field) => {
        const value = contact[field];
        if (value !== undefined) enc[field] = await this.encrypt(kms, tenantId, field, value);
      }),
    );
    const item: ContactItem = {
      pk: tenantPk(tenantId),
      sk: CONTACT_SK,
      entity: CONTACT_ENTITY,
      enc,
      updated_at: now.toISOString(),
      updated_by: updatedBy,
    };
    await this.docFor(tenantId).send(new PutCommand({ TableName: this.tableName, Item: item }));
    return { ...contact, updated_at: item.updated_at };
  }

  private async encrypt(kms: Pick<KMSClient, 'send'>, tenantId: string, field: ContactField, value: string): Promise<string> {
    const out = await kms.send(
      new EncryptCommand({
        KeyId: this.keyArn,
        Plaintext: Buffer.from(value, 'utf8'),
        EncryptionContext: encryptionContext(tenantId, field),
      }),
    );
    if (!out.CiphertextBlob) throw new Error('KMS returned no ciphertext');
    return Buffer.from(out.CiphertextBlob).toString('base64');
  }

  private async decrypt(kms: Pick<KMSClient, 'send'>, tenantId: string, field: ContactField, b64: string): Promise<string> {
    const out = await kms.send(
      new DecryptCommand({
        // 指定 KeyId：密文就算被換成別把金鑰加密的，也不會被解開 / Pin the key so foreign ciphertext is rejected.
        KeyId: this.keyArn,
        CiphertextBlob: Buffer.from(b64, 'base64'),
        EncryptionContext: encryptionContext(tenantId, field),
      }),
    );
    if (!out.Plaintext) throw new Error('KMS returned no plaintext');
    return Buffer.from(out.Plaintext).toString('utf8');
  }
}
