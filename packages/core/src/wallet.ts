// Hub wallets: what a spend from a wallet needs. Mirrors contracts/hub (wallet_spend).

import { HOUR_MS } from './policy.ts';

export interface WalletState { balance: string; cap_tx: string; cap_day: string; day_start_ms: number; day_spent: string }

/** Why a wallet can't spend `amount` right now, or null if it can. */
export function walletRefusal(w: WalletState | null, amount: bigint, nowMs: number): string | null {
  if (!w) return 'no wallet: fund it first';
  if (amount > BigInt(w.cap_tx)) return 'over the per-transaction cap';
  const spent = nowMs - w.day_start_ms >= 24 * HOUR_MS ? 0n : BigInt(w.day_spent);
  if (spent + amount > BigInt(w.cap_day)) return 'over the 24-hour cap';
  if (BigInt(w.balance) < amount) return 'not enough NEAR in the wallet';
  return null;
}
