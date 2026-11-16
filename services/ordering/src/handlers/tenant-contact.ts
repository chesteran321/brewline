import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { SCOPES } from '../../../identity/src/scopes';
import { ContactSchema, MAX_CONTACT_BODY_BYTES } from '../lib/contact-model';
import { claim, hasScope, json, jsonBody, problem } from '../lib/http';
import { TenantIdSchema } from '../lib/order-model';
import { contactRepo, logger } from '../lib/runtime';

/**
 * GET／PUT /tenant/contact（A4c，ADR-029 D4）。租戶只來自已驗證 JWT 的 `tenant_id`，路徑上沒有租戶 ID →
 * 沒有「改網址讀別人」的可能。**日誌絕不記錄聯絡人內容**（個資）。
 * The tenant comes only from the verified JWT; there is no tenant id in the path to tamper with.
 * Contact values are never logged.
 */

type Event = APIGatewayProxyEventV2WithJWTAuthorizer;
type Result = APIGatewayProxyStructuredResultV2;

function tenantOf(event: Event): string | undefined {
  const t = TenantIdSchema.safeParse(claim(event, 'tenant_id'));
  return t.success ? t.data : undefined;
}

function failure(op: string, tenantId: string, err: unknown): Result {
  const name = (err as Error).name;
  // KMS 與 DynamoDB 的拒絕都叫 AccessDeniedException → 代表租戶隔離生效（或設定錯誤）
  // Both KMS and DynamoDB denials are AccessDeniedException: isolation kicked in (or a misconfiguration).
  logger.error(name === 'AccessDeniedException' ? 'tenant_access_denied' : `${op} failed`, { tenant_id: tenantId, error: name });
  return problem(500, 'internal_error', 'Unexpected error');
}

export const getHandler = async (event: Event): Promise<Result> => {
  if (!hasScope(event, SCOPES.profileRead)) return problem(403, 'forbidden', 'Missing required scope');
  const tenantId = tenantOf(event);
  if (!tenantId) return problem(403, 'no_tenant', 'The caller does not belong to a tenant');
  try {
    const contact = await contactRepo().get(tenantId);
    if (!contact) return problem(404, 'not_found', 'No contact on file');
    return json(200, contact);
  } catch (err) {
    return failure('get-contact', tenantId, err);
  }
};

export const putHandler = async (event: Event): Promise<Result> => {
  if (!hasScope(event, SCOPES.profileWrite)) return problem(403, 'forbidden', 'Missing required scope');
  const tenantId = tenantOf(event);
  if (!tenantId) return problem(403, 'no_tenant', 'The caller does not belong to a tenant');
  const sub = claim(event, 'sub');
  if (!sub) return problem(403, 'forbidden', 'Missing subject');
  const parsed = ContactSchema.safeParse(jsonBody(event, MAX_CONTACT_BODY_BYTES));
  if (!parsed.success) {
    // 只回欄位路徑，不回欄位值 / Return field paths only, never the submitted values.
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join('.') || '(body)'))];
    return problem(400, 'invalid_contact', 'Contact is invalid', { fields });
  }
  try {
    const saved = await contactRepo().put(tenantId, parsed.data, sub, new Date());
    logger.info('contact updated', { tenant_id: tenantId, fields: Object.keys(parsed.data) });
    return json(200, saved);
  } catch (err) {
    return failure('put-contact', tenantId, err);
  }
};
