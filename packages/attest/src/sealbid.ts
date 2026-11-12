import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';

// Sealing a bid for Signalfire's scorer (outlayer/scorer). The scorer's X25519 key is derived inside an OutLayer TEE
// and published onchain by the hub (get_scorer().bid_key). The ciphertext is bound to the hub, campaign and creator
// (AEAD associated data), so it can't be replayed under another bid. Must match outlayer/scorer/src/main.rs.

const INFO = utf8ToBytes('signalfire-bid-v1');
export const bidAad = (hub: string, campaign: number, creator: string): string => `signalfire|sealed-bid|${hub}|${campaign}|${creator}`;

export interface BidOpening { price: string; pitch_hash: string; salt: string }

/** Encrypts an opening to the scorer's key: hex of ephemeral X25519 key (32) ‖ nonce (24) ‖ ciphertext + tag. */
export function sealBid(scorerKeyHex: string, hub: string, campaign: number, creator: string, o: BidOpening, eph: Uint8Array = randomBytes(32), nonce: Uint8Array = randomBytes(24)): string {
  const shared = x25519.getSharedSecret(eph, hexToBytes(scorerKeyHex));
  const key = hkdf(sha256, shared, undefined, INFO, 32);
  const pt = utf8ToBytes(JSON.stringify({ price: o.price, pitch_hash: o.pitch_hash, salt: o.salt }));
  const ct = xchacha20poly1305(key, nonce, utf8ToBytes(bidAad(hub, campaign, creator))).encrypt(pt);
  return bytesToHex(concatBytes(x25519.getPublicKey(eph), nonce, ct));
}
