import { describe, expect, it } from 'vitest';
import { generateKey } from 'near-kit';
import { balanced, base58Decode, base58Encode, implicitOf, signIntents, swapSide, versionedNonce } from '../src/intents.ts';

describe('NEAR Intents helpers', () => {
  it('base58 round-trips, leading zeros included', () => {
    for (const b of [new Uint8Array([0, 0, 1, 2, 255]), new Uint8Array(32).fill(7), new Uint8Array([0])]) expect(base58Decode(base58Encode(b))).toEqual(b);
  });
  it('lays out a V1 versioned nonce', () => {
    const n = versionedNonce('e70c3e74', 1_700_000_000_000, new Uint8Array(15).fill(9));
    expect(n.length).toBe(32);
    expect(n.subarray(0, 5).toString('hex')).toBe('5628f6c600');
    expect(n.subarray(5, 9).toString('hex')).toBe('e70c3e74');
    expect(n.readBigUInt64LE(9)).toBe(1_700_000_000_000_000_000n);
    expect([...n.subarray(17)]).toEqual(new Array(15).fill(9));
  });
  it('a swap balances only when both sides mirror each other', () => {
    const a = swapSide({ token: 't', amount: 45_000n }, { token: 'w', amount: 15n }, 'pat.testnet');
    const b = swapSide({ token: 'w', amount: 15n }, { token: 't', amount: 45_000n }, 'desk.testnet');
    expect(balanced([a, b])).toBe(true);
    expect(balanced([a, swapSide({ token: 'w', amount: 14n }, { token: 't', amount: 45_000n }, 'desk.testnet')])).toBe(false);
    expect(a[1]).toEqual({ intent: 'ft_withdraw', token: 'w', receiver_id: 'pat.testnet', amount: '15' });
  });
  it('signs as the key\'s implicit account, with a signature NEP-413 accepts', async () => {
    const k = generateKey();
    const s = signIntents({ privateKey: k.secretKey, saltHex: 'e70c3e74', intents: [], nowMs: 0, random: new Uint8Array(15), verifier: 'v.testnet' });
    const msg = JSON.parse(s.payload.message) as { signer_id: string };
    expect(msg.signer_id).toBe(implicitOf(k.publicKey.toString()));
    expect(s.signature.startsWith('ed25519:')).toBe(true);
    expect(s.public_key).toBe(k.publicKey.toString());
  });
});
