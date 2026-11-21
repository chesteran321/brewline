/**
 * 地理計算（純函數）：大圓距離、沿大圓插值、航向、geofence。座標一律 [lat, lon]（度）。
 * Pure geodesy helpers: great-circle distance, interpolation along great circles, bearing, geofences. Coordinates are
 * [lat, lon] in degrees.
 *
 * 用球體近似（半徑 6371 km）：對 geofence（15–20 km）與 ETA 的精度足夠；橢球公式在這裡沒有好處。
 * Spherical Earth (R = 6371 km): accurate enough for 15–20 km geofences and ETAs.
 */

export type LatLon = readonly [number, number];

export const EARTH_RADIUS_KM = 6371;
export const KM_PER_NM = 1.852;

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** 正規化經度到 [-180, 180) / Normalise longitude to [-180, 180). */
export function normLon(lon: number): number {
  const x = ((((lon + 180) % 360) + 360) % 360) - 180;
  return Object.is(x, -0) ? 0 : x;
}

/** 大圓距離（km）/ Great-circle distance in km (haversine). */
export function distanceKm(a: LatLon, b: LatLon): number {
  const [la1, lo1] = [rad(a[0]), rad(a[1])];
  const [la2, lo2] = [rad(b[0]), rad(b[1])];
  const h = Math.sin((la2 - la1) / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin((lo2 - lo1) / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 起始航向（0–360，正北為 0）/ Initial bearing in degrees, 0 = north. */
export function bearingDeg(a: LatLon, b: LatLon): number {
  const [la1, lo1] = [rad(a[0]), rad(a[1])];
  const [la2, lo2] = [rad(b[0]), rad(b[1])];
  const y = Math.sin(lo2 - lo1) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(lo2 - lo1);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/** 大圓上 a → b 的分數 f（0–1）位置；跨換日線也正確 / Point at fraction f along the great circle (antimeridian-safe). */
export function interpolate(a: LatLon, b: LatLon, f: number): LatLon {
  const d = distanceKm(a, b) / EARTH_RADIUS_KM;
  if (d < 1e-12) return [a[0], normLon(a[1])];
  const [la1, lo1] = [rad(a[0]), rad(a[1])];
  const [la2, lo2] = [rad(b[0]), rad(b[1])];
  const A = Math.sin((1 - f) * d) / Math.sin(d);
  const B = Math.sin(f * d) / Math.sin(d);
  const x = A * Math.cos(la1) * Math.cos(lo1) + B * Math.cos(la2) * Math.cos(lo2);
  const y = A * Math.cos(la1) * Math.sin(lo1) + B * Math.cos(la2) * Math.sin(lo2);
  const z = A * Math.sin(la1) + B * Math.sin(la2);
  return [deg(Math.atan2(z, Math.hypot(x, y))), normLon(deg(Math.atan2(y, x)))];
}

/** 折線（航線）與每個點的累積距離 / A polyline with cumulative distances. */
export interface Path {
  readonly points: readonly LatLon[];
  /** cumKm[i] = 起點到 points[i] 的距離 / Distance from the start to points[i]. */
  readonly cumKm: readonly number[];
  readonly lengthKm: number;
}

export function makePath(points: readonly LatLon[]): Path {
  if (points.length < 2) throw new Error('a path needs at least two points');
  const cumKm = [0];
  for (let i = 1; i < points.length; i++) cumKm.push(cumKm[i - 1]! + distanceKm(points[i - 1]!, points[i]!));
  return { points, cumKm, lengthKm: cumKm[cumKm.length - 1]! };
}

/** 沿航線走 km 公里後的位置與當下航向（超出範圍時夾在端點）/ Position and heading after travelling km along the path. */
export function pointAlong(path: Path, km: number): { readonly at: LatLon; readonly cog: number } {
  const x = Math.min(Math.max(km, 0), path.lengthKm);
  let i = 1;
  while (i < path.points.length - 1 && path.cumKm[i]! < x) i++;
  const a = path.points[i - 1]!;
  const b = path.points[i]!;
  const seg = path.cumKm[i]! - path.cumKm[i - 1]!;
  const f = seg > 0 ? (x - path.cumKm[i - 1]!) / seg : 1;
  const at = interpolate(a, b, f);
  return { at, cog: bearingDeg(at, f < 1 ? b : interpolate(a, b, 1)) };
}

/** 位置到航線終點的剩餘距離：找最近的航段後沿航線累加（ETA 用）/ Remaining distance along the path from the nearest leg. */
export function remainingKm(path: Path, at: LatLon): number {
  let best = { i: 1, d: Number.POSITIVE_INFINITY };
  for (let i = 1; i < path.points.length; i++) {
    const d = Math.min(distanceKm(at, path.points[i - 1]!), distanceKm(at, path.points[i]!));
    if (d < best.d) best = { i, d };
  }
  // 從目前位置到該航段終點，再加上之後的航段 / To the end of that leg, plus the legs after it.
  return distanceKm(at, path.points[best.i]!) + (path.lengthKm - path.cumKm[best.i]!);
}

/** 是否在 geofence 內（半徑 km）/ Inside a circular geofence. */
export function within(at: LatLon, centre: LatLon, radiusKm: number): boolean {
  return distanceKm(at, centre) <= radiusKm;
}

export const knotsToKmh = (kn: number) => kn * KM_PER_NM;
