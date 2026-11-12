// A creator cashes tUSD out for NEAR through the NEAR Intents Verifier (the open-source near/intents contract).
// Isomorphic (browser + Node), no randomness inside: callers pass the random bytes.
//
// The creator's side, signed in their own wallet (NEP-413, recipient = the Verifier):
//   token_diff   −amount tUSD, +nearForTusd(amount) wNEAR
//   native_withdraw  that wNEAR, unwrapped, to the creator's account
// The desk's side, signed by the desk's key: token_diff +amount tUSD, −the same wNEAR. The Verifier settles both in
// one execute_intents, or neither. The rate is the hub's fixed test rate (nearForTusd).

import { nearForTusd } from './milestones.ts';

export const INTENTS_NONCE_PREFIX = '5628f6c6';

/** The Verifier's id for a NEP-141 token. */
export const ftId = (contract: string): string => `nep141:${contract}`;

export type CashIntent =
  | { intent: 'token_diff'; diff: Record<string, string>; memo?: string }
  | { intent: 'native_withdraw'; receiver_id: string; amount: string };

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function b58encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = `1${out}`; }
  return out;
}

export function b64decode(s: string): Uint8Array {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = s.replace(/[^A-Za-z0-9+/]/g, '');
  const out: number[] = [];
  let buf = 0, bits = 0;
  for (const c of clean) {
    buf = (buf << 6) | A.indexOf(c);
    bits += 6;
    if (bits >= 8) { bits -= 8; out.push((buf >> bits) & 0xff); }
  }
  return Uint8Array.from(out);
}

export function b64encode(bytes: Uint8Array): string {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += A[(n >> 18) & 63] + A[(n >> 12) & 63] + (i + 1 < bytes.length ? A[(n >> 6) & 63] : '=') + (i + 2 < bytes.length ? A[n & 63] : '=');
  }
  return out;
}

/** The Verifier's versioned nonce: 5628f6c6 ‖ 0x00 ‖ salt (4 bytes) ‖ deadline (u64 LE, ns) ‖ 15 random bytes. */
export function intentsNonce(saltHex: string, deadlineMs: number, random: Uint8Array): Uint8Array {
  if (!/^[0-9a-f]{8}$/.test(saltHex) || random.length !== 15) throw new Error('salt: 4 bytes hex, random: 15 bytes');
  const n = new Uint8Array(32);
  for (let i = 0; i < 4; i++) n[i] = parseInt(INTENTS_NONCE_PREFIX.slice(i * 2, i * 2 + 2), 16);
  n[4] = 0;
  for (let i = 0; i < 4; i++) n[5 + i] = parseInt(saltHex.slice(i * 2, i * 2 + 2), 16);
  let ns = BigInt(deadlineMs) * 1_000_000n;
  for (let i = 0; i < 8; i++) { n[9 + i] = Number(ns & 0xffn); ns >>= 8n; }
  n.set(random, 17);
  return n;
}

/** The creator's side of a cash-out: give `amount` raw tUSD, get its NEAR at the fixed test rate, paid out as NEAR. */
export function cashOutIntents(o: { tusd: string; wnear: string; amount: bigint; receiver: string }): CashIntent[] {
  const near = nearForTusd(o.amount);
  return [
    { intent: 'token_diff', diff: { [ftId(o.tusd)]: `-${o.amount}`, [ftId(o.wnear)]: `${near}` }, memo: 'Signalfire: tUSD earnings to NEAR' },
    { intent: 'native_withdraw', receiver_id: o.receiver, amount: `${near}` },
  ];
}

/** The desk's side: take the tUSD, give the same wNEAR (kept in the Verifier; the desk has no withdraw). */
export function deskIntents(o: { tusd: string; wnear: string; amount: bigint }): CashIntent[] {
  return [{ intent: 'token_diff', diff: { [ftId(o.wnear)]: `-${nearForTusd(o.amount)}`, [ftId(o.tusd)]: `${o.amount}` }, memo: 'Signalfire desk: buys tUSD at 1 NEAR = 3 tUSD' }];
}

/** Do the token_diffs cancel, token by token? (The Verifier's invariant.) */
export function diffsBalance(sides: CashIntent[][]): boolean {
  const sum = new Map<string, bigint>();
  for (const side of sides) for (const i of side) {
    if (i.intent !== 'token_diff') continue;
    for (const [t, v] of Object.entries(i.diff)) sum.set(t, (sum.get(t) ?? 0n) + BigInt(v));
  }
  return [...sum.values()].every((v) => v === 0n);
}

// ISO-8601 in UTC without Date (core stays deterministic): days from 1970-01-01 ⇄ civil date (H. Hinnant's algorithm)
function civil(days: number): [number, number, number] {
  const z = days + 719468, era = Math.floor(z / 146097), doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100)), mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1, m = mp < 10 ? mp + 3 : mp - 9;
  return [yoe + era * 400 + (m <= 2 ? 1 : 0), m, d];
}
function daysFrom(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y, era = Math.floor(yy / 400), yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1, doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}
const p2 = (n: number, w = 2): string => String(n).padStart(w, '0');
/** 1794480000000 → "2026-11-12T…Z" (the same text as Date.prototype.toISOString). */
export function isoUtc(ms: number): string {
  const days = Math.floor(ms / 86_400_000), rem = ms - days * 86_400_000;
  const [y, mo, d] = civil(days);
  return `${y}-${p2(mo)}-${p2(d)}T${p2(Math.floor(rem / 3_600_000))}:${p2(Math.floor(rem / 60_000) % 60)}:${p2(Math.floor(rem / 1000) % 60)}.${p2(rem % 1000, 3)}Z`;
}
/** "2026-11-12T10:00:00.000Z" → ms, or NaN. */
export function parseIsoUtc(s: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(s);
  if (!m) return Number.NaN;
  return daysFrom(+m[1], +m[2], +m[3]) * 86_400_000 + +m[4] * 3_600_000 + +m[5] * 60_000 + +m[6] * 1000 + +(m[7] ?? '0').padEnd(3, '0');
}

/** The NEP-413 message body the Verifier expects. */
export const intentsMessage = (signerId: string, deadlineMs: number, intents: CashIntent[]): string =>
  JSON.stringify({ signer_id: signerId, deadline: isoUtc(deadlineMs), intents });

/**
 * Is this signed message exactly a cash-out of `amount` tUSD by `account`, to `account`, for the Verifier?
 * The server checks this before co-signing, so a signed message can't be used for anything else.
 */
export function checkCashOut(o: { message: string; recipient: string; verifier: string; account: string; tusd: string; wnear: string; amount: bigint; nowMs: number }): string | null {
  if (o.recipient !== o.verifier) return 'signed for another contract';
  let m: { signer_id?: string; deadline?: string; intents?: unknown };
  try { m = JSON.parse(o.message); } catch { return 'not JSON'; }
  if (m.signer_id !== o.account) return 'signed by another account';
  const d = parseIsoUtc(m.deadline ?? '');
  if (!(d > o.nowMs && d < o.nowMs + 15 * 60_000)) return 'deadline must be within the next 15 minutes';
  if (o.amount <= 0n) return 'nothing to cash out';
  const want = JSON.stringify(cashOutIntents({ tusd: o.tusd, wnear: o.wnear, amount: o.amount, receiver: o.account }));
  if (JSON.stringify(m.intents) !== want) return 'the intents are not a plain cash-out';
  return null;
}
