import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { sha256Hex } from './measure.ts';
import type { Check, ModelVerification, SignedReply } from './types.ts';

// A reply's provider_tee signature: EIP-191 ECDSA over `${model}:${sha256(request)}:${sha256(response)}`
// (docs.near.ai, "NEAR AI Cloud gateway response signatures"). Its signer must match exactly one verified report.

/** Recovers the Ethereum-style address that signed `text` (EIP-191 personal message). */
export function recoverAddress(text: string, signatureHex: string): string {
  const sig = hexToBytes(signatureHex.replace(/^0x/, ''));
  if (sig.length !== 65) throw new Error('signature is not 65 bytes');
  const msg = utf8ToBytes(text);
  const digest = keccak_256(concatBytes(utf8ToBytes(`\x19Ethereum Signed Message:\n${msg.length}`), msg));
  const v = sig[64] >= 27 ? sig[64] - 27 : sig[64];
  const pub = secp256k1.recoverPublicKey(concatBytes(new Uint8Array([v]), sig.subarray(0, 64)), digest, { prehash: false });
  const full = secp256k1.Point.fromBytes(pub).toBytes(false);
  return `0x${bytesToHex(keccak_256(full.subarray(1)).subarray(12))}`;
}

export function replyChecks(r: SignedReply, v: ModelVerification | null): Check[] {
  if (!r.signature || !r.signedText || !r.signingAddress) return [{ id: 'reply.signed', label: 'The reply carries a TEE signature', ok: false, detail: 'unsigned (written without NEAR AI)' }];
  const want = `${r.model}:${sha256Hex(r.request)}:${sha256Hex(r.response)}`;
  let who = '';
  try { who = recoverAddress(r.signedText, r.signature); } catch { /* fails below */ }
  const matches = v ? v.candidates.filter((c) => c.ok && c.signingAddress.toLowerCase() === who) : [];
  return [
    { id: 'reply.payload', label: 'The signature covers this exact request and reply (their sha256 hashes)', ok: r.signedText === want },
    { id: 'reply.signer', label: 'The signature recovers to the model’s signing address', ok: who !== '' && who === r.signingAddress.toLowerCase(), detail: who || undefined },
    { id: 'reply.attested', label: 'That address belongs to exactly one TEE report verified above', ok: matches.length === 1, detail: v ? `${matches.length} match(es)` : 'no verified report' },
  ];
}
