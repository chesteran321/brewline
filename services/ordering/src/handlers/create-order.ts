import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { SCOPES } from '../../../identity/src/scopes';
import { claim, hasScope, header, json, jsonBody, problem } from '../lib/http';
import {
  CreateOrderRequestSchema,
  IdempotencyKeySchema,
  MAX_BODY_BYTES,
  MAX_LINES,
  MAX_QTY_KG,
  MIN_QTY_KG,
  TenantIdSchema,
  toPublicOrder,
} from '../lib/order-model';
import { logger, orderRepo } from '../lib/runtime';
import { ulid } from '../lib/ulid';

/**
 * POST /orders — 下單（cafe、simulator；scope brewline/orders.write）。ADR-025。
 * Create an order: idempotent, atomically reserves stock, tenant-scoped credentials.
 *
 * 201 建立｜200 同一個 Idempotency-Key 重送｜400 輸入錯誤／商品不存在｜403 沒有租戶｜
 * 409 庫存不足｜422 同一個 key 用在不同內容｜503 暫時忙碌（可重試）
 */
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyStructuredResultV2> => {
  if (!hasScope(event, SCOPES.ordersWrite)) return problem(403, 'forbidden', 'Missing required scope');
  const tenant = TenantIdSchema.safeParse(claim(event, 'tenant_id'));
  const sub = claim(event, 'sub');
  if (!tenant.success || !sub) return problem(403, 'no_tenant', 'The caller does not belong to a tenant');

  const key = IdempotencyKeySchema.safeParse(header(event, 'Idempotency-Key'));
  if (!key.success) {
    return problem(400, 'invalid_idempotency_key', 'Idempotency-Key header is required: 16-64 characters [A-Za-z0-9_-]');
  }
  const req = CreateOrderRequestSchema.safeParse(jsonBody(event, MAX_BODY_BYTES));
  if (!req.success) {
    return problem(400, 'invalid_request', 'Request body is invalid', {
      // 只回欄位路徑與規則，不回傳使用者輸入 / Paths and rules only, never the input values.
      issues: req.error.issues.slice(0, 10).map((i) => ({ path: i.path.join('.'), message: i.message })),
      limits: { max_lines: MAX_LINES, min_qty_kg: MIN_QTY_KG, max_qty_kg: MAX_QTY_KG },
    });
  }

  const log = { tenant_id: tenant.data, lines: req.data.items.length };
  try {
    const result = await orderRepo().createOrder({
      tenantId: tenant.data,
      createdBy: sub,
      idempotencyKey: key.data,
      request: req.data,
      orderId: `o_${ulid()}`,
      now: new Date(),
    });
    logger.info('create-order', { ...log, outcome: result.kind, ...('order' in result ? { order_id: result.order.order_id } : {}) });
    switch (result.kind) {
      case 'created':
        return json(201, toPublicOrder(result.order));
      case 'replayed':
        return json(200, toPublicOrder(result.order));
      case 'idempotency_mismatch':
        return problem(422, 'idempotency_key_reused', 'This Idempotency-Key was already used with a different request');
      case 'unknown_products':
        return problem(400, 'unknown_products', 'Some products do not exist or are not available', {
          product_ids: result.productIds,
        });
      case 'insufficient_stock':
        return problem(409, 'insufficient_stock', 'Not enough stock; nothing was reserved', { product_ids: result.productIds });
      case 'throttled':
      case 'busy':
        return problem(503, 'try_again', 'The service is busy; retry with the same Idempotency-Key');
    }
  } catch (err) {
    const name = (err as Error).name;
    if (name === 'AccessDeniedException') {
      // IAM 拒絕了租戶範圍以外的存取：程式有 bug，記錄為租戶隔離事件（A2 決策 D4）。
      // IAM denied access outside the tenant's scope: a bug; logged as a tenant-isolation event.
      logger.error('tenant_access_denied', { ...log, error: name });
    } else {
      logger.error('create-order failed', { ...log, error: name, message: (err as Error).message });
    }
    return problem(500, 'internal_error', 'Unexpected error');
  }
};
