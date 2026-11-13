import { useCallback, useSyncExternalStore } from 'react';
import type { Trade } from '../api.ts';

// One startup's live activity (GET /api/s/:id/activity, apps/server/src/activity.ts), shared by every component on
// the page: one poll per startup every 2 s while the page is visible, asking only for what changed since the last
// answer and merging by id. A full read every minute drops anything the server no longer reports.

export interface TradeRow {
  id: string; n: number; at: number; account: string; name: string; tag: string | null; side: 'buy' | 'sell';
  near: string; tokens: string; fee: string; circulatingAfter: string; ref: number | null; via: string | null; attributed: number | null;
  tx: string | null; url: string; text: string;
}
export interface HolderRow { account: string; name: string; tag: string | null; balance: string; pct: number; council: boolean }
export interface VoteRow { id: string; campaign: number; proposal: number; account: string; name: string; vote: 'yes' | 'no' | 'remove'; at: number; tx: string | null; url: string | null; text: string }
export interface EventRow { id: string; campaign: number; kind: string; at: number; who: string; text: string; tx: string | null; url: string | null }
export interface Activity {
  startup: string; at: number; cursor: number; stale: boolean;
  market: { circulating: string; price: string; trades: number; buyers: number; feesIn: string; available: string };
  trades: TradeRow[]; holders: { supply: string; minToJoin: string; council: string[]; list: HolderRow[] }; votes: VoteRow[]; events: EventRow[];
}

const POLL_MS = 2000;
const FULL_MS = 60_000;

interface Entry {
  data: Activity | null;
  error: boolean;
  subs: Set<() => void>;
  timer: ReturnType<typeof setTimeout> | null;
  inflight: boolean;
  lastFull: number;
  lastPoll: number;
}
const entries = new Map<string, Entry>();

function merge<T extends { id: string }>(old: T[], add: T[], order: (a: T, b: T) => number, cap: number): T[] {
  if (add.length === 0) return old;
  const byId = new Map(old.map((x) => [x.id, x]));
  for (const x of add) byId.set(x.id, x);
  return [...byId.values()].sort(order).slice(0, cap);
}

async function poll(id: string, e: Entry): Promise<void> {
  if (e.inflight) return;
  e.inflight = true;
  e.lastPoll = Date.now();
  const full = !e.data || Date.now() - e.lastFull > FULL_MS;
  try {
    const res = await fetch(`/api/s/${id}/activity${full ? '' : `?since=${e.data!.cursor}`}`, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const a = (await res.json()) as Activity;
    if (full || !e.data) {
      e.data = a;
      e.lastFull = Date.now();
    } else {
      const prev = e.data;
      const trades = merge(prev.trades, a.trades, (x, y) => y.n - x.n, 240);
      const events = merge(prev.events, a.events, (x, y) => y.at - x.at, 300);
      const votes = merge(prev.votes, a.votes, (x, y) => y.at - x.at, 100);
      e.data = { ...a, trades, events, votes };
    }
    e.error = false;
  } catch {
    e.error = true;
  } finally {
    e.inflight = false;
  }
  for (const f of e.subs) f();
}

function schedule(id: string, e: Entry): void {
  if (e.timer) clearTimeout(e.timer);
  e.timer = null;
  if (e.subs.size === 0) return;
  e.timer = setTimeout(() => {
    // a hidden tab doesn't poll; it catches up when it's shown again
    if (document.visibilityState === 'visible') void poll(id, e).finally(() => schedule(id, e));
    else schedule(id, e);
  }, POLL_MS);
}

function entry(id: string): Entry {
  let e = entries.get(id);
  if (!e) {
    e = { data: null, error: false, subs: new Set(), timer: null, inflight: false, lastFull: 0, lastPoll: 0 };
    entries.set(id, e);
  }
  return e;
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    for (const [id, e] of entries) if (e.subs.size) void poll(id, e);
  });
}

function subscribe(id: string, f: () => void): () => void {
  const e = entry(id);
  e.subs.add(f);
  if (e.subs.size === 1) {
    if (Date.now() - e.lastPoll > POLL_MS) void poll(id, e);
    schedule(id, e);
  }
  return () => {
    e.subs.delete(f);
    if (e.subs.size === 0 && e.timer) { clearTimeout(e.timer); e.timer = null; }
  };
}

/** The startup's live activity (null until the first answer). */
export function useActivity(id: string): Activity | null {
  const sub = useCallback((f: () => void) => subscribe(id, f), [id]);
  return useSyncExternalStore(sub, () => entry(id).data);
}

/** Did the last read fail (the page shows the last good data meanwhile)? */
export function useActivityError(id: string): boolean {
  const sub = useCallback((f: () => void) => subscribe(id, f), [id]);
  return useSyncExternalStore(sub, () => entry(id).error);
}

/** The tape's rows in the contract's trade shape (the price chart reads this). */
export const asTrades = (rows: TradeRow[]): Trade[] => rows.map((t) => ({
  n: t.n, ts_ms: t.at, account: t.account, side: t.side, near: t.near, tokens: t.tokens, fee: t.fee,
  circulating_after: t.circulatingAfter, ref_code: t.ref !== null ? `c${t.ref}` : null, attributed: t.attributed,
}));
