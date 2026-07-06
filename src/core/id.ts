import { randomBytes } from 'node:crypto';

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32

/**
 * ULID: 48-bit timestamp + 80 bits randomness, lexicographically sortable.
 * Zero-dependency implementation; sortability is what task/claim ordering
 * and deterministic conflict resolution hang off.
 */
export function ulid(now: number = Date.now()): string {
  let ts = now;
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = ENCODING[ts % 32] + time;
    ts = Math.floor(ts / 32);
  }
  const rand = randomBytes(16);
  let entropy = '';
  for (let i = 0; i < 16; i++) {
    entropy += ENCODING[rand[i] % 32];
  }
  return time + entropy;
}

export function isUlid(s: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(s);
}

/** Millisecond timestamp encoded in a ULID. */
export function ulidTime(id: string): number {
  let ts = 0;
  for (let i = 0; i < 10; i++) {
    ts = ts * 32 + ENCODING.indexOf(id[i]);
  }
  return ts;
}
