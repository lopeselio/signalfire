import { config } from './config.ts';
import { view } from './chain.ts';
import {
  ftBalance, getAudit, getCampaigns, getConfig, getCreators, getProposal, getStartups, getTrades, holdersOf, tusdId,
  type AuditEntry, type Campaign, type Creator, type HubConfig, type Proposal, type Startup, type Trade, type Wallet,
} from './hub.ts';
import { relayWhitelist } from './relay-whitelist.ts';
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
let good: Snapshot | null = null;
const TTL = 4000;

export function invalidate(): void { cache = null; }

/** A fresh read (at most TTL old). The agents use this. */
// at most one rebuild at a time: a rebuild is ~200 queued reads, and starting another every TTL while one is still
// running (slow under RPC rate limits) stacks them up until none finishes
let building: Promise<Snapshot> | null = null;
export function snapshot(): Promise<Snapshot> {
  if (building) return building;
  if (cache && Date.now() - cache.at < TTL) return cache.p;
  const p = build().then((s) => { good = s; return s; });
  building = p;
  cache = { at: Date.now(), p };
  p.catch((e) => { console.error(`snapshot rebuild failed: ${(e as Error)?.message ?? e}`); if (cache?.p === p) cache = null; })
    .finally(() => { if (building === p) building = null; });
  return p;
}

/** The last good read, without starting a rebuild (null before the first one). */
export const peek = (): Snapshot | null => good;

/** The last good read right away (refreshing it in the background when stale). The API uses this. */
export function latest(): Promise<Snapshot> {
  if (!good) return snapshot();
  if (Date.now() - good.at > TTL && !(cache && Date.now() - cache.at < TTL)) void snapshot().catch(() => undefined);
  return Promise.resolve(good);
}

async function build(): Promise<Snapshot> {
  // a read that fails keeps the last good value instead of failing the whole rebuild (only the first build has none)
  const keep = <T>(p: Promise<T>, prev: T | undefined): Promise<T> => (prev === undefined ? p : p.catch(() => prev));
  const [hc, startups, campaigns, creatorsRaw, audit, solvency] = await Promise.all([
    keep(getConfig(), good?.config), keep(getStartups(), good?.startups), keep(getCampaigns(), good?.campaigns),
    keep(getCreators(), good?.creators.map(({ tusd: _t, wallet: _w, ...c }) => c) as Awaited<ReturnType<typeof getCreators>> | undefined),
    keep(getAudit(), good?.audit), keep(view<Record<string, string>>('solvency'), good?.solvency),
  ]);
  relayWhitelist.note(startups); // a startup launched since boot can use the gasless relayer
  const applicants = [...new Set([...CREATORS.map((c) => c.account), ...pendingApplicants()])];
  const fans = Array.from({ length: Math.max(getState<number>('fan-count', FAN_COUNT), FAN_COUNT) }, (_, i) => fanAccount(i + 1));
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
      return [c.id, s ? await getProposal(s.dao, c.proposal_id!).catch(() => good?.proposals[c.id] ?? null) : null] as const;
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
