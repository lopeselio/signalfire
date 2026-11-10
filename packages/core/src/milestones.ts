// Milestone payouts and attribution. Mirrors contracts/hub (claim_milestone, buy).

export const MILESTONES = 3;
/** a referral buy counts only from this much attached (0.05 NEAR) */
export const MIN_ATTRIB = 50_000_000_000_000_000_000_000n;

/** Results needed to unlock milestone k (1-based): ⌈target·k/3⌉. */
export const threshold = (target: number, k: number): number => Math.floor((target * k + MILESTONES - 1) / MILESTONES);

/** What milestone k pays: a third of the price; the last one pays the remainder. */
export const milestoneAmount = (price: bigint, k: number): bigint =>
  k < MILESTONES ? price / BigInt(MILESTONES) : price - (price / BigInt(MILESTONES)) * BigInt(MILESTONES - 1);

/** How many milestones the results unlock. */
export const unlocked = (target: number, results: number): number => {
  let k = 0;
  while (k < MILESTONES && results >= threshold(target, k + 1)) k++;
  return k;
};

/** Does a buy count as a result for a campaign? */
export const attributable = (o: { gross: bigint; firstTimeBuyer: boolean; buyerIsCreator: boolean; campaignFunded: boolean }): boolean =>
  o.campaignFunded && o.firstTimeBuyer && !o.buyerIsCreator && o.gross >= MIN_ATTRIB;

/** tUSD (6 decimals) for a NEAR amount at the fixed test rate 1 NEAR = 3 tUSD. */
export const TUSD_PER_NEAR = 3n;
export const tusdFor = (yocto: bigint): bigint => (yocto * TUSD_PER_NEAR) / 10n ** 18n;
