// Display helpers (pure).
import { UNIT, YOCTO } from './curve.ts';

function fixed(v: bigint, scale: bigint, digits: number): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = a / scale;
  const frac = ((a % scale) * 10n ** BigInt(digits)) / scale;
  let s = `${whole}`;
  if (digits > 0) s += `.${frac.toString().padStart(digits, '0')}`.replace(/0+$/, '').replace(/\.$/, '');
  return (neg ? '-' : '') + s;
}

export const fmtNear = (yocto: bigint | string, digits = 4): string => fixed(BigInt(yocto), YOCTO, digits);
export const fmtTokens = (raw: bigint | string, digits = 2): string => fixed(BigInt(raw), UNIT, digits);
export const fmtTusd = (raw: bigint | string, digits = 2): string => fixed(BigInt(raw), 1_000_000n, digits);

/** "1.25" NEAR → yocto. */
export function parseNear(s: string): bigint {
  const m = /^\s*(\d*)(?:\.(\d{0,24}))?\s*$/.exec(s);
  if (!m || (!m[1] && !m[2])) throw new Error(`not a NEAR amount: ${s}`);
  return BigInt(m[1] || '0') * YOCTO + BigInt((m[2] ?? '').padEnd(24, '0') || '0');
}
export function parseTokens(s: string): bigint {
  const m = /^\s*(\d*)(?:\.(\d{0,6}))?\s*$/.exec(s);
  if (!m || (!m[1] && !m[2])) throw new Error(`not a token amount: ${s}`);
  return BigInt(m[1] || '0') * UNIT + BigInt((m[2] ?? '').padEnd(6, '0') || '0');
}
