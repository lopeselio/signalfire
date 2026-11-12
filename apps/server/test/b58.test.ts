import { describe, expect, it } from 'vitest';
import { b58decode, b58encode, implicitOf, txHashOf } from '../src/b58.ts';

describe('base58', () => {
  it('round-trips and matches NEAR’s keys and hashes', () => {
    // the contract test vector (near-api-js): key, implicit account, block hash
    expect(implicitOf('ed25519:GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB')).toBe('ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c');
    expect(b58encode(new Uint8Array(32).fill(9))).toBe('cGfHiC6Kgg3FpFZvgwGcswsCRtp4aBP2fzuXRQPizuN');
    expect(Buffer.from(b58decode('cGfHiC6Kgg3FpFZvgwGcswsCRtp4aBP2fzuXRQPizuN')).toString('hex')).toBe('09'.repeat(32));
    expect(b58encode(Uint8Array.from([0, 0, 1]))).toBe('112');
    expect(Array.from(b58decode('112'))).toEqual([0, 0, 1]);
    expect(txHashOf('00'.repeat(32))).toBe('1'.repeat(32));
  });
});
