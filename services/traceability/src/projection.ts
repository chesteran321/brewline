import type { ProductMetaItem } from '../../ordering/src/lib/model';
import type { LotItem, RoastItem } from '../../ordering/src/lib/trace-model';

/**
 * 公開溯源頁的投影（S2c，ADR-031 D2，docs/04 §8）。純函數：只從白名單欄位**建構新物件**，
 * 從不複製或刪減原始項目，所以資料表新增欄位也不會意外出現在公開頁（RSK-019）。
 * Public trace projection. Pure: builds a new object from allow-listed fields only — it never copies a stored item
 * and strips fields — so a new column can never leak onto the public page.
 */

/** 物件鍵 / S3 key under which the projection is published. */
export const PROJECTION_PREFIX = 'v1/';
export const projectionKey = (qrToken: string) => `${PROJECTION_PREFIX}${qrToken}.json`;

/** ADR-031 D3：CloudFront 依原點的 Cache-Control 快取 5 分鐘（TRC-N-002）/ CloudFront honours the origin max-age. */
export const PROJECTION_CACHE_CONTROL = 'public, max-age=300';

export const PROJECTION_SCHEMA_VERSION = 1;

export interface PublicTrace {
  readonly schema: number;
  readonly product: { readonly name: string; readonly name_zh: string | undefined };
  readonly lot: {
    readonly producer_display_name: string;
    readonly origin_country: string;
    readonly region: string;
    readonly altitude_m: number;
    readonly variety: string;
    readonly process: string;
    readonly cup_score: number;
    readonly harvest: string;
  };
  readonly roast: { readonly roast_date: string; readonly roast_level: string };
  readonly recall: { readonly at: string; readonly notice: string } | undefined;
  /** 模擬器產生的資料（ADR-030 D6）：頁面顯示「示範資料」/ Simulator data, labelled on the page. */
  readonly demo: boolean;
  readonly generated_at: string;
}

export type ProjectionResult =
  | { readonly kind: 'publish'; readonly key: string; readonly body: PublicTrace }
  | { readonly kind: 'skip'; readonly reason: 'not_roasted' | 'no_token' | 'lot_mismatch' };

export function buildProjection(roast: RoastItem, lot: LotItem, product: ProductMetaItem, now: Date): ProjectionResult {
  if (roast.status !== 'ROASTED') return { kind: 'skip', reason: 'not_roasted' };
  if (!roast.qr_token) return { kind: 'skip', reason: 'no_token' };
  if (roast.lot_id !== lot.lot_id || roast.product_id !== product.id) return { kind: 'skip', reason: 'lot_mismatch' };
  return {
    kind: 'publish',
    key: projectionKey(roast.qr_token),
    body: {
      schema: PROJECTION_SCHEMA_VERSION,
      product: { name: product.name, name_zh: product.name_zh },
      lot: {
        producer_display_name: lot.producer_display_name,
        origin_country: lot.origin_country,
        region: lot.region,
        altitude_m: lot.altitude_m,
        variety: lot.variety,
        process: lot.process,
        cup_score: lot.cup_score,
        harvest: lot.harvest,
      },
      roast: { roast_date: roast.roast_date, roast_level: roast.roast_level },
      recall: roast.recall ? { at: roast.recall.at, notice: roast.recall.notice } : undefined,
      demo: roast.synthetic === true,
      generated_at: now.toISOString(),
    },
  };
}
