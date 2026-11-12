import { describe, expect, it } from 'vitest';
import { BID_BOND, YOCTO, bidHash, nearForTusd, tusdFor, bidStage, openingMatches, pitchHash, sealBid, walletRefusal } from '../src/index.ts';

describe('sealed bids for people (same strings as the agents and the hub)', () => {
  const salt = 'ab'.repeat(32);
  const price = 350_000_000_000_000_000_000_000n;
  it('seals to the shared vector', () => {
    const o = sealBid(7, 'creator-nova.signalfire.testnet', price, 'Ten creators, one thread.', salt);
    expect(o.pitchHash).toBe(pitchHash('Ten creators, one thread.'));
    expect(o.hash).toBe('a76c7b9c9cfbc087c74e8f96f26e5d27699d5b75f543a096d4209286d814d854');
    expect(o.price).toBe(price.toString());
    expect(openingMatches(o)).toBe(true);
    expect(openingMatches(o, o.hash)).toBe(true);
  });
  it('rejects an opening that was edited after sealing', () => {
    const o = sealBid(3, 'pat.testnet', price, 'A thread a day.', salt);
    expect(openingMatches({ ...o, price: (price - 1n).toString() })).toBe(false);
    expect(openingMatches({ ...o, pitch: 'A thread a week.' })).toBe(false);
    expect(openingMatches({ ...o, salt: 'cd'.repeat(32) })).toBe(false);
    expect(openingMatches({ ...o, creator: 'pat2.testnet' })).toBe(false);
    expect(openingMatches(o, bidHash(3, 'pat.testnet', price, o.pitchHash, 'x'))).toBe(false);
    expect(openingMatches({ ...o, price: '1.5' })).toBe(false);
    expect(openingMatches({ ...o, salt: 'a'.repeat(129) })).toBe(false);
  });
  it('knows the window', () => {
    const c = { phase: 'bidding', commit_ends_ms: 1000, reveal_ends_ms: 2000 };
    expect(bidStage(c, 999)).toBe('commit');
    expect(bidStage(c, 1000)).toBe('reveal');
    expect(bidStage(c, 1999)).toBe('reveal');
    expect(bidStage(c, 2000)).toBe('settle');
    expect(bidStage({ ...c, phase: 'voting' }, 500)).toBe('closed');
  });
});

describe('hub wallets', () => {
  const w = { balance: (3n * BID_BOND).toString(), cap_tx: YOCTO.toString(), cap_day: (5n * YOCTO).toString(), day_start_ms: 0, day_spent: '0' };
  it('pays a bond within the caps', () => expect(walletRefusal(w, BID_BOND, 10)).toBeNull());
  it('refuses with no wallet, too little NEAR, or over a cap', () => {
    expect(walletRefusal(null, BID_BOND, 10)).toMatch(/no wallet/);
    expect(walletRefusal({ ...w, balance: '1' }, BID_BOND, 10)).toMatch(/not enough/);
    expect(walletRefusal({ ...w, cap_tx: '1' }, BID_BOND, 10)).toMatch(/per-transaction/);
    expect(walletRefusal({ ...w, day_spent: (5n * YOCTO).toString() }, BID_BOND, 10)).toMatch(/24-hour/);
  });
  it('the 24-hour cap resets after a day', () => {
    expect(walletRefusal({ ...w, day_spent: (5n * YOCTO).toString() }, BID_BOND, 24 * 3_600_000)).toBeNull();
  });
});

describe('the desk rate both ways', () => {
  it('round-trips at 1 NEAR = 3 tUSD', () => {
    expect(nearForTusd(3_000_000n)).toBe(10n ** 24n);
    expect(tusdFor(nearForTusd(45_000n))).toBe(45_000n);
    expect(nearForTusd(1n)).toBe(333_333_333_333_333_333n);
  });
});
