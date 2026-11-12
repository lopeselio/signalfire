// base58 (Bitcoin alphabet), as NEAR uses it for keys and transaction hashes.
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function b58encode(bytes: Uint8Array): string {
  let n = BigInt(`0x${Buffer.from(bytes).toString('hex') || '0'}`);
  let out = '';
  while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = `1${out}`; }
  return out;
}

export function b58decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error(`not base58: ${c}`);
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const lead = s.match(/^1*/)![0].length;
  return Uint8Array.from([...new Uint8Array(lead), ...(n === 0n ? [] : Buffer.from(hex, 'hex'))]);
}

/** A NEAR transaction hash from the sha256 hex the hub stores. */
export const txHashOf = (hex: string): string => b58encode(Buffer.from(hex, 'hex'));
/** "ed25519:<base58>" → the implicit account id (hex of the key). */
export const implicitOf = (key: string): string => Buffer.from(b58decode(key.replace(/^ed25519:/, ''))).toString('hex');
