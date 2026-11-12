import { describe, expect, it } from 'vitest';
import { b58encode, b64decode, b64encode, cashOutIntents, checkCashOut, deskIntents, diffsBalance, intentsMessage, intentsNonce, isoUtc, nearForTusd, parseIsoUtc } from '../src/index.ts';

const T = 'tusd.signalfire.testnet', W = 'wrap.testnet', V = 'signalfire-intents.testnet';

describe('intents cash-out', () => {
  it('formats and parses ISO dates like Date does', () => {
    for (const ms of [0, 951782400000, 1794480123456, 4102444799999]) {
      expect(isoUtc(ms)).toBe(new Date(ms).toISOString());
      expect(parseIsoUtc(new Date(ms).toISOString())).toBe(ms);
    }
    expect(Number.isNaN(parseIsoUtc('tomorrow'))).toBe(true);
  });

  it('builds the versioned nonce byte for byte', () => {
    const random = Uint8Array.from({ length: 15 }, (_, i) => i + 1);
    const n = intentsNonce('0a0b0c0d', 1794480000000, random);
    expect(Buffer.from(n).toString('hex')).toBe(
      '5628f6c6' + '00' + '0a0b0c0d' + Buffer.from(new BigUint64Array([1794480000000n * 1_000_000n]).buffer).toString('hex') + Buffer.from(random).toString('hex'));
    expect(() => intentsNonce('zz', 0, random)).toThrow();
  });

  it('encodes base58 and base64 like Node', () => {
    const bytes = Uint8Array.from([0, 0, 1, 2, 250, 255, 7]);
    expect(b64encode(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    expect([...b64decode(Buffer.from(bytes).toString('base64'))]).toEqual([...bytes]);
    expect(b58encode(new TextEncoder().encode('Hello World!'))).toBe('2NEpo7TZRRrLZSi2U');
    expect(b58encode(Uint8Array.from([0x00, 0x01]))).toBe('12');
  });

  it('balances the creator and desk sides at the fixed rate', () => {
    const amount = 65208n;
    const c = cashOutIntents({ tusd: T, wnear: W, amount, receiver: 'pat.testnet' });
    const d = deskIntents({ tusd: T, wnear: W, amount });
    expect(diffsBalance([c, d])).toBe(true);
    expect(c[1]).toEqual({ intent: 'native_withdraw', receiver_id: 'pat.testnet', amount: `${nearForTusd(amount)}` });
    expect(diffsBalance([c])).toBe(false);
  });

  it('accepts only a plain cash-out signed by the account, for the Verifier, due soon', () => {
    const now = 1794480000000, amount = 1000n;
    const msg = intentsMessage('pat.testnet', now + 5 * 60_000, cashOutIntents({ tusd: T, wnear: W, amount, receiver: 'pat.testnet' }));
    const base = { message: msg, recipient: V, verifier: V, account: 'pat.testnet', tusd: T, wnear: W, amount, nowMs: now };
    expect(checkCashOut(base)).toBeNull();
    expect(checkCashOut({ ...base, recipient: 'bazaar-intents.testnet' })).toMatch(/another contract/);
    expect(checkCashOut({ ...base, account: 'eve.testnet' })).toMatch(/another account/);
    expect(checkCashOut({ ...base, amount: 999n })).toMatch(/plain cash-out/);
    expect(checkCashOut({ ...base, nowMs: now + 10 * 60_000 })).toMatch(/deadline/);
    const toEve = intentsMessage('pat.testnet', now + 60_000, cashOutIntents({ tusd: T, wnear: W, amount, receiver: 'eve.testnet' }));
    expect(checkCashOut({ ...base, message: toEve })).toMatch(/plain cash-out/);
  });
});
