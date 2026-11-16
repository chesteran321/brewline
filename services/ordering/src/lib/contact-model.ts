import { z } from 'zod';

/**
 * 租戶聯絡人（A4c，ADR-029 D2／D4）。每租戶一位：`TENANT#<t>` / `CONTACT#primary`。
 * Tenant contact: one per tenant.
 *
 * 個資欄位（name、email、phone、address）**各自**用 KMS 加密，encryption context = `{tenant_id, field}`，
 * DynamoDB 裡只有密文。租戶角色只能在 context 的 tenant_id 等於自己的 session tag 時加解密。
 * Each PII field is encrypted separately with KMS (context `{tenant_id, field}`); DynamoDB stores ciphertext only.
 */

export const CONTACT_SK = 'CONTACT#primary';
export const CONTACT_ENTITY = 'Contact';
export const MAX_CONTACT_BODY_BYTES = 4 * 1024;

/** 加密的欄位（順序固定）/ Encrypted fields, in a fixed order. */
export const CONTACT_FIELDS = ['name', 'email', 'phone', 'address'] as const;
export type ContactField = (typeof CONTACT_FIELDS)[number];

/** 去掉控制字元（換行除外，地址可以多行）/ Reject control characters (newlines allowed in addresses). */
const noControl = (allowNewline: boolean) =>
  allowNewline ? /^[^\u0000-\u0009\u000B-\u001F\u007F]*$/ : /^[^\u0000-\u001F\u007F]*$/;

export const ContactSchema = z.strictObject({
  name: z.string().trim().min(1).max(100).regex(noControl(false)),
  email: z.string().trim().max(254).pipe(z.email()).transform((e) => e.toLowerCase()),
  // E.164：+ 國碼 + 號碼，共 8–15 位數字 / E.164: "+" then 8–15 digits.
  phone: z.string().regex(/^\+[1-9]\d{7,14}$/).optional(),
  address: z.string().trim().min(1).max(500).regex(noControl(true)).optional(),
});
export type Contact = z.infer<typeof ContactSchema>;

/** DynamoDB 項目：只有密文（base64）與中繼資料 / Stored item: ciphertext (base64) and metadata only. */
export const ContactItemSchema = z.object({
  pk: z.string(),
  sk: z.literal(CONTACT_SK),
  entity: z.literal(CONTACT_ENTITY),
  enc: z.partialRecord(z.enum(CONTACT_FIELDS), z.string().min(1)),
  updated_at: z.string(),
  updated_by: z.string(),
});
export type ContactItem = z.infer<typeof ContactItemSchema>;

/** 公開回應 / Public response. */
export interface PublicContact extends Contact {
  readonly updated_at: string;
}

/** encryption context：KMS 會把它綁進密文，解密時必須完全相同 / Bound into the ciphertext; must match on decrypt. */
export const encryptionContext = (tenantId: string, field: ContactField): Record<string, string> => ({
  tenant_id: tenantId,
  field,
});
