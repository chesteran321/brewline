import { z } from 'zod';
import lotRoutesJson from '../seed/lot-routes.json';
import portsJson from '../seed/ports.json';
import routesJson from '../seed/routes.json';
import { LatLon, Path, makePath } from './geo';

/**
 * 海運種子資料（P2b-1，ADR-032 補充 E1）：港口、航線、批次 → 航線。部署時打包進函數，執行時不讀資料庫。
 * Shipment seed data: ports, routes and lot → route. Bundled into the functions; never read from the table.
 *
 * - 港口代碼：只用 ports.json 列出的 UN/LOCODE（DS-09）。
 * - 座標：World Port Index（公有領域，DS-10）；`coordinates_status` 為 provisional 時是暫定值。
 * - TW 批次（L-2026-008）不在 lot-routes → 沒有海運（訂艙 400 no_sea_route）。
 */

export const UnLocodeSchema = z.string().regex(/^[A-Z]{2}[A-Z2-9]{3}$/);
const Lat = z.number().min(-90).max(90);
const Lon = z.number().min(-180).max(180);

const PortSchema = z.strictObject({
  locode: UnLocodeSchema,
  name: z.string().min(1).max(60),
  country: z.string().regex(/^[A-Z]{2}$/),
  lat: Lat,
  lon: Lon,
  role: z.enum(['origin', 'destination', 'spike_only']),
  /** World Port Index 編號（coordinates_status = wpi 時必填）/ WPI number, required once coordinates come from WPI. */
  wpi: z.number().int().positive().optional(),
});
export type Port = z.infer<typeof PortSchema>;

const PortsFileSchema = z.strictObject({
  attribution: z.strictObject({ locodes: z.string(), coordinates: z.string(), coordinates_status: z.enum(['provisional', 'wpi']) }),
  ports: z.array(PortSchema).min(1),
});

const RouteSchema = z.strictObject({
  id: z.string().regex(/^[A-Z]{5}-[A-Z]{5}$/),
  pol: UnLocodeSchema,
  pod: UnLocodeSchema,
  waypoints: z.array(z.tuple([Lat, Lon])).min(1),
});

const RoutesFileSchema = z.strictObject({ attribution: z.string(), routes: z.array(RouteSchema).min(1) });

const LotRouteSchema = z.strictObject({
  lot_id: z.string().regex(/^L-\d{4}-\d{3}$/),
  route: z.string(),
  /** Dev 測試批次（smoke test 用；模擬器不排程）/ Dev test lot: smoke test only, never planned by the simulator. */
  test: z.boolean().optional(),
});
export type LotRoute = z.infer<typeof LotRouteSchema>;

const LotRoutesFileSchema = z.strictObject({
  attribution: z.string(),
  cycleDays: z.number().int().min(7).max(90),
  lots: z.array(LotRouteSchema).min(1),
});

export interface Route {
  readonly id: string;
  readonly pol: Port;
  readonly pod: Port;
  /** 港口＋航點＋港口 / Port, waypoints, port. */
  readonly path: Path;
}

export interface ShipmentSeeds {
  readonly ports: ReadonlyMap<string, Port>;
  readonly routes: ReadonlyMap<string, Route>;
  readonly lotRoutes: ReadonlyMap<string, LotRoute>;
  readonly cycleDays: number;
  readonly coordinatesStatus: 'provisional' | 'wpi';
}

/** 驗證並組合種子；有不一致就丟錯（單元測試與冷啟動都會跑）/ Validate and assemble; throws on any inconsistency. */
export function buildSeeds(raw: { ports: unknown; routes: unknown; lotRoutes: unknown }): ShipmentSeeds {
  const pf = PortsFileSchema.parse(raw.ports);
  const rf = RoutesFileSchema.parse(raw.routes);
  const lf = LotRoutesFileSchema.parse(raw.lotRoutes);
  if (pf.attribution.coordinates_status === 'wpi' && pf.ports.some((p) => p.wpi === undefined)) {
    throw new Error('coordinates_status is wpi but a port has no WPI number');
  }

  const ports = new Map<string, Port>();
  for (const p of pf.ports) {
    if (ports.has(p.locode)) throw new Error(`duplicate port ${p.locode}`);
    ports.set(p.locode, p);
  }
  const routes = new Map<string, Route>();
  for (const r of rf.routes) {
    const pol = ports.get(r.pol);
    const pod = ports.get(r.pod);
    if (!pol || !pod) throw new Error(`route ${r.id} uses an unknown port`);
    if (r.id !== `${r.pol}-${r.pod}`) throw new Error(`route id ${r.id} must be <POL>-<POD>`);
    if (pol.role !== 'origin' || pod.role !== 'destination') throw new Error(`route ${r.id} must go from an origin to a destination port`);
    if (routes.has(r.id)) throw new Error(`duplicate route ${r.id}`);
    const points: LatLon[] = [[pol.lat, pol.lon], ...r.waypoints.map(([la, lo]) => [la, lo] as const), [pod.lat, pod.lon]];
    routes.set(r.id, { id: r.id, pol, pod, path: makePath(points) });
  }
  const lotRoutes = new Map<string, LotRoute>();
  for (const l of lf.lots) {
    if (!routes.has(l.route)) throw new Error(`lot ${l.lot_id} uses an unknown route ${l.route}`);
    if (lotRoutes.has(l.lot_id)) throw new Error(`duplicate lot ${l.lot_id}`);
    lotRoutes.set(l.lot_id, l);
  }
  return { ports, routes, lotRoutes, cycleDays: lf.cycleDays, coordinatesStatus: pf.attribution.coordinates_status };
}

let cached: ShipmentSeeds | undefined;

export function seeds(): ShipmentSeeds {
  cached ??= buildSeeds({ ports: portsJson, routes: routesJson, lotRoutes: lotRoutesJson });
  return cached;
}

/** 批次的航線；沒有海運 → undefined / The lot's route, or undefined when it has no sea leg. */
export function routeForLot(lotId: string, s: ShipmentSeeds = seeds()): Route | undefined {
  const lr = s.lotRoutes.get(lotId);
  return lr ? s.routes.get(lr.route) : undefined;
}
