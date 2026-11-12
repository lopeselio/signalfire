import { describe, expect, it } from 'vitest';
import { SUPPLY, UNIT, YOCTO, briefErrors, constraintErrors, type Constraints } from '../src/index.ts';

// The limits in contracts/hub create_campaign and check_constraints, edge by edge.
describe('campaign brief', () => {
  const ok = { title: 'Night owls', brief: 'Bring students.', target: 3, budget: YOCTO / 10n, commitSecs: 90, revealSecs: 60, durationSecs: 3600 };
  const cap = 2n * YOCTO;
  it('accepts a normal brief', () => expect(briefErrors(ok, cap, YOCTO)).toEqual([]));
  it('budget within the cap and the free treasury', () => {
    expect(briefErrors({ ...ok, budget: 0n }, cap, YOCTO)).toContain('budget over the campaign cap');
    expect(briefErrors({ ...ok, budget: cap + 1n }, cap, 10n * YOCTO)).toContain('budget over the campaign cap');
    expect(briefErrors({ ...ok, budget: YOCTO + 1n }, cap, YOCTO)).toContain("budget over the treasury's free balance");
    expect(briefErrors({ ...ok, budget: YOCTO }, cap, YOCTO)).toEqual([]);
  });
  it('text in bytes, like the contract', () => {
    expect(briefErrors({ ...ok, title: '' }, cap, YOCTO)).toHaveLength(1);
    expect(briefErrors({ ...ok, title: 'x'.repeat(80) }, cap, YOCTO)).toEqual([]);
    expect(briefErrors({ ...ok, title: 'é'.repeat(41) }, cap, YOCTO)).toHaveLength(1); // 82 bytes
    expect(briefErrors({ ...ok, brief: 'x'.repeat(601) }, cap, YOCTO)).toHaveLength(1);
  });
  it('target, windows and duration', () => {
    expect(briefErrors({ ...ok, target: 0 }, cap, YOCTO)).toHaveLength(1);
    expect(briefErrors({ ...ok, target: 10_000 }, cap, YOCTO)).toEqual([]);
    expect(briefErrors({ ...ok, target: 10_001 }, cap, YOCTO)).toHaveLength(1);
    expect(briefErrors({ ...ok, commitSecs: 29 }, cap, YOCTO)).toHaveLength(1);
    expect(briefErrors({ ...ok, revealSecs: 7 * 86_400 + 1 }, cap, YOCTO)).toHaveLength(1);
    expect(briefErrors({ ...ok, durationSecs: 59 }, cap, YOCTO)).toHaveLength(1);
    expect(briefErrors({ ...ok, durationSecs: 90 * 86_400 }, cap, YOCTO)).toEqual([]);
  });
});

describe('founder constraints', () => {
  const ok: Constraints = { campaign_cap: (2n * YOCTO).toString(), max_payout: YOCTO.toString(), payouts_per_hour: 6, min_bid_bps: 2000, min_holder_tokens: (100n * UNIT).toString() };
  it('accepts the defaults', () => expect(constraintErrors(ok)).toEqual([]));
  it('enforces each hard limit', () => {
    expect(constraintErrors({ ...ok, campaign_cap: '0' })).toEqual(['campaign_cap out of range']);
    expect(constraintErrors({ ...ok, campaign_cap: (1000n * YOCTO + 1n).toString() })).toEqual(['campaign_cap out of range']);
    expect(constraintErrors({ ...ok, max_payout: '0' })).toEqual(['max_payout must be positive']);
    expect(constraintErrors({ ...ok, payouts_per_hour: 0 })).toEqual(['payouts_per_hour: 1 to 60']);
    expect(constraintErrors({ ...ok, payouts_per_hour: 61 })).toEqual(['payouts_per_hour: 1 to 60']);
    expect(constraintErrors({ ...ok, min_bid_bps: 9001 })).toEqual(['min_bid_bps: at most 9000']);
    expect(constraintErrors({ ...ok, min_bid_bps: 0 })).toEqual([]);
    expect(constraintErrors({ ...ok, min_holder_tokens: (UNIT - 1n).toString() })).toHaveLength(1);
    expect(constraintErrors({ ...ok, min_holder_tokens: (SUPPLY / 100n).toString() })).toEqual([]);
    expect(constraintErrors({ ...ok, min_holder_tokens: (SUPPLY / 100n + 1n).toString() })).toHaveLength(1);
  });
});
