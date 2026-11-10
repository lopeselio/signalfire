// The spend policy for a milestone payout and the audit flags. Mirrors contracts/hub (claim_milestone).

export const BURST_MS = 60_000;
export const HOUR_MS = 3_600_000;

export interface PayoutCheck {
  amount: bigint;
  /** the campaign's winning price and what it has paid so far */
  price: bigint;
  paidSoFar: bigint;
  /** the founder's per-payout cap */
  maxPayout: bigint;
  payoutsPerHour: number;
  /** payout timestamps of this startup in the last hour */
  recent: number[];
  lastPayoutMs: number | null;
  nowMs: number;
  /** payouts this creator has received before (any startup) */
  priorPayoutsToPayee: number;
}

export interface PayoutVerdict { outcome: 'paid' | 'held:over_cap' | 'held:rate_limit'; flags: string[] }

export function evaluatePayout(c: PayoutCheck): PayoutVerdict {
  const flags: string[] = [];
  const overCap = c.amount > c.maxPayout || c.paidSoFar + c.amount > c.price;
  const inHour = c.recent.filter((t) => c.nowMs - t < HOUR_MS).length;
  const rateLimited = inHour >= c.payoutsPerHour;
  if (overCap) flags.push('over_cap');
  if (rateLimited) flags.push('rate_limit');
  if (c.lastPayoutMs !== null && c.nowMs - c.lastPayoutMs < BURST_MS) flags.push('burst');
  if (c.priorPayoutsToPayee === 0) flags.push('new_payee');
  return { outcome: overCap ? 'held:over_cap' : rateLimited ? 'held:rate_limit' : 'paid', flags };
}

/** Constraints a founder sets, with the contract's hard limits. */
export interface Constraints {
  campaign_cap: string;
  max_payout: string;
  payouts_per_hour: number;
  min_bid_bps: number;
  min_holder_tokens: string;
}
export const LIMITS = { maxCampaignCap: 1000n * 10n ** 24n, payoutsPerHour: [1, 60], minBidBps: [0, 9000] } as const;
