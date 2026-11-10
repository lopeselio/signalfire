// Campaign auctions: who wins a sealed-bid auction. Mirrors contracts/hub (settle_auction).

/** Reputation in basis points: +500 per completed campaign, −1000 per miss, clamped to [−2000, 3000]. */
export function repBps(completed: number, missed: number): number {
  return Math.max(-2000, Math.min(3000, 500 * completed - 1000 * missed));
}

/** Lower is better: the price discounted by reputation. Integer division, as in the contract. */
export const score = (price: bigint, rep: number): bigint => (price * 10_000n) / BigInt(10_000 + rep);

/** A bid is credible when it's within [budget·minBidBps/10⁴, budget]. */
export const credible = (price: bigint, budget: bigint, minBidBps: number): boolean =>
  price > 0n && price <= budget && price >= (budget * BigInt(minBidBps)) / 10_000n;

export interface RevealedBid { creator: string; price: bigint; rep: number; commitIndex: number }

/** Index (into `bids`) of the winner, or null if no bid is credible. Ties go to the earlier commit. */
export function pickWinner(bids: RevealedBid[], budget: bigint, minBidBps: number): number | null {
  let best: number | null = null;
  bids.forEach((b, i) => {
    if (!credible(b.price, budget, minBidBps)) return;
    if (best === null) { best = i; return; }
    const cur = bids[best];
    const s = score(b.price, b.rep);
    const t = score(cur.price, cur.rep);
    if (s < t || (s === t && b.commitIndex < cur.commitIndex)) best = i;
  });
  return best;
}

export const BID_BOND = 20_000_000_000_000_000_000_000n; // 0.02 NEAR
export const VET_FEE = 10_000_000_000_000_000_000_000n; // 0.01 NEAR
