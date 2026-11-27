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
  /** 握手時伺服器回了 101 以外的狀態（有這個監聽器時 ws 不會再發 error）/ Non-101 handshake response. */
  on(event: 'unexpected-response', cb: (req: unknown, res: { statusCode?: number }) => void): unknown;
  send(data: string): void;
  close(): void;
  terminate?(): void;
}
export type Connect = (url: string) => SocketLike;

/**
 * 握手逾時 30 秒（2026-11-27：10 秒時排程執行 15/16 次 handshake_timeout；手動成功時約 4 秒內）。
 * 3 次 × 30 秒＋退避 3 秒 ≈ 93 秒，仍在函數逾時 150 秒內。
 * Handshake timeout 30 s: at 10 s, 15 of 16 overnight runs timed out in the handshake.
 */
export const HANDSHAKE_TIMEOUT_MS = 30_000;
const realConnect: Connect = (url) =>
  new WebSocket(url, { perMessageDeflate: true, handshakeTimeout: HANDSHAKE_TIMEOUT_MS }) as unknown as SocketLike;

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
  /** 握手完成（open）花了多久；沒開成就沒有 / Time until the handshake completed (open). */
  readonly openMs?: number;
  readonly error?: string;
  /** 這次連線花了多久（毫秒）/ How long this attempt took. */
  readonly ms?: number;
}

/**
 * 錯誤 → 不含機密的短代碼（只用固定字彙；不記訊息全文、網址、標頭）。
 * An error → a short, secret-free code: a Node/OS code (ECONNREFUSED, ETIMEDOUT, ENOTFOUND…),
 * `handshake_timeout`, or the error class name. The message text itself is never logged.
 */
export function errorCode(err: unknown): string {
  const e = err as { code?: unknown; name?: unknown; message?: unknown } | undefined;
  if (typeof e?.code === 'string' && /^[A-Z0-9_]{2,40}$/.test(e.code)) return e.code;
  if (typeof e?.message === 'string' && /handshake has timed out/i.test(e.message)) return 'handshake_timeout';
  if (typeof e?.message === 'string' && /Unexpected server response: \d{3}/.test(e.message)) {
    return `http_${/Unexpected server response: (\d{3})/.exec(e.message)![1]}`;
  }
  return typeof e?.name === 'string' && /^[A-Za-z]{1,40}$/.test(e.name) ? e.name : 'Error';
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
    let openMs: number | undefined;
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
      resolve({ frames, opened, openMs, firstMessageMs, error, ms: now() - started });
    };
    const timer = setTimeout(finish, Math.max(0, deadlineMs - started));
    try {
      socket = connect(AIS_ENDPOINT);
    } catch (err) {
      error = errorCode(err);
      clearTimeout(timer);
      resolve({ frames, opened, error, ms: now() - started });
      return;
    }
    socket.on('open', () => {
      opened = true;
      openMs = now() - started;
      socket.send(subscribeMsg);
    });
    socket.on('message', (data) => {
      const at = now();
      firstMessageMs ??= at - started;
      const text = Buffer.isBuffer(data) ? data.toString('utf8') : Array.isArray(data) ? Buffer.concat(data).toString('utf8') : Buffer.from(data).toString('utf8');
      frames.push({ data: text, at });
    });
    // 錯誤訊息可能含網址或標頭 → 只記短代碼（errorCode）/ Record a short code only (messages may carry URLs or headers).
    socket.on('error', (err) => {
      error ??= errorCode(err);
    });
    // 握手被拒（例如 401／403／429／5xx）：記狀態碼並結束這次連線 / Handshake refused: keep the status, end the attempt.
    socket.on('unexpected-response', (_req, res) => {
      error = `http_${res?.statusCode ?? 'unknown'}`;
      finish();
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
  /** 成功那次連線的握手時間 / Handshake time of the successful attempt. */
  readonly openMs?: number;
  /** 之前失敗的連線（重試時）/ Failed attempts before the successful one. */
  readonly failedAttempts?: ReadonlyArray<{ error: string; opened: boolean; openMs?: number; ms?: number }>;
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
  const attemptLog: Array<{ error: string; opened: boolean; openMs?: number; ms?: number }> = [];
  while (attempts < MAX_ATTEMPTS && d.now() < deadline) {
    attempts++;
    result = await collect(d.connect, subscribeMsg, d.now, deadline);
    if (result.frames.length > 0) break;
    errors.push(result.error ?? 'no_messages');
    attemptLog.push({ error: result.error ?? 'no_messages', opened: result.opened, openMs: result.openMs, ms: result.ms });
    if (attempts < MAX_ATTEMPTS) await d.sleep(backoffMs(attempts));
  }
  if (result.frames.length === 0) {
    logger.error('no AIS messages', { attempts, errors, attemptLog });
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
    openMs: result.openMs,
    ...(attemptLog.length > 0 ? { failedAttempts: attemptLog } : {}),
    connectSeconds: Math.round((d.now() - start) / 100) / 10,
    boxes: boxStats(boxes, uniquePositions.map((record) => ({ record, box: boxOf(boxes, record.lat, record.lon) }))),
    keys: { positions: keys.positions, ...(uniqueStatics.length > 0 ? { static: keys.static } : {}) },
  };
  // F10：只有數量與耗時（boxStats 不含 MMSI、船名、座標）/ Counts and timings only.
  logger.info('ais sample', { ...summary });
  return summary;
};
