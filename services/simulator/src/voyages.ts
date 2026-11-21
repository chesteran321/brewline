import { createHash } from 'node:crypto';
import { LatLon, knotsToKmh, pointAlong } from '../../shipment/src/geo';
import { Route, ShipmentSeeds, seeds as defaultSeeds } from '../../shipment/src/seeds';
import { rng } from './generator';

/**
 * 模擬航程產生器（P2b，ADR-032 D1 與補充 E2／E9／E10／E12）。純函數：同樣的（種子、設定、時間）永遠得到同樣的
 * 訂艙與船位，所以重跑只是重播（訂艙冪等鍵相同、位置檔內容相同）。
 * Pure voyage generator: the same (seed, settings, time) always yields the same bookings and positions, so re-runs
 * replay (same Idempotency-Keys, byte-identical position files).
 *
 * - E2 滾動貨運：每個有海運的批次每 cycleDays 出一櫃，出發時刻的相位由種子決定（各批次錯開）。
 * - E9 時間尺度：Dev ×24（週期、航行時間、訂艙提前量都除以尺度）；**港口停泊 12 小時不壓縮**，
 *   確保 geofence 內至少有 24 筆位置。偵測器不知道時間被壓縮。
 * - E10 虛構識別碼：船 SIMV-nn（不用 MMSI／IMO）、船名 `Demo <鳥名>`、航次號 D<nnn>E。
 * - E12 不回補：只產生「訂艙時刻 ≥ startDate」的貨運。
 * - Dev 測試批次（lot-routes 的 test: true）只給 smoke test，這裡不排程。
 */

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
/** 港口停泊（不壓縮）/ Port dwell before departure and after arrival (never scaled). */
export const DWELL_MS = 12 * HOUR_MS;
/** 位置取樣間隔（E4：每 30 分一個檔案）/ Position sampling interval. */
export const POSITION_INTERVAL_MS = 30 * 60_000;
/** 週期的起點（相位從這裡算）/ Epoch the cycle phases are measured from. */
export const EPOCH_MS = Date.UTC(2026, 10, 1);
/** 每條航線輪替的船數（航程＋停泊 < 3 個週期，同一艘船不會同時出現在兩個航程）/ Vessels rotating per route. */
export const VESSELS_PER_ROUTE = 3;
/** 訂艙提前量：7 天（除以尺度），但至少 24 小時，讓夜間（20–08 時）沒有執行時也來得及在停泊前建立。 */
export const BOOKING_LEAD_MS = 7 * DAY_MS;
export const MIN_BOOKING_LEAD_MS = 24 * HOUR_MS;
export const SPEED_KN = { min: 14, max: 18 } as const;

/** 24 個虛構船名（Demo＋鳥名）/ 24 fictional vessel names. */
export const VESSEL_NAMES = [
  'Demo Kestrel', 'Demo Heron', 'Demo Plover', 'Demo Tern', 'Demo Avocet', 'Demo Curlew',
  'Demo Dunlin', 'Demo Egret', 'Demo Gannet', 'Demo Ibis', 'Demo Jacana', 'Demo Kittiwake',
  'Demo Lapwing', 'Demo Merlin', 'Demo Nightjar', 'Demo Oriole', 'Demo Petrel', 'Demo Quail',
  'Demo Redshank', 'Demo Siskin', 'Demo Thrush', 'Demo Turnstone', 'Demo Verdin', 'Demo Wren',
] as const;

export interface VoyageSettings {
  /** 1＝真實時間（Prod）、24＝Dev 壓縮 / 1 = real time, 24 = Dev compression. */
  readonly timeScale: number;
  /** YYYY-MM-DD（UTC）：訂艙時刻早於這天的貨運不產生（E12）/ No shipments whose booking opens before this day. */
  readonly startDate: string;
}

export interface PlannedShipment {
  readonly lot_id: string;
  readonly route_id: string;
  readonly cycle: number;
  /** 毫秒，UTC / Epoch milliseconds. */
  readonly etd: number;
  readonly eta: number;
  readonly bookingOpensAt: number;
  readonly speedKn: number;
  readonly vessel_id: string;
  readonly vessel_name: string;
  readonly carrier_voyage_number: string;
  readonly idempotencyKey: string;
}

export interface PositionRecord {
  readonly source: 'sim';
  readonly vessel_id: string;
  readonly vessel_name: string;
  readonly ts: string;
  readonly lat: number;
  readonly lon: number;
  readonly sog: number;
  readonly cog: number;
  /** AIS 航行狀態：0 航行中、5 繫泊 / AIS navigational status: 0 under way, 5 moored. */
  readonly nav_status: 0 | 5;
  readonly destination: string;
  readonly synthetic: true;
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

function startMs(s: VoyageSettings): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s.startDate)) throw new Error('voyages.startDate must be YYYY-MM-DD');
  const ms = Date.parse(`${s.startDate}T00:00:00Z`);
  if (Number.isNaN(ms)) throw new Error('voyages.startDate is not a date');
  return ms;
}

function check(s: VoyageSettings): void {
  if (!Number.isInteger(s.timeScale) || s.timeScale < 1 || s.timeScale > 48) throw new Error('voyages.timeScale must be an integer 1–48');
}

export const cycleMs = (cycleDays: number, s: VoyageSettings) => (cycleDays * DAY_MS) / s.timeScale;
export const bookingLeadMs = (s: VoyageSettings) => Math.max(BOOKING_LEAD_MS / s.timeScale, MIN_BOOKING_LEAD_MS);

/** 沒有測試批次的排程清單（依 lot-routes 順序）/ Plannable lots, in lot-routes order. */
function plannableLots(sd: ShipmentSeeds): Array<{ lot_id: string; route: Route; routeIndex: number }> {
  const routeIds = [...sd.routes.keys()];
  return [...sd.lotRoutes.values()]
    .filter((l) => l.test !== true)
    .map((l) => ({ lot_id: l.lot_id, route: sd.routes.get(l.route)!, routeIndex: routeIds.indexOf(l.route) }));
}

function plan(seed: string, s: VoyageSettings, sd: ShipmentSeeds, lot: { lot_id: string; route: Route; routeIndex: number }, k: number): PlannedShipment {
  const cyc = cycleMs(sd.cycleDays, s);
  const phase = Math.floor(rng(seed, 'voyage-phase', lot.lot_id)() * cyc);
  const etd = Math.floor((EPOCH_MS + phase + k * cyc) / 60_000) * 60_000; // 整分鐘 / whole minutes
  const speedKn = Math.round((SPEED_KN.min + rng(seed, 'voyage-speed', lot.lot_id, k)() * (SPEED_KN.max - SPEED_KN.min)) * 10) / 10;
  const sailingMs = ((lot.route.path.lengthKm / knotsToKmh(speedKn)) * HOUR_MS) / s.timeScale;
  const eta = Math.ceil((etd + sailingMs) / 60_000) * 60_000;
  const vesselNo = lot.routeIndex * VESSELS_PER_ROUTE + (((k % VESSELS_PER_ROUTE) + VESSELS_PER_ROUTE) % VESSELS_PER_ROUTE) + 1;
  return {
    lot_id: lot.lot_id,
    route_id: lot.route.id,
    cycle: k,
    etd,
    eta,
    bookingOpensAt: etd - DWELL_MS - bookingLeadMs(s),
    speedKn,
    vessel_id: `SIMV-${String(vesselNo).padStart(2, '0')}`,
    vessel_name: VESSEL_NAMES[(vesselNo - 1) % VESSEL_NAMES.length]!,
    carrier_voyage_number: `D${String(((k % 1000) + 1000) % 1000).padStart(3, '0')}E`,
    idempotencyKey: `simship-${createHash('sha256').update(`${seed}|${lot.lot_id}|${iso(etd)}`).digest('hex').slice(0, 32)}`,
  };
}

/**
 * 出發時刻落在 [fromMs, toMs) 的貨運（已套用 E12 startDate）。
 * Shipments departing in [fromMs, toMs), after the E12 start filter.
 */
export function shipmentsDeparting(seed: string, s: VoyageSettings, fromMs: number, toMs: number, sd: ShipmentSeeds = defaultSeeds()): PlannedShipment[] {
  check(s);
  const start = startMs(s);
  const cyc = cycleMs(sd.cycleDays, s);
  const out: PlannedShipment[] = [];
  for (const lot of plannableLots(sd)) {
    const first = Math.floor((fromMs - EPOCH_MS) / cyc) - 1;
    const last = Math.ceil((toMs - EPOCH_MS) / cyc) + 1;
    for (let k = first; k <= last; k++) {
      const p = plan(seed, s, sd, lot, k);
      if (p.etd >= fromMs && p.etd < toMs && p.bookingOpensAt >= start) out.push(p);
    }
  }
  return out.sort((a, b) => a.etd - b.etd || a.lot_id.localeCompare(b.lot_id));
}

/** 最長航程（真實時間）＋停泊：往前找多遠才不會漏掉仍在海上的船 / Longest voyage plus dwell, for look-back windows. */
function maxLifetimeMs(s: VoyageSettings, sd: ShipmentSeeds): number {
  const longest = Math.max(...plannableLots(sd).map((l) => l.route.path.lengthKm));
  return ((longest / knotsToKmh(SPEED_KN.min)) * HOUR_MS) / s.timeScale + 2 * DWELL_MS;
}

/**
 * 現在該建立的訂艙：訂艙時刻已到、且船還沒開始在 POL 停泊（偵測器要看到「港內 → 出港」）。
 * 每小時那一輪都送一次（重送回 200），所以中間漏掉一輪也沒關係。
 * Bookings due now: the booking window has opened and the POL dwell has not started yet. Every hourly run sends
 * them (replays return 200), so a missed run is harmless.
 */
export function bookingsDue(seed: string, s: VoyageSettings, nowMs: number, sd: ShipmentSeeds = defaultSeeds()): PlannedShipment[] {
  return shipmentsDeparting(seed, s, nowMs, nowMs + DWELL_MS + bookingLeadMs(s) + 1, sd).filter(
    (p) => p.bookingOpensAt <= nowMs && nowMs < p.etd - DWELL_MS,
  );
}

/** 船在時刻 t 的位置；不在這段生命週期內 → undefined / Vessel position at t, or undefined outside its lifetime. */
export function positionAt(seed: string, p: PlannedShipment, t: number, sd: ShipmentSeeds = defaultSeeds()): PositionRecord | undefined {
  if (t < p.etd - DWELL_MS || t > p.eta + DWELL_MS) return undefined;
  const route = sd.routes.get(p.route_id)!;
  const r = rng(seed, 'pos', p.vessel_id, t);
  const jitter = () => (r() - 0.5) * 0.02; // ±0.01°（約 1 km）/ about ±1 km
  let at: LatLon;
  let sog = 0;
  let cog = 0;
  let nav: 0 | 5 = 5;
  if (t <= p.etd) {
    at = [route.pol.lat, route.pol.lon];
  } else if (t >= p.eta) {
    at = [route.pod.lat, route.pod.lon];
  } else {
    const f = (t - p.etd) / (p.eta - p.etd);
    const pt = pointAlong(route.path, f * route.path.lengthKm);
    at = pt.at;
    cog = Math.round(pt.cog) % 360;
    sog = Math.round((p.speedKn + (r() - 0.5) * 2) * 10) / 10; // ±1 節 / ±1 knot
    nav = 0;
  }
  const round = (x: number) => Math.round(x * 1e5) / 1e5;
  return {
    source: 'sim',
    vessel_id: p.vessel_id,
    vessel_name: p.vessel_name,
    ts: iso(t),
    lat: round(at[0] + jitter()),
    lon: round(at[1] + jitter()),
    sog,
    cog,
    nav_status: nav,
    destination: route.pod.locode,
    synthetic: true,
  };
}

/**
 * [fromMs, toMs) 內每 30 分鐘一筆、所有在港或在航的模擬船位置（依時間、船排序）。
 * Every 30-minute sample in [fromMs, toMs) for every simulated vessel in port or at sea, sorted by time then vessel.
 */
export function positionsForWindow(seed: string, s: VoyageSettings, fromMs: number, toMs: number, sd: ShipmentSeeds = defaultSeeds()): PositionRecord[] {
  const ships = shipmentsDeparting(seed, s, fromMs - maxLifetimeMs(s, sd), toMs + DWELL_MS + 1, sd);
  const out: PositionRecord[] = [];
  for (let t = Math.ceil(fromMs / POSITION_INTERVAL_MS) * POSITION_INTERVAL_MS; t < toMs; t += POSITION_INTERVAL_MS) {
    for (const p of ships) {
      const rec = positionAt(seed, p, t, sd);
      if (rec) out.push(rec);
    }
  }
  return out.sort((a, b) => a.ts.localeCompare(b.ts) || a.vessel_id.localeCompare(b.vessel_id));
}

/** 位置檔的物件鍵（E3：與 aisstream spike 同一個入口，source=sim）/ Lake key for a position window. */
export function positionsKey(windowStartMs: number): string {
  const d = new Date(windowStartMs);
  const hhmm = `${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}`;
  return `raw/positions/source=sim/dt=${d.toISOString().slice(0, 10)}/${hhmm}.jsonl.gz`;
}

/** 訂艙 API 的 body（POL／POD 由伺服器依批次決定）/ Body for POST /admin/shipments. */
export function bookingBody(p: PlannedShipment) {
  return {
    lot_id: p.lot_id,
    planned_departure: iso(p.etd),
    planned_arrival: iso(p.eta),
    carrier_voyage_number: p.carrier_voyage_number,
    vessel_id: p.vessel_id,
    vessel_name: p.vessel_name,
  };
}

export interface VoyageDryRun {
  readonly date: string;
  readonly timeScale: number;
  /** 當天（台北）訂艙時刻到的貨運 / Shipments whose booking opens that Taipei day. */
  readonly bookings: Array<{ lot_id: string; planned_departure: string; vessel_id: string }>;
  readonly positions: number;
  readonly hash: string;
}

/**
 * 一天（台北日期）的計畫雜湊（SIM-F-009）：本機單元測試與 Lambda 算出相同的值 → 計畫只由（種子、設定、日期）決定。
 * Plan hash for one Taipei day; identical locally and in Lambda.
 */
export function voyageDryRun(seed: string, s: VoyageSettings, date: string, sd: ShipmentSeeds = defaultSeeds()): VoyageDryRun {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`date must be YYYY-MM-DD, got ${date}`);
  const from = Date.parse(`${date}T00:00:00+08:00`);
  if (Number.isNaN(from)) throw new Error(`invalid date ${date}`);
  const to = from + DAY_MS;
  const lead = DWELL_MS + bookingLeadMs(s);
  const bookings = shipmentsDeparting(seed, s, from + lead - cycleMs(sd.cycleDays, s), to + lead + 1, sd)
    .filter((p) => p.bookingOpensAt >= from && p.bookingOpensAt < to)
    .map((p) => ({ lot_id: p.lot_id, planned_departure: iso(p.etd), vessel_id: p.vessel_id, key: p.idempotencyKey }));
  const positions = positionsForWindow(seed, s, from, to, sd);
  const hash = createHash('sha256')
    .update(JSON.stringify({ bookings, positions }))
    .digest('hex');
  return {
    date,
    timeScale: s.timeScale,
    bookings: bookings.map(({ lot_id, planned_departure, vessel_id }) => ({ lot_id, planned_departure, vessel_id })),
    positions: positions.length,
    hash,
  };
}
