import { readFileSync } from 'node:fs';
import { x25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { sealBid } from '../src/index.ts';

// The Rust scorer's test opens exactly this ciphertext (outlayer/scorer/test/sealed-vector.hex).
describe('sealed bids for the OutLayer scorer', () => {
  it('produces the vector the Rust scorer opens', () => {
    const scorerPub = bytesToHex(x25519.getPublicKey(new Uint8Array(32).fill(7)));
    const hex = sealBid(scorerPub, 'signalfire.testnet', 7, 'nova.testnet', { price: '600000000000000000000000', pitch_hash: 'ab'.repeat(32), salt: 's1' }, new Uint8Array(32).fill(9), new Uint8Array(24).fill(5));
    const vector = readFileSync(new URL('../../../outlayer/scorer/test/sealed-vector.hex', import.meta.url), 'utf8').trim();
    expect(hex).toBe(vector);
    expect(bytesToHex(sha256(utf8ToBytes(hex))).length).toBe(64);
  });
});
