import type { OrderStatus } from './order-model';

/**
 * 訂單狀態機（ORD-F-005，A3c，ADR-027）。狀態以 DynamoDB 為準（A3 決策 D2）。
 * Order state machine; DynamoDB is the source of truth.
 *
 *   CREATED → CONFIRMED → ROASTING_SCHEDULED → ROASTED → SHIPPED → COMPLETED
 *      └──────────┴──→ CANCELLED（只在烘焙排程之前 / only before roasting is scheduled）
 *
 * 庫存影響 / Stock effect：
 *   → SHIPPED   consume：reserved -= qty（預留被出貨消耗 / reservation fulfilled）
 *   → CANCELLED release：reserved -= qty, available += qty（釋放 / released）
 */
export const TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  CREATED: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['ROASTING_SCHEDULED', 'CANCELLED'],
  ROASTING_SCHEDULED: ['ROASTED'],
  ROASTED: ['SHIPPED'],
  SHIPPED: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
};

export type StockEffect = 'none' | 'consume' | 'release';

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function stockEffect(to: OrderStatus): StockEffect {
  if (to === 'SHIPPED') return 'consume';
  if (to === 'CANCELLED') return 'release';
  return 'none';
}
