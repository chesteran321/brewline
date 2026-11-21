import { z } from 'zod';

/**
 * SSM `/brewline/<env>/simulator/config`（CDK 管理）與 `state`（只在第一次建立時寫入，ADR-030 D7）。
 * The CDK-managed config parameter and the create-once state parameter.
 */

const Range = z.strictObject({ min: z.number().int().min(0), max: z.number().int().min(0) }).refine((r) => r.min <= r.max, {
  message: 'min must be <= max',
});

export const SimulatorConfigSchema = z.strictObject({
  poolSize: z.number().int().min(1).max(60),
  initialActive: z.number().int().min(1),
  ordersPerDay: Range,
  linesPerOrder: Range,
  kgPerLine: Range,
  duplicateOrderRate: z.number().min(0).max(0.5),
  seed: z.string().min(1).max(64),
  /** 從這個月（YYYY-MM）之後，每月多啟用 1–2 家（SIM-F-001）/ Month after which 1–2 more cafés activate monthly. */
  activationStartMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  /**
   * 模擬航程（P2b，ADR-032 補充 E9／E12）：timeScale 1＝真實時間（Prod）、24＝Dev 壓縮；
   * startDate 之前開始訂艙的貨運不產生（不回補）。
   * Simulated voyages: timeScale 1 = real time, 24 = Dev compression; no shipments before startDate (no backfill).
   */
  voyages: z
    .strictObject({
      timeScale: z.number().int().min(1).max(48),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    })
    .optional(),
});
export type SimulatorConfig = z.infer<typeof SimulatorConfigSchema>;

export const SIMULATOR_STATES = ['paused', 'running'] as const;
export type SimulatorState = (typeof SIMULATOR_STATES)[number];

/** 不認得的值一律當成 paused（fail safe）/ Anything unrecognised counts as paused (fail safe). */
export function parseState(raw: string | undefined): SimulatorState {
  return raw?.trim() === 'running' ? 'running' : 'paused';
}

/** 帳號密碼參數：{ username: password }（SecureString，CMK）/ Credentials parameter. */
export const CredentialsSchema = z.record(z.email(), z.string().min(12));
export type Credentials = z.infer<typeof CredentialsSchema>;
