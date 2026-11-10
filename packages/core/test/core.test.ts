import { describe, expect, it } from 'vitest';
import {
  A, B, FEE_BPS, FT_STORAGE, SUPPLY, UNIT, YOCTO, attributable, bidHash, cost, credible, evaluatePayout, fmtNear, fmtTokens,
  isLookalike, isqrt, levenshtein, milestoneAmount, normalize, parseNear, parseTokens, pickWinner, pitchHash, priceAt,
  quoteBuy, quoteSell, repBps, reserveAt, score, threshold, tusdFor, unlocked, withSlippage, MIN_ATTRIB,
} from '../src/index.ts';

// The shared vector: contracts/hub/src/tests.rs asserts the very same numbers.
describe('shared vector (must match contracts/hub)', () => {
  it('curve', () => {
    const q = quoteBuy(0n, YOCTO, true);
    expect(q.tokens).toBe(7_197_528_892n);
    expect(q.fee).toBe(19_975_000_000_000_000_000_000n);
    expect(q.cost).toBe(978_774_999_955_873_738_320_000n);
    expect(q.refund).toBe(44_126_261_680_000n);
    const q2 = quoteBuy(7_000_000_000n, YOCTO / 2n, false);
    expect(q2.tokens).toBe(2_672_315_572n);
    expect(q2.refund).toBe(178_231_564_080_000n);
    const s = quoteSell(7_000_000_000n, 1_000_000_000n);
    expect(s.proceeds).toBe(165_000_000_000_000_000_000_000n);
    expect(s.out).toBe(161_700_000_000_000_000_000_000n);
    expect(cost(123_456_789n, 9_876_543_210n)).toBe(1_462_962_963_101_234_567_895_000n);
    expect(priceAt(7_000_000_000n)).toBe(170_000_000_000_000_000_000n);
  });
  it('hashes', () => {
    const ph = pitchHash('Ten creators, one thread.');
    expect(ph).toBe('2b2129bca5cf246ea4fc06c942e18d80b183dd7d2cdf74303f1dc28f1558ff4a');
    expect(bidHash(7, 'creator-nova.signalfire.testnet', 350_000_000_000_000_000_000_000n, ph, 'ab'.repeat(32)))
      .toBe('a76c7b9c9cfbc087c74e8f96f26e5d27699d5b75f543a096d4209286d814d854');
  });
  it('scoring, milestones, tUSD, lookalikes', () => {
    expect(score(350_000_000_000_000_000_000_000n, 1500)).toBe(304_347_826_086_956_521_739_130n);
    expect(score(350_000_000_000_000_000_000_000n, -2000)).toBe(437_500_000_000_000_000_000_000n);
    expect([threshold(10, 1), threshold(10, 2), threshold(10, 3)]).toEqual([4, 7, 10]);
    expect(milestoneAmount(YOCTO, 1)).toBe(333_333_333_333_333_333_333_333n);
    expect(milestoneAmount(YOCTO, 3)).toBe(333_333_333_333_333_333_333_334n);
    expect(tusdFor(333_333_333_333_333_333_333_333n)).toBe(999_999n);
    expect(isLookalike('n0va.signalfire.testnet', 'nova.signalfire.testnet')).toBe(true);
    expect(isLookalike('novas.x', 'nova.x')).toBe(true);
    expect(isLookalike('ember.x', 'nova.x')).toBe(false);
    expect(isLookalike('ivy.x', 'ivo.x')).toBe(false);
  });
});

describe('curve', () => {
  it('isqrt is the floor square root', () => {
    for (const n of [0n, 1n, 2n, 3n, 4n, 15n, 16n, 17n, 10n ** 32n + 12345n, (10n ** 19n + 7n) ** 2n]) {
      const r = isqrt(n);
      expect(r * r <= n && (r + 1n) * (r + 1n) > n).toBe(true);
    }
  });
  it('the reserve is the integral, so any sell-back is covered', () => {
    let x = 0n;
    let reserve = 0n;
    const buys = [YOCTO / 3n, 2n * YOCTO, YOCTO / 10n, 7n * YOCTO];
    for (const g of buys) {
      const q = quoteBuy(x, g, x === 0n);
      expect(q.cost <= q.net).toBe(true);
      expect(q.refund).toBeGreaterThanOrEqual(0n);
      // one more raw unit would cost more than the net: the solve is the floor
      expect(cost(x, x + q.tokens + 1n) > q.net).toBe(true);
      x += q.tokens;
      reserve += q.cost;
      expect(reserve).toBe(reserveAt(x));
    }
    const s = quoteSell(x, x);
    expect(s.proceeds).toBe(reserve);
  });
  it('fee is exactly 2% of what goes into the curve', () => {
    const q = quoteBuy(0n, YOCTO + FT_STORAGE, true);
    expect(q.fee).toBe((YOCTO * FEE_BPS) / 10_000n);
  });
  it('price rises along the line', () => {
    expect(priceAt(0n)).toBe(A * UNIT);
    expect(priceAt(SUPPLY)).toBe((A + B * SUPPLY) * UNIT);
    const q = quoteBuy(0n, YOCTO, true);
    expect(q.priceAfter > priceAt(0n)).toBe(true);
  });
  it('buys stop at the supply cap', () => {
    const q = quoteBuy(SUPPLY - 10n, 1000n * YOCTO, false);
    expect(q.tokens).toBe(10n);
    expect(q.refund > 0n).toBe(true);
  });
  it('rejects bad input', () => {
    expect(() => quoteBuy(0n, FT_STORAGE, true)).toThrow();
    expect(() => quoteSell(5n, 6n)).toThrow();
    expect(() => cost(5n, 4n)).toThrow();
  });
  it('slippage floor', () => {
    expect(withSlippage(10_000n, 100n)).toBe(9_900n);
  });
});

describe('auction', () => {
  const budget = 2n * YOCTO;
  it('reputation clamps', () => {
    expect(repBps(0, 0)).toBe(0);
    expect(repBps(3, 0)).toBe(1500);
    expect(repBps(10, 0)).toBe(3000);
    expect(repBps(0, 5)).toBe(-2000);
    expect(repBps(2, 1)).toBe(0);
  });
  it('credible window', () => {
    expect(credible(budget, budget, 2000)).toBe(true);
    expect(credible(budget + 1n, budget, 2000)).toBe(false);
    expect(credible(budget / 5n, budget, 2000)).toBe(true);
    expect(credible(budget / 5n - 1n, budget, 2000)).toBe(false);
    expect(credible(0n, budget, 0)).toBe(false);
  });
  it('lowest reputation-weighted score wins, ties to the earlier commit', () => {
    const bids = [
      { creator: 'a', price: YOCTO, rep: 0, commitIndex: 0 },
      { creator: 'b', price: (YOCTO * 11n) / 10n, rep: 1500, commitIndex: 1 },
      { creator: 'c', price: YOCTO / 100n, rep: 3000, commitIndex: 2 }, // below the floor: not credible
    ];
    expect(pickWinner(bids, budget, 2000)).toBe(1);
    expect(pickWinner([bids[0], { ...bids[0], creator: 'z', commitIndex: 5 }], budget, 2000)).toBe(0);
    expect(pickWinner([bids[2]], budget, 2000)).toBe(null);
    expect(pickWinner([], budget, 2000)).toBe(null);
  });
  it('a different salt or price gives a different commitment', () => {
    const ph = pitchHash('x');
    const h = bidHash(1, 'a.testnet', YOCTO, ph, 'aa');
    expect(bidHash(1, 'a.testnet', YOCTO, ph, 'ab')).not.toBe(h);
    expect(bidHash(1, 'a.testnet', YOCTO + 1n, ph, 'aa')).not.toBe(h);
    expect(bidHash(2, 'a.testnet', YOCTO, ph, 'aa')).not.toBe(h);
  });
});

describe('milestones and attribution', () => {
  it('unlocks in thirds', () => {
    expect(unlocked(10, 0)).toBe(0);
    expect(unlocked(10, 3)).toBe(0);
    expect(unlocked(10, 4)).toBe(1);
    expect(unlocked(10, 9)).toBe(2);
    expect(unlocked(10, 10)).toBe(3);
    expect(unlocked(1, 1)).toBe(3);
    expect(unlocked(2, 1)).toBe(1);
  });
  it('the three payouts add up to the price', () => {
    for (const p of [YOCTO, 7n, 10n ** 24n + 2n]) expect(milestoneAmount(p, 1) + milestoneAmount(p, 2) + milestoneAmount(p, 3)).toBe(p);
  });
  it('only first-time, funded, non-creator buys of at least 0.05 NEAR count', () => {
    const ok = { gross: MIN_ATTRIB, firstTimeBuyer: true, buyerIsCreator: false, campaignFunded: true };
    expect(attributable(ok)).toBe(true);
    expect(attributable({ ...ok, gross: MIN_ATTRIB - 1n })).toBe(false);
    expect(attributable({ ...ok, firstTimeBuyer: false })).toBe(false);
    expect(attributable({ ...ok, buyerIsCreator: true })).toBe(false);
    expect(attributable({ ...ok, campaignFunded: false })).toBe(false);
  });
});

describe('spend policy', () => {
  const base = { amount: YOCTO / 3n, price: YOCTO, paidSoFar: 0n, maxPayout: YOCTO, payoutsPerHour: 3, recent: [], lastPayoutMs: null, nowMs: 10_000_000, priorPayoutsToPayee: 0 };
  it('pays within the caps and flags a new payee', () => {
    expect(evaluatePayout(base)).toEqual({ outcome: 'paid', flags: ['new_payee'] });
  });
  it('holds over the per-payout cap or the campaign price', () => {
    expect(evaluatePayout({ ...base, maxPayout: YOCTO / 4n }).outcome).toBe('held:over_cap');
    expect(evaluatePayout({ ...base, paidSoFar: YOCTO }).outcome).toBe('held:over_cap');
  });
  it('holds over the hourly rate and flags bursts', () => {
    const v = evaluatePayout({ ...base, recent: [9_990_000, 9_000_000, 8_000_000], lastPayoutMs: 9_990_000, priorPayoutsToPayee: 2 });
    expect(v).toEqual({ outcome: 'held:rate_limit', flags: ['rate_limit', 'burst'] });
    // a payout older than an hour no longer counts
    expect(evaluatePayout({ ...base, recent: [1_000, 9_000_000, 8_000_000], priorPayoutsToPayee: 1 }).outcome).toBe('paid');
  });
});

describe('names and formatting', () => {
  it('normalizes look-alike digits', () => {
    expect(normalize('N0V4-1.testnet')).toBe('nov4-l');
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(isLookalike('quill.x', 'quil1.x')).toBe(true);
    expect(isLookalike('same.x', 'same.x')).toBe(false);
  });
  it('formats and parses amounts', () => {
    expect(fmtNear(YOCTO + YOCTO / 2n)).toBe('1.5');
    expect(fmtNear(0n)).toBe('0');
    expect(fmtTokens(7_197_528_892n)).toBe('7197.52');
    expect(parseNear('1.25')).toBe(1_250_000_000_000_000_000_000_000n);
    expect(parseNear('.5')).toBe(YOCTO / 2n);
    expect(parseTokens('3.000001')).toBe(3_000_001n);
    expect(() => parseNear('abc')).toThrow();
  });
});
