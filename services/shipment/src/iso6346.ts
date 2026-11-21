/**
 * ISO 6346 貨櫃號（SIM-F-005）：擁有者代碼 3 碼＋設備類別 1 碼（U＝貨櫃）＋流水號 6 碼＋檢查碼 1 碼。
 * ISO 6346 container numbers: owner code (3) + equipment category (U) + serial (6) + check digit.
 *
 * 擁有者代碼 DMQU：2026-11-21 在 BIC 公開查詢確認查無登記（對照組 MSKU 查得到）；備用 XBWU。
 * 「查無」只是當下的證據 → 貨櫃號只存在 DynamoDB 與 staff API，不出現在事件、公開頁、日誌（ADR-032 補充，E10）。
 * Owner code DMQU was not registered in the public BIC search on 2026-11-21 (control MSKU was). Not a guarantee,
 * so container numbers stay out of events, public pages and logs.
 */

export const DEMO_OWNER_CODE = 'DMQ';
export const CONTAINER_CATEGORY = 'U';

const LETTER_VALUES: Readonly<Record<string, number>> = (() => {
  // A=10，跳過 11 的倍數（11、22、33）/ A = 10, skipping multiples of 11.
  const out: Record<string, number> = {};
  let v = 10;
  for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    if (v % 11 === 0) v++;
    out[ch] = v++;
  }
  return out;
})();

const BODY = /^[A-Z]{3}[UJZ]\d{6}$/;
export const CONTAINER_NUMBER = /^[A-Z]{3}[UJZ]\d{7}$/;

/** 前 10 碼的檢查碼 / Check digit for the first ten characters. */
export function checkDigit(body: string): number {
  if (!BODY.test(body)) throw new Error('ISO 6346 body must be 3 letters + U/J/Z + 6 digits');
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const ch = body[i]!;
    const v = i < 4 ? LETTER_VALUES[ch]! : Number(ch);
    sum += v * 2 ** i;
  }
  return (sum % 11) % 10;
}

export function isValidContainerNumber(n: string): boolean {
  return CONTAINER_NUMBER.test(n) && checkDigit(n.slice(0, 10)) === Number(n[10]);
}

/** 由流水號產生示範貨櫃號（DMQU + 6 碼 + 檢查碼）/ Demo container number from a serial. */
export function demoContainerNumber(serial: number): string {
  if (!Number.isInteger(serial) || serial < 0 || serial > 999_999) throw new Error('serial must be 0–999999');
  const body = `${DEMO_OWNER_CODE}${CONTAINER_CATEGORY}${String(serial).padStart(6, '0')}`;
  return `${body}${checkDigit(body)}`;
}
