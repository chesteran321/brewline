import { gzipSync } from 'node:zlib';
import { Logger } from '@aws-lambda-powertools/logger';
import { Tracer } from '@aws-lambda-powertools/tracer';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import WebSocket from 'ws';
import {
  AIS_ENDPOINT,
  Box,
  MAX_ATTEMPTS,
  Parsed,
  StaticRecord,
  backoffMs,
  boxOf,
  boxStats,
  dedupe,
  objectKeys,
  parseMessage,
  portBoxes,
  subscription,
} from '../ais/spike';
import { PositionRecord } from '../model';

/**
 * aisstream 取樣函數（P2b-spike，只在 Dev；ADR-032 D2／D9，spike 規格 F1–F12）。
 * Dev-only aisstream sampler.
 *
 * 讀 SSM 的 API key → 開 WSS（permessage-deflate）→ 3 秒內送訂閱（10 個港口方框、PositionReport＋ShipStaticData）→
 * 收 120 秒 → 關閉 → 正規化、去重 → 兩個 gzip JSON Lines 物件（raw/positions/source=ais/、raw/ais-static/）。
 *
 * - 連線失敗（還沒收到任何訊息就斷線）→ 指數退避最多 3 次（F7）。全部失敗或 0 筆位置 → 丟錯 → shipment-dlq（告警）。
 * - API key 不寫日誌、不放環境變數（只放參數名稱）；日誌只有每個方框的筆數與耗時（F10）。
 */

export const logger = new Logger();
const tracer = new Tracer();

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set`);
  return v;
};

/** 測試用的最小 WebSocket 介面 / Minimal socket surface, so tests can inject a fake. */
export interface SocketLike {
  on(event: 'open', cb: () => void): unknown;
  on(event: 'message', cb: (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
  on(event: 'close', cb: (code: number) => void): unknown;
  send(data: string): void;
  close(): void;
  terminate?(): void;
}
export type Connect = (url: string) => SocketLike;

const realConnect: Connect = (url) => new WebSocket(url, { perMessageDeflate: true, handshakeTimeout: 10_000 }) as unknown as SocketLike;

interface Deps {
  connect: Connect;
  ssm: Pick<SSMClient, 'send'>;
  s3: Pick<S3Client, 'send'>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}
let deps: Deps | undefined;
export function setDepsForTesting(d: Partial<Deps> | undefined): void {
  deps = d === undefined ? undefined : { ...defaults(), ...d };
}
function defaults(): Deps {
  return {
    connect: realConnect,
    ssm: tracer.captureAWSv3Client(new SSMClient({})),
    s3: tracer.captureAWSv3Client(new S3Client({})),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

export interface AttemptResult {
  readonly frames: ReadonlyArray<{ readonly data: string; readonly at: number }>;
  readonly opened: boolean;
  readonly firstMessageMs?: number;
  readonly error?: string;
}

/**
 * 一次連線：open 後立刻送訂閱，收到 deadline 為止。收訊息只把文字放進記憶體（不在這裡解析，F 規格：持續讀取）。
 * One connection: subscribe on open, buffer frames until the deadline. Frames are only buffered here.
 */
export function collect(connect: Connect, subscribeMsg: string, now: () => number, deadlineMs: number): Promise<AttemptResult> {
  return new Promise((resolve) => {
    const frames: Array<{ data: string; at: number }> = [];
    const started = now();
    let opened = false;
    let firstMessageMs: number | undefined;
    let error: string | undefined;
    let done = false;
    let socket: SocketLike;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* 已關閉 / already closed */
      }
      resolve({ frames, opened, firstMessageMs, error });
    };
    const timer = setTimeout(finish, Math.max(0, deadlineMs - started));
    try {
      socket = connect(AIS_ENDPOINT);
    } catch (err) {
      error = (err as Error).name;
      clearTimeout(timer);
      resolve({ frames, opened, error });
      return;
    }
    socket.on('open', () => {
      opened = true;
      socket.send(subscribeMsg);
    });
    socket.on('message', (data) => {
      const at = now();
      firstMessageMs ??= at - started;
      const text = Buffer.isBuffer(data) ? data.toString('utf8') : Array.isArray(data) ? Buffer.concat(data).toString('utf8') : Buffer.from(data).toString('utf8');
      frames.push({ data: text, at });
    });
    // 錯誤訊息可能含網址或標頭 → 只記錯誤類別 / Record only the error class (messages may carry URLs or headers).
    socket.on('error', (err) => {
      error = err.name || 'Error';
    });
    socket.on('close', (code) => {
      error ??= frames.length === 0 ? `closed_${code}` : undefined;
      finish();
    });
  });
}

export interface SampleSummary {
  readonly outcome: 'sampled';
  readonly attempts: number;
  readonly frames: number;
  readonly positions: number;
  readonly statics: number;
  readonly vessels: number;
  readonly skipped: Record<string, number>;
  readonly compression?: boolean;
  readonly firstMessageMs?: number;
  readonly connectSeconds: number;
  readonly boxes: ReturnType<typeof boxStats>;
  readonly keys: { positions: string; static?: string };
}

export const handler = async (): Promise<SampleSummary> => {
  const d = deps ?? (deps = defaults());
  const bucket = env('LAKE_BUCKET');
  const paramName = env('AIS_KEY_PARAM');
  const collectSeconds = Number(process.env.COLLECT_SECONDS ?? '120');
  if (!Number.isFinite(collectSeconds) || collectSeconds < 5 || collectSeconds > 130) throw new Error('COLLECT_SECONDS must be 5–130');

  const start = d.now();
  const deadline = start + collectSeconds * 1000;
  const res = await d.ssm.send(new GetParameterCommand({ Name: paramName, WithDecryption: true }));
  const apiKey = res.Parameter?.Value;
  if (!apiKey) throw new Error('API key parameter is empty');
  const boxes: Box[] = portBoxes();
  const subscribeMsg = JSON.stringify(subscription(apiKey, boxes));

  // F7：還沒收到任何訊息就失敗 → 退避後重試，最多 3 次；收過訊息之後的斷線不重試（用已收到的資料）
  let attempts = 0;
  let result: AttemptResult = { frames: [], opened: false };
  const errors: string[] = [];
  while (attempts < MAX_ATTEMPTS && d.now() < deadline) {
    attempts++;
    result = await collect(d.connect, subscribeMsg, d.now, deadline);
    if (result.frames.length > 0) break;
    errors.push(result.error ?? 'no_messages');
    if (attempts < MAX_ATTEMPTS) await d.sleep(backoffMs(attempts));
  }
  if (result.frames.length === 0) {
    logger.error('no AIS messages', { attempts, errors });
    throw new Error(`no AIS messages after ${attempts} attempt(s): ${errors.join(', ')}`);
  }

  // 解析（連線結束後才做）/ Parse after the connection is closed.
  const positions: Array<{ record: PositionRecord; box?: string }> = [];
  const statics: StaticRecord[] = [];
  const skipped: Record<string, number> = {};
  let compression: boolean | undefined;
  for (const f of result.frames) {
    let raw: unknown;
    try {
      raw = JSON.parse(f.data);
    } catch {
      skipped.not_json = (skipped.not_json ?? 0) + 1;
      continue;
    }
    const p: Parsed = parseMessage(raw, f.at, boxes);
    if (p.kind === 'position') positions.push({ record: p.record, box: p.box });
    else if (p.kind === 'static') statics.push(p.record);
    else if (p.kind === 'control') {
      if (p.compression !== undefined) compression = p.compression;
      if (p.error) skipped.server_error = (skipped.server_error ?? 0) + 1;
    } else skipped[p.reason] = (skipped[p.reason] ?? 0) + 1;
  }
  const uniquePositions = dedupe(positions.map((p) => p.record));
  const uniqueStatics = dedupe(statics);
  if (uniquePositions.length === 0) {
    logger.error('no usable positions', { attempts, frames: result.frames.length, skipped });
    throw new Error(`no usable positions in ${result.frames.length} frame(s)`);
  }

  const keys = objectKeys(start);
  const body = (rows: readonly object[]) => gzipSync(`${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  // 不帶加密標頭：bucket 預設加密套用資料層 CMK（DenyWrongKmsKey 只擋帶錯的標頭）/ Default encryption applies the CMK.
  const put = (Key: string, rows: readonly object[]) =>
    d.s3.send(new PutObjectCommand({ Bucket: bucket, Key, Body: body(rows), ContentType: 'application/x-ndjson', ContentEncoding: 'gzip' }));
  await put(keys.positions, uniquePositions);
  if (uniqueStatics.length > 0) await put(keys.static, uniqueStatics);

  const summary: SampleSummary = {
    outcome: 'sampled',
    attempts,
    frames: result.frames.length,
    positions: uniquePositions.length,
    statics: uniqueStatics.length,
    vessels: new Set(uniquePositions.map((r) => r.vessel_id)).size,
    skipped,
    compression,
    firstMessageMs: result.firstMessageMs,
    connectSeconds: Math.round((d.now() - start) / 100) / 10,
    boxes: boxStats(boxes, uniquePositions.map((record) => ({ record, box: boxOf(boxes, record.lat, record.lon) }))),
    keys: { positions: keys.positions, ...(uniqueStatics.length > 0 ? { static: keys.static } : {}) },
  };
  // F10：只有數量與耗時（boxStats 不含 MMSI、船名、座標）/ Counts and timings only.
  logger.info('ais sample', { ...summary });
  return summary;
};
