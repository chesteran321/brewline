import { randomBytes } from 'node:crypto';

/**
 * ULID（Crockford Base32，26 字元：48 bit 毫秒時間 + 80 bit 亂數）。字典順序 = 時間順序，
 * 所以 `ORDER#<ULID>` 排序就是建立順序（ADR-025）。
 * ULID: 26 Crockford Base32 chars (48-bit ms timestamp + 80 random bits). Lexicographic order is time order.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function ulid(nowMs: number = Date.now(), random: Buffer = randomBytes(10)): string {
  if (!Number.isInteger(nowMs) || nowMs < 0 || nowMs > 2 ** 48 - 1) throw new Error('ULID timestamp out of range');
  if (random.length !== 10) throw new Error('ULID needs 10 random bytes');
  let time = '';
  let t = nowMs;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  // 80 bit → 16 個 5-bit 字元 / 80 bits → 16 five-bit characters.
  let bits = 0n;
  for (const b of random) bits = (bits << 8n) | BigInt(b);
  let rand = '';
  for (let i = 0; i < 16; i++) {
    rand = ALPHABET[Number(bits & 31n)] + rand;
    bits >>= 5n;
  }
  return time + rand;
}
