import { LatLon, bearingDeg, distanceKm, interpolate, makePath, normLon, pointAlong, remainingKm, within } from '../src/geo';
import { checkDigit, demoContainerNumber, isValidContainerNumber } from '../src/iso6346';
import { buildSeeds, routeForLot, seeds } from '../src/seeds';
import lotRoutesJson from '../seed/lot-routes.json';
import portsJson from '../seed/ports.json';
import routesJson from '../seed/routes.json';

describe('ISO 6346', () => {
  test('known public example CSQU 305438 3', () => {
    expect(checkDigit('CSQU305438')).toBe(3);
    expect(isValidContainerNumber('CSQU3054383')).toBe(true);
    expect(isValidContainerNumber('CSQU3054384')).toBe(false); // 反向：檢查碼錯 / wrong check digit
  });
  test('demo numbers use the DMQU owner code and a valid check digit', () => {
    for (const serial of [0, 1, 123, 999_999, 424_242]) {
      const n = demoContainerNumber(serial);
      expect(n).toMatch(/^DMQU\d{7}$/);
      expect(isValidContainerNumber(n)).toBe(true);
    }
  });
  test('rejects bad input', () => {
    expect(() => demoContainerNumber(1_000_000)).toThrow();
    expect(() => demoContainerNumber(-1)).toThrow();
    expect(() => checkDigit('DMQX000001')).toThrow(); // 類別碼只能是 U／J／Z / category must be U/J/Z
    expect(isValidContainerNumber('dmqu0000010')).toBe(false);
  });
});

describe('geo', () => {
  const taipei: LatLon = [25.03, 121.56];
  const kaohsiung: LatLon = [22.61, 120.28];
  test('distance and bearing are sane', () => {
    const d = distanceKm(taipei, kaohsiung);
    expect(d).toBeGreaterThan(280);
    expect(d).toBeLessThan(310);
    const b = bearingDeg(taipei, kaohsiung);
    expect(b).toBeGreaterThan(180);
    expect(b).toBeLessThan(230);
    expect(distanceKm(taipei, taipei)).toBe(0);
  });
  test('interpolation across the antimeridian stays on the short arc', () => {
    const mid = interpolate([16, 175], [16, -175], 0.5);
    expect(Math.abs(Math.abs(mid[1]) - 180)).toBeLessThan(0.01);
    expect(normLon(190)).toBe(-170);
    expect(normLon(-180)).toBe(-180);
  });
  test('pointAlong and remainingKm agree with the path length', () => {
    const path = makePath([[0, 0], [0, 10], [10, 10]]);
    expect(pointAlong(path, 0).at).toEqual([0, 0]);
    const end = pointAlong(path, path.lengthKm * 2).at; // 超出 → 夾在終點 / clamped
    expect(distanceKm(end, [10, 10])).toBeLessThan(0.001);
    const mid = pointAlong(path, path.cumKm[1]! / 2);
    expect(Math.abs(remainingKm(path, mid.at) - (path.lengthKm - path.cumKm[1]! / 2))).toBeLessThan(1);
    expect(within([0, 0.1], [0, 0], 15)).toBe(true);
    expect(within([0, 0.2], [0, 0], 15)).toBe(false);
  });
});

describe('seeds', () => {
  const s = seeds();
  test('10 ports (E1), 8 routes, 9 lots; TW lot has no sea leg', () => {
    expect(s.ports.size).toBe(10);
    expect([...s.ports.keys()].sort()).toEqual(['BRSSZ', 'COBUN', 'DJJIB', 'GTPRQ', 'IDBLW', 'KEMBA', 'PABLB', 'TWKEL', 'TWKHH', 'VNSGN']);
    expect(s.routes.size).toBe(8);
    expect(routeForLot('L-2026-008')).toBeUndefined(); // 阿里山 / Alishan
    expect(routeForLot('L-2026-001')?.id).toBe('DJJIB-TWKEL');
    expect(routeForLot('L-9999-002')?.id).toBe('BRSSZ-TWKHH');
    expect(s.ports.get('VNSGN')?.role).toBe('spike_only');
  });
  test('coordinates are still provisional until the WPI values replace them', () => {
    expect(s.coordinatesStatus).toBe('provisional');
  });
  test('rejects inconsistent seeds', () => {
    const bad = (mut: (x: { ports: any; routes: any; lotRoutes: any }) => void) => {
      const raw = JSON.parse(JSON.stringify({ ports: portsJson, routes: routesJson, lotRoutes: lotRoutesJson }));
      mut(raw);
      return () => buildSeeds(raw);
    };
    expect(bad(() => undefined)).not.toThrow();
    expect(bad((r) => r.lotRoutes.lots.push({ lot_id: 'L-2026-099', route: 'NOPE-NOPE' }))).toThrow();
    expect(bad((r) => r.routes.routes.push({ ...r.routes.routes[0], id: 'TWKHH-DJJIB', pol: 'TWKHH', pod: 'DJJIB' }))).toThrow();
    expect(bad((r) => r.ports.ports.push(r.ports.ports[0]))).toThrow();
    expect(bad((r) => (r.ports.ports[0].locode = 'dj1ib'))).toThrow();
  });

  // 粗略的陸地框：抽樣航線上的點不得落在框內（港口 30 km 內除外）。不是精確的海岸線，只抓明顯畫錯的航點。
  // Coarse land boxes: sampled route points must avoid them (except within 30 km of a port). Catches gross waypoint errors.
  const LAND: Array<[string, number, number, number, number]> = [
    ['Sri Lanka', 6.2, 9.6, 79.9, 81.7],
    ['India', 8.5, 22, 73.5, 87],
    ['Arabia', 13, 22, 43, 55],
    ['Somalia', 2, 11.5, 42, 49],
    ['Socotra', 12.3, 12.7, 53.3, 54.6],
    ['Abd al Kuri', 12.1, 12.25, 52, 52.45],
    ['Maldives', -0.8, 7.2, 72.6, 73.8],
    ['Madagascar', -25.3, -12.2, 43.5, 50.3],
    ['South Africa W', -34.8, -29, 17, 20],
    ['South Africa S', -34.2, -30, 20, 26],
    ['South Africa SE', -33.5, -29, 26, 30],
    ['South Africa E', -31, -26.5, 30, 32.8],
    ['Aceh', 3.5, 5.2, 95.2, 97.5],
    ['Malay Peninsula', 3.2, 6.4, 101, 103.4],
    ['Borneo', 1, 6.5, 109.5, 118.5],
    ['Vietnam', 10.4, 17, 106, 109.3],
    ['Hainan', 18.2, 20.1, 108.6, 111],
    ['Paracels', 15.7, 17.1, 111.2, 112.8],
    ['Luzon', 12.5, 18.6, 119.8, 124.3],
    ['Batanes', 20.2, 21.1, 121.7, 122.1],
    ['Taiwan S', 22, 22.6, 120.6, 121],
    ['Taiwan C', 22.6, 24, 120.4, 121.6],
    ['Taiwan N', 24, 25.1, 120.9, 121.9],
    ['Penghu', 23.2, 23.8, 119.3, 119.7],
    ['Yaeyama', 24.2, 24.6, 122.9, 124.4],
    ['Marianas', 13.2, 20.6, 144.6, 146.1],
    ['Wake', 19.2, 19.4, 166.5, 166.7],
    ['Johnston', 16.6, 16.8, -169.6, -169.4],
    ['Hawaii', 18.9, 22.3, -160.3, -154.8],
    ['Mexico', 14.6, 32, -118, -92.3],
    ['Central America', 8, 13, -87.5, -83],
    ['Azuero', 7.25, 8.2, -81, -80],
    ['Clipperton', 10.2, 10.4, -109.3, -109.1],
    ['Galapagos', -1.5, 0.7, -92, -89],
  ];
  test.each([...seeds().routes.values()].map((r) => [r.id, r] as const))('route %s avoids the coarse land boxes', (_id, route) => {
    const hits: string[] = [];
    for (let km = 0; km <= route.path.lengthKm; km += 25) {
      const { at } = pointAlong(route.path, km);
      if (distanceKm(at, [route.pol.lat, route.pol.lon]) < 30 || distanceKm(at, [route.pod.lat, route.pod.lon]) < 30) continue;
      for (const [name, la1, la2, lo1, lo2] of LAND) {
        if (at[0] >= la1 && at[0] <= la2 && at[1] >= lo1 && at[1] <= lo2) hits.push(`${name}@${at[0].toFixed(2)},${at[1].toFixed(2)}`);
      }
    }
    expect(hits.slice(0, 5)).toEqual([]);
  });
});
