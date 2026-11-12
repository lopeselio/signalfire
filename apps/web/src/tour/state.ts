import { useEffect, useState, useSyncExternalStore } from 'react';
import { parseNear } from '@signalfire/core';
import { api, type AuditEntry, type Campaign, type Me, type Startup, type State } from '../api.ts';

// The onboarding's memory (which path, which step, what was already seen, which hints were dismissed), kept in
// localStorage, which may be unavailable (private windows): then it lives for this page load only.
// Progress is never stored as "done": it is derived from real state (the session, /api/me, /api/state, the audit log)
// every time, so a returning user sees where they are and a step ticks the moment the chain says so.

export type PathId = 'explore' | 'back' | 'create' | 'found';

interface Saved {
  /** the welcome was answered or skipped */
  welcomed: boolean;
  path: PathId | null;
  /** the running tour: its path and step index; null when paused or finished */
  tour: { path: PathId; index: number } | null;
  /** read-only steps the user went past with Next */
  seen: string[];
  /** contextual hints the user dismissed */
  hints: string[];
  /** the Get started checklist is hidden */
  hideList: boolean;
  /** features (`requires` selectors) this build was seen to have */
  features: string[];
}

const KEY = 'signalfire.onboarding';
const OLD_KEY = 'signalfire.onboarded'; // the four cards this replaces
const EMPTY: Saved = { welcomed: false, path: null, tour: null, seen: [], hints: [], hideList: false, features: [] };

function read(): Saved {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...EMPTY, ...(JSON.parse(raw) as Partial<Saved>) };
    if (localStorage.getItem(OLD_KEY) === '1') return { ...EMPTY, welcomed: true };
  } catch { /* unavailable */ }
  return EMPTY;
}

let saved: Saved = read();
const subs = new Set<() => void>();

export const tourStore = {
  get: (): Saved => saved,
  set(patch: Partial<Saved> | ((s: Saved) => Partial<Saved>)): void {
    saved = { ...saved, ...(typeof patch === 'function' ? patch(saved) : patch) };
    try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch { /* private window */ }
    subs.forEach((f) => f());
  },
  subscribe(f: () => void): () => void { subs.add(f); return () => subs.delete(f); },
  /** start (or restart) a path's tour at a step */
  start(path: PathId, index: number): void { tourStore.set({ welcomed: true, path, tour: { path, index }, hideList: false }); },
  see(id: string): void { tourStore.set((s) => (s.seen.includes(id) ? {} : { seen: [...s.seen, id] })); },
  dismissHint(id: string): void { tourStore.set((s) => (s.hints.includes(id) ? {} : { hints: [...s.hints, id] })); },
  hasFeature(sel: string): void { tourStore.set((s) => (s.features.includes(sel) ? {} : { features: [...s.features, sel] })); },
};

export const useTour = (): Saved => useSyncExternalStore(tourStore.subscribe, tourStore.get, tourStore.get);

/** True once the visitor answered or skipped the welcome (App opens it on a first visit otherwise). */
export const seenOnboarding = (): boolean => read().welcomed;

// ---------- what the visitor has done, from real state ----------

export interface Signals {
  signedIn: boolean;
  /** startups the visitor holds any tokens of */
  holds: string[];
  /** startups the visitor holds at least the holder minimum of */
  holdsEnough: string[];
  /** startups whose holders' council the visitor sits on */
  holderOf: string[];
  /** voted on any funding proposal */
  voted: boolean;
  /** the visitor's Signalfire wallet (inside the hub) can pay the scout's 0.01 NEAR */
  walletFunded: boolean;
  applied: boolean;
  admitted: boolean;
  /** the latest campaign the visitor sealed a bid on */
  bid: Campaign | null;
  revealed: boolean;
  /** that campaign's auction is settled (won, lost or no winner) */
  settled: boolean;
  /** the latest startup the visitor founded */
  mine: Startup | null;
  /** its marketing treasury has fees in */
  filled: boolean;
  /** a brief was posted on it */
  briefed: boolean;
  /** its constraints were set by the visitor (from the audit log) */
  constrained: boolean;
  /** the visitor voted on a proposal in their own startup's DAO */
  votedMine: boolean;
}

const FEE = parseNear('0.01');

export function signals(state: State | null, me: Me | null, account: string | null, audit: AuditEntry[] | null): Signals {
  const startups = state?.startups ?? [];
  const campaigns = state?.campaigns ?? [];
  const tokens = account && me?.accountId === account ? me.tokens : [];
  const holds = tokens.filter((t) => BigInt(t.balance) > 0n).map((t) => t.startup);
  const holdsEnough = tokens.filter((t) => {
    const st = startups.find((x) => x.id === t.startup);
    return st && BigInt(t.balance) >= BigInt(st.constraints.min_holder_tokens);
  }).map((t) => t.startup);
  const holderOf = account ? startups.filter((s) => s.holders.includes(account)).map((s) => s.id) : [];
  const votedOn = account ? campaigns.filter((c) => c.proposal && c.proposal.votes[account]) : [];
  const bids = account ? campaigns.filter((c) => c.bids.some((b) => b.creator === account)).sort((a, b) => b.id - a.id) : [];
  const bid = bids[0] ?? null;
  const mineAll = account ? startups.filter((s) => s.founder === account).sort((a, b) => b.created_ms - a.created_ms) : [];
  const mine = mineAll[0] ?? null;
  const myMe = account && me?.accountId === account ? me : null;
  return {
    signedIn: !!account,
    holds,
    holdsEnough,
    holderOf,
    voted: votedOn.length > 0,
    walletFunded: !!myMe?.wallet && BigInt(myMe.wallet.balance) >= FEE,
    applied: !!myMe?.application || !!myMe?.creator,
    admitted: !!myMe?.creator && !myMe.creator.creator.revoked,
    bid,
    revealed: bids.some((c) => c.bids.some((b) => b.creator === account && b.revealed)),
    settled: !!bid && bid.phase !== 'bidding',
    mine,
    filled: !!mine && BigInt(mine.fees_in) > 0n,
    briefed: !!mine && campaigns.some((c) => c.startup === mine.id),
    constrained: !!mine && !!audit?.some((e) => e.action === 'constraints' && e.account === account && e.startup === mine.id),
    votedMine: !!mine && votedOn.some((c) => c.startup === mine.id),
  };
}

/** The audit log, read only while the visitor has founded a startup (to tick "set constraints"). */
export function useFounderAudit(enabled: boolean): AuditEntry[] | null {
  const [rows, setRows] = useState<AuditEntry[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let on = true;
    const load = (): void => { api<AuditEntry[]>('/audit').then((r) => on && setRows(r)).catch(() => undefined); };
    load();
    const t = setInterval(load, 20000);
    return () => { on = false; clearInterval(t); };
  }, [enabled]);
  return rows;
}

// ---------- what is open right now, and when the next campaign opens ----------

export interface Briefs { auto: boolean; everyMin: number; nextAt: number | null; startup: string | null }
export const briefsOf = (state: State): Briefs | null => (state as State & { briefs?: Briefs }).briefs ?? null;

const ACTIVE = ['bidding', 'proposing', 'voting', 'funded', 'propose_failed'];

export interface Live {
  /** campaigns taking sealed bids now */
  bidding: Campaign[];
  /** campaigns in their reveal window */
  reveal: Campaign[];
  /** campaigns whose DAO proposal is open */
  voting: Campaign[];
  /** campaigns running (paying per milestone) */
  funded: Campaign[];
}

export function live(state: State, now: number): Live {
  const cs = state.campaigns;
  return {
    bidding: cs.filter((c) => c.phase === 'bidding' && now < c.commit_ends_ms),
    reveal: cs.filter((c) => c.phase === 'bidding' && now >= c.commit_ends_ms && now < c.reveal_ends_ms),
    voting: cs.filter((c) => c.phase === 'voting' && c.proposal?.status === 'InProgress'),
    funded: cs.filter((c) => c.phase === 'funded'),
  };
}

export const nameOf = (state: State, id: string): string => state.startups.find((s) => s.id === id)?.name ?? id.toUpperCase();

/** "in about 12 min", "any minute now": when the founder agent may post its next brief, or null if it doesn't. */
export function nextBrief(state: State, now: number): { when: string; startup: string | null; afterRunning: Campaign | null } | null {
  const ops = state.startups.filter((s) => s.founder === state.operator && s.status === 'live');
  const running = state.campaigns.find((c) => ops.some((s) => s.id === c.startup) && ACTIVE.includes(c.phase)) ?? null;
  const b = briefsOf(state);
  let at: number | null;
  if (b) {
    if (!b.auto) return null;
    at = b.nextAt;
  } else {
    // an older server: estimate from the last brief and the default 8-hour gap
    const last = Math.max(0, ...state.campaigns.filter((c) => ops.some((s) => s.id === c.startup)).map((c) => c.created_ms));
    at = last ? last + 480 * 60_000 : null;
  }
  if (at === null) return null;
  const min = Math.ceil((at - now) / 60_000);
  const when = running ? 'after the running campaign finishes' : min <= 1 ? 'any minute now' : min < 90 ? `in about ${min} min` : `in about ${Math.round(min / 60)} h`;
  return { when, startup: running ? null : b?.startup ?? null, afterRunning: running };
}

/** The startup a backer or creator should look at now: one with a campaign open, else the next brief's, else the demo. */
export function focusStartup(state: State, now: number): string {
  const l = live(state, now);
  const c = l.bidding[0] ?? l.reveal[0] ?? l.voting[0] ?? l.funded[0];
  if (c) return c.startup;
  return briefsOf(state)?.startup ?? state.demo;
}

/** A sentence for "nothing is open right now". */
export function whenNext(state: State, now: number): string {
  const n = nextBrief(state, now);
  if (!n) return 'The demo’s founder agent isn’t posting briefs right now; a founder can post one from their Founder’s desk at any time.';
  if (n.afterRunning) return `Campaign #${n.afterRunning.id} on ${nameOf(state, n.afterRunning.startup)} is still running; the founder agent posts the next brief after it finishes (one campaign at a time).`;
  return `The founder agent posts the next brief ${n.when}${n.startup ? `, probably for ${nameOf(state, n.startup)}` : ''}.`;
}
