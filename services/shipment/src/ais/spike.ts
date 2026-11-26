import { z } from 'zod';
import { PositionRecord, PositionRecordSchema } from '../model';
import { Port, seeds } from '../seeds';

/**
 * P2b-spike aisstream（ADR-032 D2／D9，spike 規格 F1–F12）的純函數：訂閱訊息、正規化、去重、物件鍵、退避。
 * Pure helpers for the Dev-only aisstream spike: subscription, normalisation, de-duplication, keys, back-off.
 *
 * - 只在 Dev、只放 lake 的 raw/（30 天刪除），不進公開頁、不進 Prod（D2）。
 * - 正規化成與模擬器相同的位置格式（PositionRecordSchema），寫 raw/positions/source=ais/（F6）→ 偵測函數會讀到，
 *   但沒有任何貨運對應 → 只計數（unmatched）。
 * - 日誌只記數量（F10）：本檔不輸出任何 MMSI、船名或座標。
 */

export const AIS_ENDPOINT = 'wss://stream.aisstream.io/v0/stream';
/** F5：位置＋靜態資料（船種）/ Position reports plus static data (ship type). */
export const AIS_MESSAGE_TYPES = ['PositionReport', 'ShipStaticData'] as const;
/** F4：每個港口中心 ±0.3°（約 ±33 km，比 geofence 20 km 大）/ ±0.3° around each port. */
export const BOX_HALF_DEG = 0.3;
export const POSITIONS_KEY_PREFIX = 'raw/positions/source=ais/';
export const STATIC_KEY_PREFIX = 'raw/ais-static/';
/** F7：連線最多 3 次，間隔 1、2 秒（指數退避）/ Up to 3 attempts, 1 s then 2 s apart. */
export const MAX_ATTEMPTS = 3;
export const BACKOFF_BASE_MS = 1000;

export interface Box {
  readonly locode: string;
  /** aisstream 的格式：每個角是 [緯度, 經度]（緯度在前）/ aisstream corners are [latitude, longitude]. */
  readonly corners: readonly [readonly [number, number], readonly [number, number]];
}

const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;

/** 10 個港口各一個方框（含 spike_only 的 VNSGN）/ One box per seeded port, spike-only ports included. */
export function portBoxes(ports: readonly Port[] = [...seeds().ports.values()]): Box[] {
  return ports.map((p) => ({
    locode: p.locode,
    corners: [
      [round(p.lat - BOX_HALF_DEG, 6), round(p.lon - BOX_HALF_DEG, 6)],
      [round(p.lat + BOX_HALF_DEG, 6), round(p.lon + BOX_HALF_DEG, 6)],
    ],
  }));
}

/** 訂閱訊息（連線後 3 秒內送出）/ Subscription message, sent within 3 s of connecting. */
export function subscription(apiKey: string, boxes: readonly Box[]) {
  return {
    APIKey: apiKey,
    BoundingBoxes: boxes.map((b) => [[...b.corners[0]], [...b.corners[1]]]),
    FilterMessageTypes: [...AIS_MESSAGE_TYPES],
  };
}

export function boxOf(boxes: readonly Box[], lat: number, lon: number): string | undefined {
  return boxes.find((b) => lat >= b.corners[0][0] && lat <= b.corners[1][0] && lon >= b.corners[0][1] && lon <= b.corners[1][1])?.locode;
}

// --- 收到的訊息（只用到的欄位；其他欄位忽略）/ Received messages: only the fields we use ---
const Num = z.number().finite();
const MetaSchema = z.looseObject({
  MMSI: z.union([z.number().int(), z.string().regex(/^\d{1,9}$/)]),
  ShipName: z.string().optional(),
  latitude: Num.optional(),
  longitude: Num.optional(),
  Latitude: Num.optional(),
  Longitude: Num.optional(),
  time_utc: z.string().optional(),
});
const PositionSchema = z.looseObject({
  Latitude: Num,
  Longitude: Num,
  Sog: Num,
  Cog: Num.optional(),
  NavigationalStatus: z.number().int().optional(),
  Valid: z.boolean().optional(),
});
const StaticSchema = z.looseObject({
  Name: z.string().optional(),
  Type: z.number().int().optional(),
  Destination: z.string().optional(),
  Valid: z.boolean().optional(),
});
const EnvelopeSchema = z.looseObject({
  MessageType: z.string(),
  MetaData: MetaSchema.optional(),
  Message: z.record(z.string(), z.unknown()).optional(),
});

export interface StaticRecord {
  readonly source: 'ais';
  readonly vessel_id: string;
  readonly vessel_name?: string;
  readonly ship_type?: number;
  readonly destination?: string;
  readonly ts: string;
}

export type Parsed =
  | { readonly kind: 'position'; readonly record: PositionRecord; readonly box?: string }
  | { readonly kind: 'static'; readonly record: StaticRecord; readonly box?: string }
  | { readonly kind: 'skipped'; readonly reason: string }
  | { readonly kind: 'control'; readonly compression?: boolean; readonly error?: string };

export const vesselIdOf = (mmsi: number | string) => `MMSI-${String(mmsi).padStart(9, '0')}`;

/** AIS 的文字欄位以 '@' 補位；去掉後收斂空白 / AIS pads text with '@'. */
export function cleanText(s: string | undefined, max: number): string | undefined {
  if (s === undefined) return undefined;
  const t = s.replace(/@/g, ' ').replace(/[^\x20-\x7E]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
  return t.length > 0 ? t : undefined;
}

/**
 * MetaData.time_utc（例：`2026-11-25 14:05:31.123456789 +0000 UTC`；官方文件未列出格式 → 不符合就用接收時間）。
 * Parse MetaData.time_utc when present and in the expected shape; otherwise use the receive time.
 */
export function timestampOf(timeUtc: string | undefined, receivedAtMs: number): string {
  const m = timeUtc?.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?(?: ?\+0000)?(?: UTC|Z)?$/);
  const iso = m ? `${m[1]}T${m[2]}Z` : undefined;
  if (iso && !Number.isNaN(Date.parse(iso))) return iso;
  return new Date(Math.floor(receivedAtMs / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * 一則訊息 → 正規化的位置或靜態記錄。無資料值略過：緯度 91、經度 181、航速 102.3（以及偵測器 schema 以外的
 * > 60 節）；Cog 360＝無資料 → 不寫。輸出一定通過 PositionRecordSchema（偵測器遇到格式錯誤會丟錯 → DLQ）。
 * One message → a normalised record. "Not available" values are skipped; output always passes the detector schema.
 */
export function parseMessage(raw: unknown, receivedAtMs: number, boxes: readonly Box[]): Parsed {
  const env = EnvelopeSchema.safeParse(raw);
  if (!env.success) {
    const err = z.looseObject({ error: z.string() }).safeParse(raw);
    return err.success ? { kind: 'control', error: err.data.error.slice(0, 120) } : { kind: 'skipped', reason: 'not_an_envelope' };
  }
  const { MessageType: type, MetaData: meta, Message: message } = env.data;
  if (type === 'SubscriptionConfirmation') {
    const c = (message?.SubscriptionConfirmation as { CompressionEnabled?: unknown } | undefined)?.CompressionEnabled;
    return { kind: 'control', compression: typeof c === 'boolean' ? c : undefined };
  }
  if (!meta) return { kind: 'skipped', reason: 'no_metadata' };
  const vessel_id = vesselIdOf(meta.MMSI);
  const ts = timestampOf(meta.time_utc, receivedAtMs);
  const vessel_name = cleanText(meta.ShipName, 60);

  if (type === 'PositionReport') {
    const p = PositionSchema.safeParse(message?.PositionReport);
    if (!p.success) return { kind: 'skipped', reason: 'bad_position' };
    const { Latitude: lat, Longitude: lon, Sog: sog, Cog: cog, NavigationalStatus: nav, Valid: valid } = p.data;
    if (valid === false) return { kind: 'skipped', reason: 'invalid' };
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return { kind: 'skipped', reason: 'no_position' };
    if (sog < 0 || sog > 60) return { kind: 'skipped', reason: 'no_speed' };
    const record = PositionRecordSchema.parse({
      source: 'ais',
      vessel_id,
      ...(vessel_name ? { vessel_name } : {}),
      ts,
      lat: round(lat, 6),
      lon: round(lon, 6),
      sog: round(sog, 1),
      ...(cog !== undefined && cog >= 0 && cog < 360 ? { cog: round(cog, 1) } : {}),
      ...(nav !== undefined && nav >= 0 && nav <= 15 ? { nav_status: nav } : {}),
    });
    return { kind: 'position', record, box: boxOf(boxes, record.lat, record.lon) };
  }
  if (type === 'ShipStaticData') {
    const s = StaticSchema.safeParse(message?.ShipStaticData);
    if (!s.success || s.data.Valid === false) return { kind: 'skipped', reason: 'bad_static' };
    const name = cleanText(s.data.Name, 60) ?? vessel_name;
    const destination = cleanText(s.data.Destination, 20);
    const lat = meta.latitude ?? meta.Latitude;
    const lon = meta.longitude ?? meta.Longitude;
    const record: StaticRecord = {
      source: 'ais',
      vessel_id,
      ...(name ? { vessel_name: name } : {}),
      ...(s.data.Type !== undefined && s.data.Type >= 0 && s.data.Type <= 99 ? { ship_type: s.data.Type } : {}),
      ...(destination ? { destination } : {}),
      ts,
    };
    return { kind: 'static', record, box: lat !== undefined && lon !== undefined ? boxOf(boxes, lat, lon) : undefined };
  }
  return { kind: 'skipped', reason: 'other_type' };
}

/** F6：依 MMSI＋時間（秒）去重，並依時間、船排序 / De-duplicate by vessel and second. */
export function dedupe<T extends { vessel_id: string; ts: string }>(records: readonly T[]): T[] {
  const seen = new Map<string, T>();
  for (const r of records) seen.set(`${r.vessel_id}|${r.ts}`, r);
  return [...seen.values()].sort((a, b) => a.ts.localeCompare(b.ts) || a.vessel_id.localeCompare(b.vessel_id));
}

/** 物件鍵（UTC 日期與時分，與模擬器相同的分區方式）/ Object keys, partitioned like the simulator's. */
export function objectKeys(startMs: number): { positions: string; static: string } {
  const d = new Date(Math.floor(startMs / 60_000) * 60_000);
  const dt = d.toISOString().slice(0, 10);
  const hhmm = `${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}`;
  return { positions: `${POSITIONS_KEY_PREFIX}dt=${dt}/${hhmm}.jsonl.gz`, static: `${STATIC_KEY_PREFIX}dt=${dt}/${hhmm}.jsonl.gz` };
}

/** 第 n 次失敗後等多久（n 從 1 起）：1、2 秒…；最後一次不等 / Delay after the n-th failed attempt. */
export const backoffMs = (attempt: number) => BACKOFF_BASE_MS * 2 ** (attempt - 1);

export interface BoxStat {
  readonly box: string;
  readonly positions: number;
  readonly vessels: number;
}

/** F10：每個方框的筆數與不重複船數（不含任何識別碼）/ Per-box counts only, no identifiers. */
export function boxStats(boxes: readonly Box[], positions: ReadonlyArray<{ record: PositionRecord; box?: string }>): BoxStat[] {
  return boxes.map((b) => {
    const inBox = positions.filter((p) => p.box === b.locode);
    return { box: b.locode, positions: inBox.length, vessels: new Set(inBox.map((p) => p.record.vessel_id)).size };
  });
}
