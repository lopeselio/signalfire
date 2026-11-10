// The server API (apps/server/src/main.ts). Everything shown is read from the chain by the server;
// the wallet session is Better Auth's HttpOnly cookie.

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, body === undefined
    ? { credentials: 'same-origin' }
    : { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { status: res.status });
  return data;
}

export interface Constraints { campaign_cap: string; max_payout: string; payouts_per_hour: number; min_bid_bps: number; min_holder_tokens: string }
export interface Startup {
  id: string; name: string; pitch: string; founder: string; token: string; dao: string; status: string;
  circulating: string; reserve: string; available: string; committed: string; paid: string; fees_in: string; forfeits_in: string;
  trades: number; volume: string; buyers: number; constraints: Constraints; campaigns: number[]; created_ms: number;
  price: string; holders: string[];
}
export interface Bid { creator: string; hash: string; committed_ms: number; revealed: boolean; price: string | null; pitch_hash: string | null; credible: boolean; rep: number }
export interface Proposal { status: string; votes: Record<string, string>; kind: Record<string, unknown> }
export interface Campaign {
  id: number; startup: string; title: string; brief: string; target: number; budget: string; created_ms: number;
  commit_ends_ms: number; reveal_ends_ms: number; duration_ms: number; phase: string; bids: Bid[]; winner: string | null; price: string;
  proposal_id: number | null; funded_ms: number | null; deadline_ms: number | null; results: number; attributed: string[];
  milestones_paid: number; paid: string; paid_tusd: string; receipt: string | null;
  pitches: Record<string, { pitch: string; signed: boolean; model: string }>;
  proposal: Proposal | null;
}
export interface Wallet { owner: string; balance: string; locked: string; cap_tx: string; cap_day: string; day_spent: string; spent_total: string }
export interface CreatorRec {
  creator: { account: string; name: string; profile: string; report_hash: string; scout: string; admitted_ms: number; revoked: boolean; won: number; completed: number; missed: number; results: number; payouts: number; paid: string; paid_tusd: string };
  rep_bps: number; tusd: string; wallet: Wallet | null; vetted: boolean;
}
export interface State {
  at: number; network: string; hub: string; operator: string; demo: string; tusd: string | null; terms: string; nearAi: boolean; nearAiModel: string; relayer: string | null;
  startups: Startup[]; campaigns: Campaign[]; creators: CreatorRec[];
  agents: { creators: { name: string; account: string; title: string; wallet: Wallet | null }[]; scout: { name: string; account: string; wallet: Wallet | null }; holders: { name: string; account: string; wallet: Wallet | null }[]; fans: number };
  solvency: Record<string, string>;
  totals: { feesIn: string; available: string; committed: string; paid: string; volume: string; results: number; funded: number; done: number; desk: string; tusdPaid: string; costPerResult: string | null };
}
export interface Trade { n: number; ts_ms: number; account: string; side: 'buy' | 'sell'; near: string; tokens: string; fee: string; circulating_after: string; ref_code: string | null; attributed: number | null }
export interface AuditEntry { n: number; ts_ms: number; startup: string | null; campaign: number | null; action: string; account: string | null; amount: string; outcome: string; flags: string[]; note: string }
export interface WireItem { at: number; who: string; what: string; tx?: string; url: string | null; kind: string; campaign?: number }
export interface Me {
  accountId: string; tokens: { startup: string; balance: string; holder: boolean; founder: boolean }[];
  wallet: Wallet | null; creator: CreatorRec | null; application: { name: string } | null; tusd: string;
}
export interface Nft { token_id: string; owner_id: string; metadata: { title?: string | null; description?: string | null; extra?: string | null } | null }
export interface CreatorDetail {
  creator: CreatorRec | null; nfts: Nft[];
  vetting: { report: string; reportHash: string; model: string; signed: boolean; signingAddress: string | null; at: number } | null;
  campaigns: { id: number; title: string; phase: string; won: boolean; price: string; results: number }[];
}

export const txUrl = (h: string): string => `https://testnet.nearblocks.io/txns/${h}`;
export const acctUrl = (a: string): string => `https://testnet.nearblocks.io/address/${a}`;
