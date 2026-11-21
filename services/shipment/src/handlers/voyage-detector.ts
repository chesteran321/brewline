import { gunzipSync } from 'node:zlib';
import { Logger } from '@aws-lambda-powertools/logger';
import { Tracer } from '@aws-lambda-powertools/tracer';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { advance, mergeTrack, pickShipment } from '../detector-core';
import { PositionRecord, PositionRecordSchema } from '../model';
import { ShipmentSeeds, seeds } from '../seeds';
import { ShipmentRepo } from '../shipment-repo';

/**
 * 航次偵測函數（P2b-2，ADR-032 補充 E3／E5）：lake 的 `raw/positions/` 新物件 → S3 → EventBridge（預設 bus）→ 規則 →
 * 這個函數。讀 JSON Lines（GZIP）→ 依船分組 → 找出船目前的貨運 → `advance()` → 一個交易寫回 DynamoDB。
 * `Vessel*` 事件由 Streams 發布（E6），這個函數沒有 events:PutEvents。
 * Voyage detector: new raw/positions/ objects arrive through S3 → EventBridge → rule. Groups positions by vessel,
 * advances each vessel's shipment and writes it back in one transaction. Vessel events come from Streams.
 *
 * - 格式錯誤的檔案（任何一行不合格）→ 丟錯 → Lambda 重試 2 次 → shipment-dlq（告警）。不默默略過壞資料。
 * - 沒有對應貨運的船（還沒訂艙、aisstream 的真實船）→ 略過，只記數量。
 * - 日誌只記數量、貨運 ID、狀態轉換；不記座標、船 ID、訂艙號（E10）。
 */

export const logger = new Logger();
const tracer = new Tracer();

export const POSITIONS_PREFIX = 'raw/positions/';
export const MAX_OBJECT_BYTES = 10 * 1024 * 1024;
/** 只看最近 120 天開航的貨運 / Only shipments that departed within the last 120 days. */
const LOOKBACK_MS = 120 * 86_400_000;

const EventSchema = z.object({
  'detail-type': z.literal('Object Created'),
  detail: z.object({
    bucket: z.object({ name: z.string() }),
    object: z.object({ key: z.string(), size: z.number().int().min(0).optional() }),
  }),
});

let repo: ShipmentRepo | undefined;
let s3: S3Client | undefined;
let clock = () => new Date();
let seedData: () => ShipmentSeeds = seeds;

export function setDepsForTesting(d: { repo?: ShipmentRepo; s3?: S3Client; now?: () => Date; seeds?: () => ShipmentSeeds } | undefined): void {
  repo = d?.repo;
  s3 = d?.s3;
  clock = d?.now ?? (() => new Date());
  seedData = d?.seeds ?? seeds;
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

/** 解析位置檔：每一行都要合格，否則整個檔案視為壞檔 / Every line must be valid, or the whole file is rejected. */
export function parsePositions(body: Buffer): PositionRecord[] {
  const text = gunzipSync(body).toString('utf8');
  const out: PositionRecord[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error(`line ${i + 1} is not JSON`);
    }
    const p = PositionRecordSchema.safeParse(raw);
    if (!p.success) throw new Error(`line ${i + 1} is not a valid position record`);
    out.push(p.data);
  }
  return out;
}

export interface DetectorSummary {
  readonly outcome: 'processed' | 'ignored';
  readonly positions: number;
  readonly vessels: number;
  readonly unmatchedVessels: number;
  readonly updated: number;
  readonly departures: number;
  readonly arrivals: number;
}

export const handler = async (event: unknown): Promise<DetectorSummary> => {
  const empty = { positions: 0, vessels: 0, unmatchedVessels: 0, updated: 0, departures: 0, arrivals: 0 };
  const parsed = EventSchema.safeParse(event);
  if (!parsed.success) throw new Error('not an S3 Object Created event');
  const { bucket, object } = parsed.data.detail;
  // 規則已經限定 bucket 與前綴；這裡再檢查一次（縱深防禦）/ The rule filters already; check again.
  if (bucket.name !== env('LAKE_BUCKET') || !object.key.startsWith(POSITIONS_PREFIX) || !object.key.endsWith('.jsonl.gz')) {
    logger.warn('object outside the positions prefix ignored');
    return { outcome: 'ignored', ...empty };
  }
  if ((object.size ?? 0) > MAX_OBJECT_BYTES) throw new Error('positions object too large');

  repo ??= new ShipmentRepo(
    DynamoDBDocumentClient.from(tracer.captureAWSv3Client(new DynamoDBClient({})), { marshallOptions: { removeUndefinedValues: true } }),
    env('TABLE_NAME'),
  );
  s3 ??= tracer.captureAWSv3Client(new S3Client({}));

  const res = await s3.send(new GetObjectCommand({ Bucket: bucket.name, Key: object.key }));
  const bytes = Buffer.from(await res.Body!.transformToByteArray());
  if (bytes.length > MAX_OBJECT_BYTES) throw new Error('positions object too large');
  const positions = parsePositions(bytes);

  const byVessel = new Map<string, PositionRecord[]>();
  for (const p of positions) byVessel.set(p.vessel_id, [...(byVessel.get(p.vessel_id) ?? []), p]);

  const now = clock();
  const sd = seedData();
  const since = new Date(now.getTime() - LOOKBACK_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');
  let unmatched = 0;
  let updated = 0;
  let departures = 0;
  let arrivals = 0;
  for (const [vesselId, list] of byVessel) {
    list.sort((a, b) => a.ts.localeCompare(b.ts));
    const candidates = await repo.vesselShipments(vesselId, since);
    const shipment = pickShipment(candidates, Date.parse(list[0]!.ts));
    const route = shipment ? sd.routes.get(shipment.route_id) : undefined;
    if (!shipment || !route) {
      unmatched++;
      continue;
    }
    const r = advance(shipment, route, list, now);
    if (!r.changed) continue;
    const track = r.trackPoints.length > 0 ? mergeTrack(await repo.getTrack(shipment.shipment_id), r.trackPoints) : undefined;
    await repo.applyAdvance(shipment, r, track, now);
    updated++;
    for (const e of r.events) {
      if (e.transportEventTypeCode === 'DEPA') departures++;
      else arrivals++;
      logger.info('transport event', { shipment_id: shipment.shipment_id, code: e.transportEventTypeCode, synthetic: shipment.synthetic === true });
    }
  }
  const summary: DetectorSummary = {
    outcome: 'processed',
    positions: positions.length,
    vessels: byVessel.size,
    unmatchedVessels: unmatched,
    updated,
    departures,
    arrivals,
  };
  logger.info('positions processed', { ...summary });
  return summary;
};
