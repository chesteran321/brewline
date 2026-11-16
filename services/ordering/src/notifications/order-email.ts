import { z } from 'zod';
import { TENANT_ID_PATTERN } from '../../../identity/src/scopes';

/**
 * 訂單通知信的內容（A4d，ADR-029 D5）。純函數，方便單元測試。
 * Order e-mail content. Pure, for unit testing.
 *
 * 只寄 4 種：建立、確認、出貨、取消。信中只有訂單資訊與收件人姓名，**不放**其他租戶資料或內部欄位。
 * Only four kinds: created, confirmed, shipped, cancelled. The body carries order facts and the recipient's name only.
 */

export const NOTIFY_KINDS = ['created', 'confirmed', 'shipped', 'cancelled', 'replenish_failed'] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];

const STATUS_KIND: Record<string, Exclude<NotifyKind, 'replenish_failed'>> = { CONFIRMED: 'confirmed', SHIPPED: 'shipped', CANCELLED: 'cancelled' };

/** EventBridge detail（A3b 的白名單欄位）/ The allow-listed detail published by the stream publisher. */
export const OrderEventDetailSchema = z.object({
  event_id: z.string().min(1).max(128),
  occurred_at: z.string(),
  tenant_id: z.string().regex(TENANT_ID_PATTERN),
  order_id: z.string().regex(/^o_[0-9A-HJKMNP-TV-Z]{26}$/),
  status: z.string(),
  previous_status: z.string().optional(),
  total: z.number().optional(),
  currency: z.string().optional(),
  items: z.array(z.object({ product_id: z.string(), qty_kg: z.number() })).default([]),
});
export type OrderEventDetail = z.infer<typeof OrderEventDetailSchema>;

/** 依事件決定要寄哪一種信；不需要寄 → undefined / Which e-mail (if any) an event triggers. */
export function kindOf(detailType: string, detail: Pick<OrderEventDetail, 'status'>): Exclude<NotifyKind, 'replenish_failed'> | undefined {
  if (detailType === 'OrderCreated') return 'created';
  if (detailType === 'OrderStatusChanged') return STATUS_KIND[detail.status];
  return undefined;
}

/** 定期補貨失敗（A4e，ADR-029 D6）/ A replenishment that could not be placed. */
export const ReplenishmentFailedDetailSchema = z.object({
  event_id: z.string().min(1).max(128),
  occurred_at: z.string(),
  tenant_id: z.string().regex(TENANT_ID_PATTERN),
  replenishment_id: z.string().regex(/^r_[0-9A-HJKMNP-TV-Z]{26}$/),
  scheduled_date: z.string(),
  reason: z.enum(['insufficient_stock', 'unknown_products']),
  product_ids: z.array(z.string()).max(25).default([]),
});
export type ReplenishmentFailedDetail = z.infer<typeof ReplenishmentFailedDetailSchema>;

export function buildReplenishFailedEmail(detail: ReplenishmentFailedDetail, recipientName: string, envName: string): EmailContent {
  const tag = envName === 'prod' ? '[BrewLine Demo]' : `[BrewLine Demo ${envName}]`;
  const why =
    detail.reason === 'insufficient_stock'
      ? ['庫存不足，這次沒有建立訂單，也沒有預留任何庫存。', 'Not enough stock: no order was placed and nothing was reserved.']
      : ['部分商品已下架，這次沒有建立訂單。', 'Some products are no longer available: no order was placed.'];
  const text = [
    `${recipientName} 您好 / Hello ${recipientName},`,
    '',
    `您的定期補貨 ${detail.replenishment_id}（${detail.scheduled_date}）未能下單。`,
    `Your recurring replenishment ${detail.replenishment_id} (${detail.scheduled_date}) could not be placed.`,
    '',
    ...why,
    ...(detail.product_ids.length ? ['', '商品 Products:', ...detail.product_ids.map((p) => `  - ${p}`)] : []),
    '',
    '系統不會自動重試；下一次排定時間會照常執行，您也可以手動下單。',
    'It will not be retried; the next scheduled run proceeds as usual, or you can order manually.',
    '',
    '—',
    'BrewLine 是 AWS Solutions Architect 作品集的示範系統，非真實交易。',
    'BrewLine is a demo system for an AWS Solutions Architect portfolio; no real transaction took place.',
  ].join('\n');
  return { subject: `${tag} 定期補貨未下單 / Replenishment not placed: ${detail.replenishment_id}`, text };
}

const LABEL: Record<Exclude<NotifyKind, 'replenish_failed'>, { zh: string; en: string }> = {
  created: { zh: '已建立', en: 'received' },
  confirmed: { zh: '已確認', en: 'confirmed' },
  shipped: { zh: '已出貨', en: 'shipped' },
  cancelled: { zh: '已取消', en: 'cancelled' },
};

/** RFC 2606／6761 保留網域：測試資料，不寄 / Reserved test domains are never mailed. */
export function isReservedRecipient(email: string): boolean {
  const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
  return /(^|\.)example\.(com|net|org)$/.test(domain) || /\.(test|example|invalid|localhost)$/.test(domain) || domain === 'example';
}

export interface EmailContent {
  readonly subject: string;
  readonly text: string;
}

export function buildEmail(kind: Exclude<NotifyKind, 'replenish_failed'>, detail: OrderEventDetail, recipientName: string, envName: string): EmailContent {
  const label = LABEL[kind];
  const tag = envName === 'prod' ? '[BrewLine Demo]' : `[BrewLine Demo ${envName}]`;
  const lines = detail.items.map((i) => `  - ${i.product_id} × ${i.qty_kg} kg`);
  const total =
    kind === 'created' && detail.total !== undefined ? [`金額 Total: ${detail.total.toLocaleString('en-US')} ${detail.currency ?? ''}`.trimEnd()] : [];
  const text = [
    `${recipientName} 您好 / Hello ${recipientName},`,
    '',
    `您的訂單 ${detail.order_id} ${label.zh}。`,
    `Your order ${detail.order_id} has been ${label.en}.`,
    '',
    ...(lines.length ? ['品項 Items:', ...lines, ''] : []),
    ...(total.length ? [...total, ''] : []),
    `時間 Time: ${detail.occurred_at}`,
    '',
    '—',
    'BrewLine 是 AWS Solutions Architect 作品集的示範系統，非真實交易。',
    'BrewLine is a demo system for an AWS Solutions Architect portfolio; no real transaction took place.',
  ].join('\n');
  return { subject: `${tag} 訂單${label.zh} / Order ${label.en}: ${detail.order_id}`, text };
}
