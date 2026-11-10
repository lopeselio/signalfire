import { config } from './config.ts';
import { view, viewOn } from './chain.ts';

// Typed reads of the hub and the DAOs (the JSON the contract returns).

export interface Constraints { campaign_cap: string; max_payout: string; payouts_per_hour: number; min_bid_bps: number; min_holder_tokens: string }
export interface Startup {
  id: string; name: string; pitch: string; founder: string; token: string; dao: string; status: string;
  circulating: string; reserve: string; available: string; committed: string; paid: string; fees_in: string; forfeits_in: string;
  trades: number; volume: string; buyers: number; constraints: Constraints; recent_payouts: number[]; last_payout_ms: number | null;
  campaigns: number[]; created_ms: number;
}
export interface Trade { n: number; ts_ms: number; account: string; side: 'buy' | 'sell'; near: string; tokens: string; fee: string; circulating_after: string; ref_code: string | null; attributed: number | null }
export interface Bid { creator: string; hash: string; committed_ms: number; revealed: boolean; price: string | null; pitch_hash: string | null; credible: boolean; rep: number; bond_settled: boolean }
export interface Campaign {
  id: number; startup: string; title: string; brief: string; target: number; budget: string; created_ms: number;
  commit_ends_ms: number; reveal_ends_ms: number; duration_ms: number; phase: string; bids: Bid[]; winner: string | null; price: string;
  proposal_id: number | null; funded_ms: number | null; deadline_ms: number | null; results: number; attributed: string[];
  milestones_paid: number; paid: string; paid_tusd: string; receipt: string | null;
}
export interface Creator {
  account: string; name: string; profile: string; report_hash: string; scout: string; admitted_ms: number; revoked: boolean;
  won: number; completed: number; missed: number; results: number; payouts: number; paid: string; paid_tusd: string;
}
export interface Wallet { owner: string; balance: string; locked: string; cap_tx: string; cap_day: string; day_start_ms: number; day_spent: string; spent_total: string }
export interface AuditEntry { n: number; ts_ms: number; startup: string | null; campaign: number | null; action: string; account: string | null; amount: string; outcome: string; flags: string[]; note: string }
export interface HubConfig { owner: string; operator: string; tusd: string | null; scouts: string[]; startups: number; campaigns: number; creators: number; audit: number; desk_reserve: string; tusd_paid: string; terms: string }
export interface Proposal { id: number; proposer: string; description: string; kind: Record<string, unknown>; status: string; vote_counts: Record<string, string[]>; votes: Record<string, string>; submission_time: string }
export interface DaoPolicy { roles: { name: string; kind: { Group?: string[] } | string; permissions: string[] }[] }

export const getConfig = (): Promise<HubConfig> => view('get_config');
export const getStartups = (): Promise<Startup[]> => view('get_startups');
export const getStartup = (id: string): Promise<Startup | null> => view('get_startup', { id });
export const getTrades = (startup: string, limit = 240): Promise<Trade[]> => view('get_trades', { startup, limit });
export const getCampaign = (id: number): Promise<Campaign | null> => view('get_campaign', { id });
export const getCampaigns = async (startup?: string): Promise<Campaign[]> => {
  const out: Campaign[] = [];
  for (let from = 0; ; from += 100) {
    const page = await view<Campaign[]>('get_campaigns', { startup: null, from, limit: 100 });
    out.push(...page);
    if (page.length < 100) break;
  }
  return startup ? out.filter((c) => c.startup === startup) : out;
};
export const getCreators = async (): Promise<{ creator: Creator; rep_bps: number }[]> => view('get_creators');
export const getWallet = (account: string): Promise<Wallet | null> => view('get_wallet', { account });
export const getAudit = async (): Promise<AuditEntry[]> => {
  const out: AuditEntry[] = [];
  for (let from = 0; ; from += 200) {
    const page = await view<AuditEntry[]>('get_audit', { from, limit: 200 });
    out.push(...page);
    if (page.length < 200) break;
  }
  return out;
};
export const getProposal = (dao: string, id: number): Promise<Proposal | null> => viewOn<Proposal>(dao, 'get_proposal', { id }).catch(() => null);
export const getPolicy = (dao: string): Promise<DaoPolicy> => viewOn(dao, 'get_policy', {});
export const holdersOf = async (dao: string): Promise<string[]> => {
  const p = await getPolicy(dao);
  const r = p.roles.find((x) => x.name === 'holders');
  return r && typeof r.kind === 'object' && r.kind.Group ? r.kind.Group : [];
};
export const ftBalance = (token: string, account: string): Promise<string> => viewOn<string>(token, 'ft_balance_of', { account_id: account }).catch(() => '0');
export const tusdId = (): string => `tusd.${config.hub}`;
