import { createHash } from 'node:crypto';
import { z } from 'zod';
import { demoContainerNumber } from './iso6346';
import { UnLocodeSchema } from './seeds';

/**
 * 海運資料模型（P2b，docs/06 §8，ADR-032 補充）。單表、鄰接清單，**不加 GSI**（沿用 ADR-031 D5）。
 * Shipment data model: single table, adjacency list, no new GSI.
 *
 *   SHIP#<shipment_id>  / META                                  貨運＝一筆訂艙搭一個航次 / one booking on one voyage
 *   SHIP#<shipment_id>  / EVT#<eventDateTime>#<eventID>         DCSA T&T 2.2.0 運輸事件（P2b-2 偵測器寫入）
 *   SHIP#<shipment_id>  / TRACK                                 航跡摘要 ≤ 200 點（P2b-2）
 *   LOT#<lot_id>        / SHIP#<planned_departure>#<id>         邊：批次 → 貨運（P2c 溯源頁用）
 *   VESSEL#<vessel_id>  / VOY#<planned_departure>#<id>          邊：船 → 貨運（P2b-2 偵測器用）
 *
 * 識別碼一律虛構（E10）：船 `SIMV-nn`（不用 MMSI／IMO）、訂艙號 `BLDEMO…`、貨櫃號 `DMQU…`。
 * 這些識別碼不放進事件 detail、公開頁或日誌（只在 DynamoDB 與 staff API）。
 * Identifiers are fictional and stay out of event details, public pages and logs.
 */

export const SHIP_PK_PREFIX = 'SHIP#';
export const VESSEL_PK_PREFIX = 'VESSEL#';
export const LOT_SHIP_EDGE_PREFIX = 'SHIP#';
export const VESSEL_VOY_EDGE_PREFIX = 'VOY#';
export const META_SK = 'META';

/** 訂艙到開航最多提前幾天；航程最長幾天 / Booking horizon and maximum voyage length. */
export const MAX_BOOKING_AHEAD_DAYS = 120;
export const MAX_VOYAGE_DAYS = 60;

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const ShipmentIdSchema = z.string().regex(/^sh_[0-9A-HJKMNP-TV-Z]{26}$/);
export const LotIdSchema = z.string().regex(/^L-\d{4}-\d{3}$/);
/** 真實船舶可用自己的代碼；模擬船一律 SIMV-nn / Any short code; simulated vessels are SIMV-nn. */
export const VesselIdSchema = z.string().regex(/^[A-Z0-9][A-Z0-9-]{2,19}$/);
export const SIM_VESSEL_ID = /^SIMV-\d{2}$/;
/** 只允許一般文字（staff 畫面會顯示）/ Plain text only (shown in staff views). */
export const VesselNameSchema = z.string().trim().min(2).max(50).regex(/^[A-Za-z0-9 .'()-]+$/);
export const VoyageNumberSchema = z.string().regex(/^[A-Z0-9]{2,10}$/);
/** UTC ISO 8601（到秒，結尾 Z）/ UTC ISO 8601 to the second, ending in Z. */
export const UtcTimestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/)
  .refine((s) => !Number.isNaN(Date.parse(s)), 'invalid timestamp');

export const shipPk = (id: string) => `${SHIP_PK_PREFIX}${id}`;
export const vesselPk = (vesselId: string) => `${VESSEL_PK_PREFIX}${vesselId}`;
export const lotPk = (lotId: string) => `LOT#${lotId}`;
export const lotShipEdgeSk = (plannedDeparture: string, id: string) => `${LOT_SHIP_EDGE_PREFIX}${plannedDeparture}#${id}`;
export const vesselVoyEdgeSk = (plannedDeparture: string, id: string) => `${VESSEL_VOY_EDGE_PREFIX}${plannedDeparture}#${id}`;

function crockford(digest: Buffer, chars: number): string {
  let bits = 0n;
  for (const b of digest.subarray(0, Math.ceil((chars * 5) / 8) + 1)) bits = (bits << 8n) | BigInt(b);
  let out = '';
  for (let i = 0; i < chars; i++) {
    out = CROCKFORD[Number(bits & 31n)] + out;
    bits >>= 5n;
  }
  return out;
}

/**
 * 貨運 ID 由 Idempotency-Key 決定（比照烘焙批次）：同一個 key 永遠是同一個 ID → attribute_not_exists 防重複。
 * The shipment id is derived from the Idempotency-Key, like roast batches.
 */
export function shipmentIdFromKey(key: string): string {
  return `sh_${crockford(createHash('sha256').update(`shipment|${key}`).digest(), 26)}`;
}

/** 虛構訂艙號（由貨運 ID 決定）/ Fictional booking reference derived from the shipment id. */
export function bookingReference(shipmentId: string): string {
  return `BLDEMO${crockford(createHash('sha256').update(`bkg|${shipmentId}`).digest(), 10)}`;
}

/** 一個 20 呎乾貨櫃（22G1），號碼由貨運 ID 決定 / One 20' dry container (22G1), numbered from the shipment id. */
export function equipmentFor(shipmentId: string): Equipment[] {
  const serial = createHash('sha256').update(`cntr|${shipmentId}`).digest().readUInt32BE(0) % 1_000_000;
  return [{ equipment_reference: demoContainerNumber(serial), iso_equipment_code: '22G1' }];
}

export const ShipmentStatusSchema = z.enum(['PLANNED', 'DEPARTED', 'ARRIVED']);
export type ShipmentStatus = z.infer<typeof ShipmentStatusSchema>;

export const EquipmentSchema = z.object({
  equipment_reference: z.string().regex(/^[A-Z]{3}[UJZ]\d{7}$/),
  /** ISO 6346 尺寸型別：22G1＝20 呎乾貨櫃 / ISO size-type: 22G1 = 20' general purpose. */
  iso_equipment_code: z.literal('22G1'),
});
export type Equipment = z.infer<typeof EquipmentSchema>;

/** POST /admin/shipments 的 body（POL／POD 由伺服器依批次決定，body 不能指定）/ Request body; POL/POD come from the lot. */
export const CreateShipmentRequestSchema = z
  .strictObject({
    lot_id: LotIdSchema,
    planned_departure: UtcTimestampSchema,
    planned_arrival: UtcTimestampSchema,
    carrier_voyage_number: VoyageNumberSchema,
    vessel_id: VesselIdSchema,
    vessel_name: VesselNameSchema,
  })
  .refine((r) => Date.parse(r.planned_arrival) > Date.parse(r.planned_departure), {
    message: 'planned_arrival must be after planned_departure',
    path: ['planned_arrival'],
  })
  .refine((r) => Date.parse(r.planned_arrival) - Date.parse(r.planned_departure) <= MAX_VOYAGE_DAYS * 86_400_000, {
    message: `voyage longer than ${MAX_VOYAGE_DAYS} days`,
    path: ['planned_arrival'],
  });
export type CreateShipmentRequest = z.infer<typeof CreateShipmentRequestSchema>;

/** 請求指紋（同一個 key 不同內容 → 422）/ Request fingerprint. */
export function shipmentRequestHash(r: CreateShipmentRequest): string {
  return createHash('sha256')
    .update(JSON.stringify([r.lot_id, r.planned_departure, r.planned_arrival, r.carrier_voyage_number, r.vessel_id, r.vessel_name]))
    .digest('hex');
}

export const ShipmentItemSchema = z.object({
  pk: z.string().startsWith(SHIP_PK_PREFIX),
  sk: z.literal(META_SK),
  entity: z.literal('Shipment'),
  shipment_id: ShipmentIdSchema,
  lot_id: LotIdSchema,
  route_id: z.string(),
  pol: UnLocodeSchema,
  pod: UnLocodeSchema,
  carrier_booking_reference: z.string(),
  carrier_voyage_number: VoyageNumberSchema,
  vessel: z.object({ vessel_id: VesselIdSchema, vessel_name: z.string() }),
  equipment: z.array(EquipmentSchema).min(1),
  planned_departure: UtcTimestampSchema,
  planned_arrival: UtcTimestampSchema,
  eta: UtcTimestampSchema.optional(),
  atd: UtcTimestampSchema.optional(),
  ata: UtcTimestampSchema.optional(),
  status: ShipmentStatusSchema,
  /** 偵測器的進度（P2b-2）：最後處理的位置時刻、是否看過船在 POL、最近 6 小時的點（算平均航速）/ Detector state. */
  tracking: z
    .object({
      last_position_at: UtcTimestampSchema.optional(),
      at_pol_seen: z.boolean().optional(),
      last_moored_at: UtcTimestampSchema.optional(),
      recent: z.array(z.tuple([z.string(), z.number(), z.number()])).max(30).optional(),
    })
    .optional(),
  request_hash: z.string(),
  version: z.number().int().min(1),
  created_by: z.string(),
  created_at: z.string(),
  updated_at: z.string().optional(),
  synthetic: z.literal(true).optional(),
});
export type ShipmentItem = z.infer<typeof ShipmentItemSchema>;

/** 邊：批次 → 貨運、船 → 貨運（屬性相同；IAM 以 dynamodb:Attributes 限定只能寫這些欄位）/ Edge items. */
export { EDGE_ATTRIBUTES } from './edge-attributes';
export const ShipmentEdgeSchema = z.object({
  pk: z.string(),
  sk: z.string(),
  entity: z.enum(['LotShipment', 'VesselVoyage']),
  shipment_id: ShipmentIdSchema,
  planned_departure: UtcTimestampSchema,
  pol: UnLocodeSchema,
  pod: UnLocodeSchema,
  status: ShipmentStatusSchema,
  synthetic: z.literal(true).optional(),
});
export type ShipmentEdge = z.infer<typeof ShipmentEdgeSchema>;

// --- DCSA Track & Trace 2.2.0 運輸事件（子集，E7）/ DCSA T&T 2.2.0 transport event (subset) ---
// 欄位名稱與代碼照公開規格（Apache 2.0）；只實作 P2b 用到的部分。P2b-2 偵測器寫入、staff API 讀出。
// Field names and code lists follow the public specification (Apache 2.0); only what P2b needs.
export const DCSA_TNT_VERSION = '2.2.0';
export const TransportEventTypeCodeSchema = z.enum(['ARRI', 'DEPA']);
export const EventClassifierCodeSchema = z.enum(['ACT', 'EST', 'PLN']);

export const DcsaTransportEventSchema = z.strictObject({
  eventID: z.string().min(1).max(100),
  eventType: z.literal('TRANSPORT'),
  eventClassifierCode: EventClassifierCodeSchema,
  transportEventTypeCode: TransportEventTypeCodeSchema,
  eventDateTime: UtcTimestampSchema,
  eventCreatedDateTime: UtcTimestampSchema,
  documentReferences: z.array(z.strictObject({ documentReferenceType: z.literal('BKG'), documentReferenceValue: z.string() })).min(1),
  transportCall: z.strictObject({
    UNLocationCode: UnLocodeSchema,
    modeOfTransport: z.literal('VESSEL'),
    facilityTypeCode: z.literal('POTE'),
    carrierVoyageNumber: VoyageNumberSchema,
    vessel: z.strictObject({ vesselName: z.string() }),
  }),
});
export type DcsaTransportEvent = z.infer<typeof DcsaTransportEventSchema>;

export const ShipmentEventItemSchema = z.object({
  pk: z.string().startsWith(SHIP_PK_PREFIX),
  sk: z.string().startsWith('EVT#'),
  entity: z.literal('TransportEvent'),
  event: DcsaTransportEventSchema,
});

export const TrackItemSchema = z.object({
  pk: z.string().startsWith(SHIP_PK_PREFIX),
  sk: z.literal('TRACK'),
  entity: z.literal('Track'),
  points: z.array(z.tuple([z.number(), z.number(), z.string()])).max(200),
});

/** staff／烘焙廠看的貨運 DTO / Shipment DTO for staff and the roastery. */
export function toAdminShipment(s: ShipmentItem) {
  return {
    shipment_id: s.shipment_id,
    lot_id: s.lot_id,
    pol: s.pol,
    pod: s.pod,
    carrier_booking_reference: s.carrier_booking_reference,
    carrier_voyage_number: s.carrier_voyage_number,
    vessel: { vessel_id: s.vessel.vessel_id, vessel_name: s.vessel.vessel_name },
    equipment: s.equipment.map((e) => ({ equipment_reference: e.equipment_reference, iso_equipment_code: e.iso_equipment_code })),
    planned_departure: s.planned_departure,
    planned_arrival: s.planned_arrival,
    eta: s.eta,
    atd: s.atd,
    ata: s.ata,
    status: s.status,
    created_at: s.created_at,
    synthetic: s.synthetic === true,
  };
}

// --- 位置記錄（P2b-2，E3：模擬器與 aisstream spike 共用的入口格式）/ Position records (shared entry format) ---
export const PositionRecordSchema = z.object({
  source: z.enum(['sim', 'ais']),
  vessel_id: VesselIdSchema,
  vessel_name: z.string().max(60).optional(),
  ts: UtcTimestampSchema,
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  sog: z.number().min(0).max(60),
  cog: z.number().min(0).max(360).optional(),
  nav_status: z.number().int().min(0).max(15).optional(),
  destination: z.string().max(20).optional(),
  synthetic: z.boolean().optional(),
});
export type PositionRecord = z.infer<typeof PositionRecordSchema>;
