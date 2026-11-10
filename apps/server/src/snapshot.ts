import { config } from './config.ts';
import { view } from './chain.ts';
import {
  ftBalance, getAudit, getCampaigns, getConfig, getCreators, getProposal, getStartups, getTrades, holdersOf, tusdId,
  type AuditEntry, type Campaign, type Creator, type HubConfig, type Proposal, type Startup, type Trade, type Wallet,
} from './hub.ts';
import { CREATORS, FAN_COUNT, HOLDERS, SCOUT, fanAccount } from './personas.ts';
import { getState, pendingApplicants } from './store.ts';

// One read of everything the app shows, cached for a few seconds and shared by the API and the agents.

export interface Application { name: string; profile: string; fee: string; applied_ms: number }
export interface Snapshot {
  at: number;
  config: HubConfig;
  startups: Startup[];
  campaigns: Campaign[];
  creators: { creator: Creator; rep_bps: number; tusd: string; wallet: Wallet | null }[];
  applications: Record<string, Application>;
  /** "sym|account" → has bought before (fans only) */
  buyers: Record<string, boolean>;
  wallets: Record<string, Wallet | null>;
  audit: AuditEntry[];
  solvency: Record<string, string>;
  trades: Record<string, Trade[]>;
  holders: Record<string, string[]>;
  proposals: Record<number, Proposal | null>;
}

let cache: { at: number; p: Promise<Snapshot> } | null = null;
const TTL = 4000;

export function invalidate(): void { cache = null; }

export function snapshot(): Promise<Snapshot> {
  if (cache && Date.now() - cache.at < TTL) return cache.p;
  const p = build();
  cache = { at: Date.now(), p };
  p.catch(() => { if (cache?.p === p) cache = null; });
  return p;
}

async function build(): Promise<Snapshot> {
  const [hc, startups, campaigns, creatorsRaw, audit, solvency] = await Promise.all([
    getConfig(), getStartups(), getCampaigns(), getCreators(), getAudit(), view<Record<string, string>>('solvency'),
  ]);
  const applicants = [...new Set([...CREATORS.map((c) => c.account), ...pendingApplicants()])];
  const fans = Array.from({ length: getState<number>('fan-count', FAN_COUNT) }, (_, i) => fanAccount(i + 1));
  const agentAccounts = [...CREATORS.map((c) => c.account), SCOUT.account, ...HOLDERS.map((h) => h.account)];
  const [apps, buyerFlags, walletList, creators, trades, holders, proposals] = await Promise.all([
    Promise.all(applicants.map(async (a) => [a, await view<Application | null>('get_application', { account: a }).catch(() => null)] as const)),
    Promise.all(startups.flatMap((s) => fans.map(async (f) => [`${s.id}|${f}`, await view<boolean>('is_buyer', { startup: s.id, account: f }).catch(() => false)] as const))),
    Promise.all([...agentAccounts, ...fans].map(async (a) => [a, await view<Wallet | null>('get_wallet', { account: a }).catch(() => null)] as const)),
    Promise.all(creatorsRaw.map(async (c) => ({
      ...c,
      tusd: await ftBalance(tusdId(), c.creator.account),
      wallet: await view<Wallet | null>('get_wallet', { account: c.creator.account }).catch(() => null),
    }))),
    Promise.all(startups.map(async (s) => [s.id, await getTrades(s.id).catch(() => [])] as const)),
    Promise.all(startups.map(async (s) => [s.id, await holdersOf(s.dao).catch(() => [])] as const)),
    Promise.all(campaigns.filter((c) => c.proposal_id !== null).map(async (c) => {
      const s = startups.find((x) => x.id === c.startup);
      return [c.id, s ? await getProposal(s.dao, c.proposal_id!) : null] as const;
    })),
  ]);
  return {
    at: Date.now(),
    config: hc,
    startups,
    campaigns,
    creators,
    applications: Object.fromEntries(apps.filter(([, v]) => v)) as Record<string, Application>,
    buyers: Object.fromEntries(buyerFlags),
    wallets: Object.fromEntries(walletList),
    audit,
    solvency,
    trades: Object.fromEntries(trades),
    holders: Object.fromEntries(holders),
    proposals: Object.fromEntries(proposals),
  };
}

export { config };
