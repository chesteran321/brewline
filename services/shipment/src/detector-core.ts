import { createHash } from 'node:crypto';
import { LatLon, distanceKm, knotsToKmh, remainingKm, simplify } from './geo';
import { DcsaTransportEvent, PositionRecord, ShipmentItem, ShipmentStatus } from './model';
import { Route } from './seeds';

/**
 * 航次偵測（P2b-2，SHP-F-004／005／008，ADR-032 補充 E5／E7／E11）。純函數：同一批位置永遠得到同一個結果，
 * 所以同一個檔案重送（S3 事件至少一次）不會重複產生事件：比 `tracking.last_position_at` 舊的點一律略過。
 * Pure voyage detection: the same positions always give the same result, and points no newer than
 * tracking.last_position_at are ignored, so a re-delivered file never duplicates events.
 *
 * - geofence 遲滯：進 15 km、出 20 km（避免在邊界抖動時反覆判斷）。
 * - PLANNED：看過船在 POL 15 km 內，之後第一筆在 20 km 外 → DEPA。atd＝最後一筆「在 POL 內且繫泊（< 1 節）」的時間
 *   （離港判斷要等船開出 20 km，約晚 40 分鐘；最後繫泊時刻比較接近真正的離泊時間）；沒有繫泊紀錄才用判斷當下那一筆。
 * - DEPARTED：在 POD 15 km 內且航速 < 1 節 → ARRI（ata）。
 * - ETA：沿航點的剩餘距離 ÷ 最近 6 小時的平均航速（由位置算，不用回報的 sog → Dev 時間壓縮也正確）；
 *   低於 5 節（錨泊等待）時改用計畫平均速度。
 * - 偵測器不知道資料是模擬的還是真的（E3），也不知道時間被壓縮（E9）。
 */

export const ENTER_KM = 15;
export const EXIT_KM = 20;
export const ARRIVE_MAX_SOG = 1;
export const ETA_WINDOW_MS = 6 * 3_600_000;
export const ETA_MIN_KN = 5;
export const MAX_TRACK_POINTS = 200;

export type TrackPoint = [number, number, string]; // [lon, lat, ts]

export interface AdvanceResult {
  readonly changed: boolean;
  readonly status: ShipmentStatus;
  readonly atd?: string;
  readonly ata?: string;
  readonly eta?: string;
  readonly tracking: NonNullable<ShipmentItem['tracking']>;
  readonly events: DcsaTransportEvent[];
  /** 這一批新增到航跡的點（呼叫端合併後再簡化）/ Points to append to the track. */
  readonly trackPoints: TrackPoint[];
  readonly ignored: number;
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** 事件 ID 由（貨運、代碼）決定 → 同一個事件永遠同一個 ID（attribute_not_exists 防重複）/ Deterministic event id. */
export function eventId(shipmentId: string, code: 'DEPA' | 'ARRI'): string {
  return createHash('sha256').update(`${shipmentId}|${code}`).digest('hex').slice(0, 32);
}

export function transportEvent(s: ShipmentItem, code: 'DEPA' | 'ARRI', at: string, createdAt: string): DcsaTransportEvent {
  return {
    eventID: eventId(s.shipment_id, code),
    eventType: 'TRANSPORT',
    eventClassifierCode: 'ACT',
    transportEventTypeCode: code,
    eventDateTime: at,
    eventCreatedDateTime: createdAt,
    documentReferences: [{ documentReferenceType: 'BKG', documentReferenceValue: s.carrier_booking_reference }],
    transportCall: {
      UNLocationCode: code === 'DEPA' ? s.pol : s.pod,
      modeOfTransport: 'VESSEL',
      facilityTypeCode: 'POTE',
      carrierVoyageNumber: s.carrier_voyage_number,
      vessel: { vesselName: s.vessel.vessel_name },
    },
  };
}

/** 最近幾小時的平均速度（km/h，依位置與時間）；點不夠 → undefined / Average speed from positions. */
export function averageKmh(recent: ReadonlyArray<readonly [string, number, number]>): number | undefined {
  if (recent.length < 2) return undefined;
  let km = 0;
  for (let i = 1; i < recent.length; i++) km += distanceKm([recent[i - 1]![1], recent[i - 1]![2]], [recent[i]![1], recent[i]![2]]);
  const hours = (Date.parse(recent[recent.length - 1]![0]) - Date.parse(recent[0]![0])) / 3_600_000;
  return hours > 0 ? km / hours : undefined;
}

/** 計畫平均速度（km/h）：航線長度 ÷ 計畫航程時間 / Planned average speed. */
export function plannedKmh(s: ShipmentItem, route: Route): number {
  const hours = (Date.parse(s.planned_arrival) - Date.parse(s.planned_departure)) / 3_600_000;
  return route.path.lengthKm / Math.max(hours, 1);
}

export function estimateEta(s: ShipmentItem, route: Route, at: LatLon, atMs: number, recent: ReadonlyArray<readonly [string, number, number]>): string {
  const avg = averageKmh(recent);
  const kmh = avg !== undefined && avg >= knotsToKmh(ETA_MIN_KN) ? avg : plannedKmh(s, route);
  return iso(atMs + (remainingKm(route.path, at) / kmh) * 3_600_000);
}

/**
 * 把一艘船的一批位置套到它的貨運上。positions 不必排序；只處理比 last_position_at 新的點。
 * Apply one vessel's positions to its shipment. Positions need not be sorted; only newer points count.
 */
export function advance(s: ShipmentItem, route: Route, positions: readonly PositionRecord[], now: Date): AdvanceResult {
  const last = s.tracking?.last_position_at ? Date.parse(s.tracking.last_position_at) : Number.NEGATIVE_INFINITY;
  const fresh = [...positions].filter((p) => Date.parse(p.ts) > last).sort((a, b) => a.ts.localeCompare(b.ts));
  const base = { status: s.status, atd: s.atd, ata: s.ata, eta: s.eta, tracking: s.tracking ?? {} };
  if (fresh.length === 0) return { ...base, changed: false, events: [], trackPoints: [], ignored: positions.length };

  const pol: LatLon = [route.pol.lat, route.pol.lon];
  const pod: LatLon = [route.pod.lat, route.pod.lon];
  const createdAt = iso(now.getTime());
  let status = s.status;
  let atd = s.atd;
  let ata = s.ata;
  let atPolSeen = s.tracking?.at_pol_seen === true;
  let lastMoored = s.tracking?.last_moored_at;
  let recent = [...(s.tracking?.recent ?? [])] as Array<[string, number, number]>;
  const events: DcsaTransportEvent[] = [];
  const trackPoints: TrackPoint[] = [];
  let lastProcessed = s.tracking?.last_position_at;
  let lastAt: { at: LatLon; ms: number } | undefined;

  for (const p of fresh) {
    if (status === 'ARRIVED') break; // 抵港後的停泊點不屬於這個航次 / Post-arrival dwell is not part of the voyage.
    const at: LatLon = [p.lat, p.lon];
    const ms = Date.parse(p.ts);
    lastProcessed = p.ts;
    if (status === 'PLANNED') {
      const d = distanceKm(at, pol);
      if (d <= ENTER_KM) {
        atPolSeen = true;
        if (p.sog < ARRIVE_MAX_SOG) lastMoored = p.ts;
      } else if (atPolSeen && d > EXIT_KM) {
        status = 'DEPARTED';
        atd = lastMoored ?? p.ts;
        events.push(transportEvent(s, 'DEPA', atd, createdAt));
        trackPoints.push([route.pol.lon, route.pol.lat, p.ts], [p.lon, p.lat, p.ts]);
      }
    } else if (status === 'DEPARTED') {
      if (distanceKm(at, pod) <= ENTER_KM && p.sog < ARRIVE_MAX_SOG) {
        status = 'ARRIVED';
        ata = p.ts;
        events.push(transportEvent(s, 'ARRI', p.ts, createdAt));
        trackPoints.push([p.lon, p.lat, p.ts]);
      } else {
        trackPoints.push([p.lon, p.lat, p.ts]);
      }
    }
    if (status === 'DEPARTED') {
      recent.push([p.ts, p.lat, p.lon]);
      recent = recent.filter(([t]) => Date.parse(t) >= ms - ETA_WINDOW_MS).slice(-30);
      lastAt = { at, ms };
    }
  }

  let eta = s.eta;
  if (status === 'ARRIVED') eta = ata;
  else if (status === 'DEPARTED' && lastAt) eta = estimateEta(s, route, lastAt.at, lastAt.ms, recent);

  return {
    changed: true,
    status,
    atd,
    ata,
    eta,
    tracking: {
      last_position_at: lastProcessed,
      at_pol_seen: atPolSeen,
      ...(status === 'PLANNED' && lastMoored ? { last_moored_at: lastMoored } : {}),
      recent: status === 'DEPARTED' ? recent : [],
    },
    events,
    trackPoints,
    ignored: positions.length - fresh.length,
  };
}

/** 合併並簡化航跡（≤ 200 點、保留首尾）/ Merge and simplify the track. */
export function mergeTrack(existing: readonly TrackPoint[], added: readonly TrackPoint[]): TrackPoint[] {
  const all = [...existing, ...added].sort((a, b) => a[2].localeCompare(b[2]));
  const dedup = all.filter((p, i) => i === 0 || p[2] !== all[i - 1]![2] || p[0] !== all[i - 1]![0] || p[1] !== all[i - 1]![1]);
  // simplify 以 [lat, lon] 讀前兩個值 → 轉成 [lat, lon, ...] 再轉回 / simplify reads [lat, lon] first.
  const asLatLon = dedup.map((p) => [p[1], p[0], p[2]] as const);
  return simplify(asLatLon, MAX_TRACK_POINTS).map((p) => [p[1], p[0], p[2]] as TrackPoint);
}

/**
 * 一艘船這一刻屬於哪一個貨運：未抵港、且位置時間落在 [計畫開航 − 2 天, 計畫抵達 + 2 天]；多筆取最早。
 * 用時間窗而不是「最早未抵港」：漏掉的舊訂艙不會永遠卡住這艘船。
 * Which shipment a vessel is on now: not arrived and the position time within the planned window ± 2 days.
 */
export const MATCH_SLACK_MS = 2 * 86_400_000;
export function pickShipment(candidates: readonly ShipmentItem[], tsMs: number): ShipmentItem | undefined {
  return [...candidates]
    .filter(
      (c) =>
        c.status !== 'ARRIVED' &&
        tsMs >= Date.parse(c.planned_departure) - MATCH_SLACK_MS &&
        tsMs <= Date.parse(c.planned_arrival) + MATCH_SLACK_MS,
    )
    .sort((a, b) => a.planned_departure.localeCompare(b.planned_departure))[0];
}
