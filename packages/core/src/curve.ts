// The bonding curve. Integer math only (bigint), identical to contracts/hub/src/curve.rs.
//
// Price per raw unit at circulating supply x (raw units, 6 decimals): p(x) = A + B·x yoctoNEAR.
// Buying from x0 to x1 costs the integral: A·(x1−x0) + B·(x1²−x0²)/2 (B is even, so it is exact).
// The curve reserve always equals cost(0, circulating), so every token can be sold back.

export const YOCTO = 10n ** 24n;
export const DECIMALS = 6;
/** raw units per whole token */
export const UNIT = 10n ** 6n;
/** 1,000,000 tokens, all minted to the hub's curve at launch; nobody can mint more */
export const SUPPLY = 1_000_000n * UNIT;
export const A = 10n ** 14n;
export const B = 10_000n;
/** 2% of every trade goes to the startup's marketing treasury, and nowhere else */
export const FEE_BPS = 200n;
/** what a first-time buyer pays for their token storage registration (NEP-145) */
export const FT_STORAGE = 1_250_000_000_000_000_000_000n;
/** the most a single buy may attach */
export const MAX_BUY = 1_000n * YOCTO;

export function cost(x0: bigint, x1: bigint): bigint {
  if (x1 < x0 || x0 < 0n) throw new Error('cost: bad range');
  return A * (x1 - x0) + (B * (x1 * x1 - x0 * x0)) / 2n;
}

export const reserveAt = (x: bigint): bigint => cost(0n, x);

/** Spot price of one whole token at circulating supply x, in yoctoNEAR. */
export const priceAt = (x: bigint): bigint => (A + B * x) * UNIT;

/** ⌊√n⌋ for n ≥ 0 (Newton's method). */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error('isqrt: negative');
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + n / x) / 2n; }
  return x;
}

export interface BuyQuote { storage: bigint; fee: bigint; net: bigint; tokens: bigint; cost: bigint; refund: bigint; priceAfter: bigint }

/** What `gross` yoctoNEAR buys at circulating supply x0. */
export function quoteBuy(x0: bigint, gross: bigint, needsStorage: boolean): BuyQuote {
  const storage = needsStorage ? FT_STORAGE : 0n;
  if (gross <= storage) throw new Error('not enough attached for the storage registration');
  const rest = gross - storage;
  const fee = (rest * FEE_BPS) / 10_000n;
  const net = rest - fee;
  const base = A + B * x0;
  let x1 = (isqrt(base * base + 2n * B * net) - A) / B;
  if (x1 > SUPPLY) x1 = SUPPLY;
  const tokens = x1 - x0;
  const c = cost(x0, x1);
  return { storage, fee, net, tokens, cost: c, refund: net - c, priceAfter: priceAt(x1) };
}

export interface SellQuote { proceeds: bigint; fee: bigint; out: bigint; priceAfter: bigint }

/** What selling `tokens` raw units back at circulating supply x0 pays. */
export function quoteSell(x0: bigint, tokens: bigint): SellQuote {
  if (tokens <= 0n || tokens > x0) throw new Error('sell: bad amount');
  const proceeds = cost(x0 - tokens, x0);
  const fee = (proceeds * FEE_BPS) / 10_000n;
  return { proceeds, fee, out: proceeds - fee, priceAfter: priceAt(x0 - tokens) };
}

/** The smallest acceptable output for a slippage tolerance in basis points. */
export const withSlippage = (amount: bigint, bps: bigint): bigint => (amount * (10_000n - bps)) / 10_000n;
