import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { z } from 'zod';
import { SCOPES } from '../../../identity/src/scopes';
import { hasAnyScope, isSyntheticCaller, json, problem } from '../lib/http';
import { OrderIdSchema, TenantIdSchema, toAdminOrder } from '../lib/order-model';
import { logger, traceRepo } from '../lib/runtime';
import { LotIdSchema, RoastIdSchema, toAdminLot, toAdminRoast } from '../lib/trace-model';

/**
 * GET /admin/trace — 雙向追溯（TRC-F-006，S2a）。三種查詢，擇一：
 *   ?lot=L-2026-001                          生豆批次 → 烘焙批次
 *   ?roast=r_<26>                            烘焙批次 → 生豆批次＋訂單
 *   ?tenant=t_<26>&order=o_<26>              訂單 → 每個品項的烘焙批次 → 生豆批次（追回到農場）
 * Bidirectional trace. A synthetic caller sees synthetic batches and orders only.
 */

const Query = z.union([
  z.strictObject({ lot: LotIdSchema }),
  z.strictObject({ roast: RoastIdSchema }),
  z.strictObject({ tenant: TenantIdSchema, order: OrderIdSchema }),
]);

export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyStructuredResultV2> => {
  if (!hasAnyScope(event, [SCOPES.admin, SCOPES.roastery])) return problem(403, 'forbidden', 'Missing required scope');
  const q = Query.safeParse(event.queryStringParameters ?? {});
  if (!q.success) return problem(400, 'invalid_query', 'Use exactly one of: ?lot=L-YYYY-NNN, ?roast=r_<26>, ?tenant=t_<26>&order=o_<26>');
  const synthetic = isSyntheticCaller(event);
  const visible = (x: { synthetic?: true }) => !synthetic || x.synthetic === true;
  const repo = traceRepo();
  try {
    if ('lot' in q.data) {
      const lot = await repo.getLot(q.data.lot);
      if (!lot) return problem(404, 'not_found', 'Lot not found');
      const roasts = (await repo.roastsOfLot(lot.lot_id)).filter(visible);
      return json(200, { lot: toAdminLot(lot), roasts: roasts.map(toAdminRoast) });
    }
    if ('roast' in q.data) {
      const roast = await repo.getRoast(q.data.roast);
      if (!roast || !visible(roast)) return problem(404, 'not_found', 'Roast batch not found');
      const [lot, orders] = await Promise.all([repo.getLot(roast.lot_id), repo.ordersOfRoast(roast.roast_id)]);
      return json(200, {
        roast: toAdminRoast(roast),
        lot: lot ? toAdminLot(lot) : null,
        orders: orders.map((o) => ({ tenant_id: o.tenant_id, order_id: o.order_id, product_id: o.product_id, kg: o.kg })),
      });
    }
    const order = await repo.getOrder(q.data.tenant, q.data.order);
    if (!order || !visible(order)) return problem(404, 'not_found', 'Order not found');
    const lines = await repo.linesOfOrder(order);
    const lotIds = [...new Set(lines.flatMap((l) => l.roasts.map((r) => r.lot_id)))];
    const lots = await Promise.all(lotIds.map((id) => repo.getLot(id)));
    return json(200, {
      order: toAdminOrder(order),
      lines: lines.map((l) => ({
        product_id: l.product_id,
        qty_kg: l.qty_kg,
        allocated_kg: l.allocated_kg,
        roasts: l.roasts.map(toAdminRoast),
      })),
      lots: lots.flatMap((l) => (l ? [toAdminLot(l)] : [])),
    });
  } catch (err) {
    logger.error('trace failed', { error: (err as Error).name, message: (err as Error).message });
    return problem(500, 'internal_error', 'Unexpected error');
  }
};
