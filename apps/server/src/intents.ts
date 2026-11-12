import { parseKey } from 'near-kit';

// NEAR Intents (the open-source near/intents Verifier; on testnet we use the author's own deployment,
// `bazaar-intents.testnet`, the same one the Bazaar of Liars settles barters on).
//
// Each party's identity in the Verifier is the implicit account of its own key, so only that key can sign for it.
// An intent is a NEP-413 signed message { signer_id, deadline, intents: [...] } with recipient = the Verifier and a
// versioned nonce: 5628f6c6 ‖ 0x00 ‖ salt (4 bytes, `current_salt`) ‖ deadline (u64 LE, ns) ‖ 15 random bytes.
// The Verifier checks every signature and that each token's diffs sum to zero across the batch, then moves the
// tokens; `ft_withdraw` sends them out to a NEAR account. Nothing settles unless every side's intent does.

export const VERIFIER = process.env.INTENTS_VERIFIER ?? 'bazaar-intents.testnet';
export const NONCE_PREFIX = '5628f6c6';

/** The Verifier's id for a NEP-141 token. */
export const ft = (contract: string): string => `nep141:${contract}`;

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58Encode(bytes: Uint8Array): string {
  let n = BigInt(`0x${Buffer.from(bytes).toString('hex') || '0'}`);
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = `1${out}`; }
  return out;
}
export function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error('not base58');
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const body = n === 0n ? [] : [...Buffer.from(hex, 'hex')];
  const zeros = s.length - s.replace(/^1+/, '').length;
  return Uint8Array.from([...Array(zeros).fill(0), ...body]);
}

/** "ed25519:<b58>" → the implicit account (64 hex) that key controls. */
export function implicitOf(publicKey: string): string {
  const [type, b58] = publicKey.split(':');
  if (type !== 'ed25519' || !b58) throw new Error('expected an ed25519 key');
  return Buffer.from(base58Decode(b58)).toString('hex');
}

export function versionedNonce(saltHex: string, deadlineMs: number, random: Uint8Array): Buffer {
  if (!/^[0-9a-f]{8}$/.test(saltHex) || random.length !== 15) throw new Error('salt: 4 bytes hex, random: 15 bytes');
  const n = Buffer.alloc(32);
  Buffer.from(NONCE_PREFIX, 'hex').copy(n, 0);
  n[4] = 0; // VersionedNonce::V1
  Buffer.from(saltHex, 'hex').copy(n, 5);
  n.writeBigUInt64LE(BigInt(deadlineMs) * 1_000_000n, 9);
  Buffer.from(random).copy(n, 17);
  return n;
}

export type Intent =
  | { intent: 'token_diff'; diff: Record<string, string>; memo?: string }
  | { intent: 'ft_withdraw'; token: string; receiver_id: string; amount: string; memo?: string };

export interface SignedIntent { standard: 'nep413'; payload: { recipient: string; nonce: string; message: string }; public_key: string; signature: string }

/** Signs intents with a key; the signer is that key's implicit account. */
export function signIntents(o: { privateKey: string; saltHex: string; intents: Intent[]; nowMs: number; random: Uint8Array; ttlMs?: number; verifier?: string }): SignedIntent {
  const key = parseKey(o.privateKey);
  const signerId = implicitOf(key.publicKey.toString());
  const deadlineMs = o.nowMs + (o.ttlMs ?? 5 * 60_000);
  const nonce = versionedNonce(o.saltHex, deadlineMs, o.random);
  const recipient = o.verifier ?? VERIFIER;
  const message = JSON.stringify({ signer_id: signerId, deadline: new Date(deadlineMs).toISOString(), intents: o.intents });
  const s = key.signNep413Message!(signerId, { message, recipient, nonce });
  // near-kit returns base64; the Verifier wants "ed25519:<base58>"
  const signature = s.signature.startsWith('ed25519:') ? s.signature : `ed25519:${base58Encode(Buffer.from(s.signature, 'base64'))}`;
  return { standard: 'nep413', payload: { recipient, nonce: nonce.toString('base64'), message }, public_key: s.publicKey, signature };
}

/** One side of a swap: give `give` of one token, get `get` of another, and withdraw what it got to `receiver`. */
export function swapSide(give: { token: string; amount: bigint }, get: { token: string; amount: bigint }, receiver: string, memo?: string): Intent[] {
  return [
    { intent: 'token_diff', diff: { [ft(give.token)]: `-${give.amount}`, [ft(get.token)]: `${get.amount}` }, ...(memo ? { memo } : {}) },
    { intent: 'ft_withdraw', token: get.token, receiver_id: receiver, amount: `${get.amount}` },
  ];
}

/** Do the batch's token_diffs cancel out, token by token? (The Verifier's invariant; checked before we send.) */
export function balanced(sides: Intent[][]): boolean {
  const sum = new Map<string, bigint>();
  for (const side of sides) for (const i of side) {
    if (i.intent !== 'token_diff') continue;
    for (const [t, v] of Object.entries(i.diff)) sum.set(t, (sum.get(t) ?? 0n) + BigInt(v));
  }
  return [...sum.values()].every((v) => v === 0n);
}
