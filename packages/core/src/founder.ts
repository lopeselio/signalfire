// What a founder may set. Mirrors contracts/hub (create_campaign, check_constraints): the web app checks the same
// limits before the wallet signs, so a form error reads the same as the contract's panic.
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { SUPPLY, UNIT, YOCTO } from './curve.ts';
import type { Constraints } from './policy.ts';

export const BRIEF_LIMITS = {
  titleBytes: 80,
  briefBytes: 600,
  target: [1, 10_000],
  windowSecs: [30, 7 * 86_400],
  durationSecs: [60, 90 * 86_400],
} as const;

export interface BriefInput { title: string; brief: string; target: number; budget: bigint; commitSecs: number; revealSecs: number; durationSecs: number }

const inRange = (n: number, [lo, hi]: readonly [number, number]): boolean => Number.isInteger(n) && n >= lo && n <= hi;

/** Problems with a campaign brief (empty when the hub would accept it), given the startup's cap and free treasury. */
export function briefErrors(b: BriefInput, campaignCap: bigint, available: bigint): string[] {
  const e: string[] = [];
  const tb = utf8ToBytes(b.title).length;
  if (tb === 0 || tb > BRIEF_LIMITS.titleBytes) e.push(`title: 1 to ${BRIEF_LIMITS.titleBytes} bytes`);
  if (utf8ToBytes(b.brief).length > BRIEF_LIMITS.briefBytes) e.push(`brief: at most ${BRIEF_LIMITS.briefBytes} bytes`);
  if (!inRange(b.target, BRIEF_LIMITS.target)) e.push('target: 1 to 10000 buyers');
  if (b.budget <= 0n || b.budget > campaignCap) e.push('budget over the campaign cap');
  if (b.budget > available) e.push("budget over the treasury's free balance");
  if (!inRange(b.commitSecs, BRIEF_LIMITS.windowSecs) || !inRange(b.revealSecs, BRIEF_LIMITS.windowSecs)) e.push('windows: 30 s to 7 days');
  if (!inRange(b.durationSecs, BRIEF_LIMITS.durationSecs)) e.push('duration: 1 minute to 90 days');
  return e;
}

/** Problems with a set of constraints (empty when set_constraints would accept them). */
export function constraintErrors(c: Constraints): string[] {
  const e: string[] = [];
  const cap = BigInt(c.campaign_cap);
  if (cap <= 0n || cap > 1000n * YOCTO) e.push('campaign_cap out of range');
  if (BigInt(c.max_payout) <= 0n) e.push('max_payout must be positive');
  if (!inRange(c.payouts_per_hour, [1, 60])) e.push('payouts_per_hour: 1 to 60');
  if (!Number.isInteger(c.min_bid_bps) || c.min_bid_bps < 0 || c.min_bid_bps > 9000) e.push('min_bid_bps: at most 9000');
  const h = BigInt(c.min_holder_tokens);
  if (h < UNIT || h > SUPPLY / 100n) e.push('min_holder_tokens: 1 token to 1% of supply');
  return e;
}
