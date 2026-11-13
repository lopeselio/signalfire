import { SUPPLY, fmtNear, fmtTokens, priceAt } from '@signalfire/core';
import type { AuditEntry, Campaign, Proposal, Startup, Trade } from './hub.ts';
import type { WireItem } from './store.ts';

// One startup's live activity, for its page and for agents (GET /api/s/:id/activity and /holders): the trades
// tape, the holders, the council's votes and each campaign's story in plain words.
//
// It is built from cheap reads, not the full snapshot: the hub's get_startup, get_trades and get_campaigns for that
// startup, the DAO's council, the token balances of the people who traded (only when trades change), the server's
// own wire log and relayed transactions (for transaction links), and the audit log of the last snapshot. One build
// per startup is shared by every viewer for `ttl` ms, so many open pages cost one set of reads.

export interface Relay { tx: string; sender: string; receiver: string; at: number }
export interface Persona { name: string; account: string }

export interface TradeRow {
  id: string; n: number; at: number; account: string; name: string; tag: string | null; side: 'buy' | 'sell';
  near: string; tokens: string; fee: string; circulatingAfter: string;
  /** the campaign whose referral link the buy used ("c12" → 12), and that campaign's winning creator */
  ref: number | null; via: string | null; attributed: number | null;
  tx: string | null; url: string; text: string;
}
export interface HolderRow { account: string; name: string; tag: string | null; balance: string; pct: number; council: boolean }
export interface Holders { supply: string; minToJoin: string; council: string[]; list: HolderRow[] }
export interface VoteRow { id: string; campaign: number; proposal: number; account: string; name: string; vote: 'yes' | 'no' | 'remove'; at: number; tx: string | null; url: string | null; text: string }
export type EventKind = 'brief' | 'offer' | 'won' | 'vote' | 'funded' | 'buyer' | 'paid' | 'held' | 'closed' | 'no_offers' | 'link' | 'comment';
export interface EventRow {
  id: string; campaign: number; kind: EventKind; at: number; who: string; text: string; tx: string | null; url: string | null;
  /** a creator's posted content link (kind "link"): shown to backers, never used for payouts */
  link?: string;
}
/** A campaign's discussion (discuss.ts): content links and comments, as stored. */
export interface Thread { links: { n: number; url: string; caption: string; by: string; at: number; removed?: boolean }[]; comments: { n: number; by: string; at: number; hiddenAt?: number }[] }
export interface Activity {
  startup: string; at: number; cursor: number; stale: boolean;
  market: { circulating: string; price: string; trades: number; buyers: number; feesIn: string; available: string };
  trades: TradeRow[]; holders: Holders; votes: VoteRow[]; events: EventRow[];
}

export const txLink = (h: string): string => `https://testnet.nearblocks.io/txns/${h}`;
export const accountLink = (a: string): string => `https://testnet.nearblocks.io/address/${a}`;

/** "1234567.89" → "1,234,567.89" */
export const group = (s: string): string => s.replace(/^(-?\d+)/, (w) => w.replace(/\B(?=(\d{3})+(?!\d))/g, ','));

export interface NameCtx { hub: string; founder: string; creators: Persona[]; holders: Persona[] }

/** A display name and a tag for an account: personas by name, the simulated buyers as "AI fan". */
export function nameOf(account: string, x: NameCtx): { name: string; tag: string | null } {
  const c = x.creators.find((p) => p.account === account);
  if (c) return { name: c.name, tag: 'AI creator' };
  const h = x.holders.find((p) => p.account === account);
  if (h) return { name: h.name, tag: 'AI holder' };
  const sub = account.endsWith(`.${x.hub}`) ? account.slice(0, -(x.hub.length + 1)) : null;
  if (sub && /^fan-\d+$/.test(sub)) return { name: sub, tag: 'AI fan' };
  const name = sub ?? account.replace(/\.testnet$/, '');
  return { name, tag: account === x.founder ? 'founder' : null };
}

/** The relayed transaction from `sender` to `receiver` closest after `at` (within the window), not used yet. */
export function matchRelay(relays: Relay[], sender: string, receiver: string, at: number, used: Set<string>, before = 15_000, after = 120_000): Relay | null {
  let best: Relay | null = null;
  for (const r of relays) {
    if (r.sender !== sender || r.receiver !== receiver || used.has(r.tx)) continue;
    if (r.at < at - before || r.at > at + after) continue;
    if (!best || Math.abs(r.at - at) < Math.abs(best.at - at)) best = r;
  }
  if (best) used.add(best.tx);
  return best;
}

/** The wire line matching `test` closest to `at` (within the window), not used yet. */
function matchWire(wire: WireItem[], test: (w: WireItem) => boolean, at: number, used: Set<WireItem>, before = 15_000, after = 180_000): WireItem | null {
  let best: WireItem | null = null;
  for (const w of wire) {
    if (used.has(w) || !test(w) || w.at < at - before || w.at > at + after) continue;
    if (!best || Math.abs(w.at - at) < Math.abs(best.at - at)) best = w;
  }
  if (best) used.add(best);
  return best;
}

const refOf = (code: string | null): number | null => {
  const m = /^c(\d{1,6})$/.exec(code ?? '');
  return m ? Number(m[1]) : null;
};
const HELD: Record<string, string> = { 'held:over_cap': 'over the largest-payment limit', 'held:rate_limit': 'hourly payment limit reached; it retries', 'held:payee_revoked': 'the creator was removed' };
const VOTE: Record<string, VoteRow['vote']> = { Approve: 'yes', Reject: 'no', Remove: 'remove' };

export interface BuildInput {
  hub: string; now: number; startup: Startup; trades: Trade[]; campaigns: Campaign[]; council: string[];
  balances: Record<string, string>; proposals: Record<number, Proposal | null>; audit: AuditEntry[];
  wire: WireItem[]; relays: Relay[]; creators: Persona[]; holderAgents: Persona[];
  /** when a vote was first seen by this server (null: it was already there when the server started watching) */
  seenAt: (key: string) => number | null;
  /** each campaign's discussion (content links and comments), if any */
  threads?: Record<number, Thread | null>;
  stale?: boolean;
}

/** The whole activity of one startup from already-read data (pure: no I/O). */
export function buildActivity(i: BuildInput): Activity {
  const s = i.startup;
  const sym = s.id.toUpperCase();
  const nx: NameCtx = { hub: i.hub, founder: s.founder, creators: i.creators, holders: i.holderAgents };
  const nm = (a: string): string => nameOf(a, nx).name;
  const short = (a: string): string => (a.endsWith(`.${i.hub}`) ? a.slice(0, -(i.hub.length + 1)) : a);
  const byId = new Map(i.campaigns.map((c) => [c.id, c]));
  const usedRelay = new Set<string>();
  const usedWire = new Set<WireItem>();

  // ---- trades, newest first
  const trades: TradeRow[] = i.trades.map((t) => {
    const who = nameOf(t.account, nx);
    const ref = refOf(t.ref_code);
    const rc = ref !== null ? byId.get(ref) : undefined;
    const via = rc?.winner ? nm(rc.winner) : null;
    let tx: string | null = null;
    if (t.side === 'buy') {
      const w = matchWire(i.wire, (x) => x.kind === 'buy' && !!x.tx && x.who === short(t.account), t.ts_ms, usedWire);
      tx = w?.tx ?? null;
    }
    tx ??= matchRelay(i.relays, t.account, t.side === 'buy' ? i.hub : s.token, t.ts_ms, usedRelay)?.tx ?? null;
    const amount = `${group(fmtTokens(t.tokens, 0))} ${sym}`;
    const text = t.side === 'buy' ? `${who.name} bought ${amount} for ${fmtNear(t.near)} NEAR` : `${who.name} sold ${amount} for ${fmtNear(t.near)} NEAR`;
    return {
      id: `t${t.n}`, n: t.n, at: t.ts_ms, account: t.account, name: who.name, tag: who.tag, side: t.side,
      near: t.near, tokens: t.tokens, fee: t.fee, circulatingAfter: t.circulating_after,
      ref, via, attributed: t.attributed, tx, url: tx ? txLink(tx) : accountLink(t.account), text,
    };
  });

  // ---- holders: everyone who traded recently or sits on the council, by balance
  const council = new Set(i.council);
  const list: HolderRow[] = Object.entries(i.balances)
    .filter(([a, b]) => BigInt(b) > 0n || council.has(a))
    .map(([a, b]) => {
      const who = nameOf(a, nx);
      return { account: a, name: who.name, tag: who.tag, balance: b, pct: Number((BigInt(b) * 1_000_000n) / SUPPLY) / 10_000, council: council.has(a) };
    })
    .sort((x, y) => (BigInt(y.balance) > BigInt(x.balance) ? 1 : BigInt(y.balance) < BigInt(x.balance) ? -1 : x.account.localeCompare(y.account)));
  for (const a of i.council) if (!(a in i.balances)) list.push({ account: a, ...nameOf(a, nx), balance: '0', pct: 0, council: true });

  // ---- votes and campaign events (the most recent campaigns)
  const votes: VoteRow[] = [];
  const events: EventRow[] = [];
  const ev = (e: Omit<EventRow, 'url'>): void => { events.push({ ...e, url: e.tx ? txLink(e.tx) : null }); };
  const recent = [...i.campaigns].sort((a, b) => b.id - a.id).slice(0, 6);
  for (const c of recent) {
    const wc = i.wire.filter((w) => w.campaign === c.id);
    const winner = c.winner ? nm(c.winner) : null;
    ev({ id: `c${c.id}:brief`, campaign: c.id, kind: 'brief', at: c.created_ms, who: nm(s.founder), text: `${nm(s.founder)} posted a brief: “${c.title}”`, tx: null });
    for (const b of c.bids) {
      const who = nm(b.creator);
      const w = matchWire(wc, (x) => x.kind === 'bid' && (x.who === who || x.who === short(b.creator)), b.committed_ms, usedWire);
      const tx = w?.tx ?? matchRelay(i.relays, b.creator, i.hub, b.committed_ms, usedRelay)?.tx ?? null;
      ev({ id: `c${c.id}:offer:${b.creator}`, campaign: c.id, kind: 'offer', at: b.committed_ms, who, text: `${who} sealed an offer`, tx });
    }
    if (c.winner && winner) {
      const settle = wc.filter((w) => w.kind === 'settle').sort((a, b) => b.at - a.at)[0];
      let at = settle?.at ?? c.reveal_ends_ms;
      if (c.funded_ms) at = Math.min(at, c.funded_ms - 1);
      ev({ id: `c${c.id}:won`, campaign: c.id, kind: 'won', at, who: winner, text: `${winner} won`, tx: settle?.tx ?? null });
    }
    if (c.phase === 'no_bids') ev({ id: `c${c.id}:no_offers`, campaign: c.id, kind: 'no_offers', at: c.reveal_ends_ms, who: 'Signalfire', text: 'No credible offers came in', tx: null });
    const p = i.proposals[c.id];
    if (p && c.proposal_id !== null) {
      const submitted = Math.floor(Number(BigInt(p.submission_time || '0') / 1_000_000n));
      for (const [a, v] of Object.entries(p.votes ?? {})) {
        const who = nm(a);
        const key = `v${c.id}:${a}`;
        const w = matchWire(wc, (x) => x.kind === 'vote' && (x.who === who || x.who === short(a)), submitted, usedWire, 15_000, 7 * 86_400_000);
        const r = w ? null : matchRelay(i.relays, a, s.dao, submitted, usedRelay, 15_000, 7 * 86_400_000);
        const at = w?.at ?? r?.at ?? i.seenAt(key) ?? submitted;
        const tx = w?.tx ?? r?.tx ?? null;
        const vote = VOTE[v] ?? 'yes';
        const text = `${who} voted ${vote} on #${c.id}`;
        votes.push({ id: key, campaign: c.id, proposal: c.proposal_id, account: a, name: who, vote, at, tx, url: tx ? txLink(tx) : null, text });
        ev({ id: key, campaign: c.id, kind: 'vote', at, who, text: `${who} voted ${vote}`, tx });
      }
    }
    if (c.funded_ms && winner) ev({ id: `c${c.id}:funded`, campaign: c.id, kind: 'funded', at: c.funded_ms, who: 'holders', text: `The holders approved it: ${winner} starts work`, tx: null });
    // new buyers through the link, in the order the contract counted them
    c.attributed.forEach((a, k) => {
      const t = trades.find((x) => x.attributed === c.id && x.account === a);
      const who = nm(a);
      ev({ id: `c${c.id}:buyer:${a}`, campaign: c.id, kind: 'buyer', at: t?.at ?? c.funded_ms ?? c.created_ms, who, text: `New buyer via ${winner ?? 'the creator'}’s link (${k + 1}/${c.target}): ${who}`, tx: t?.tx ?? null });
    });
    // payouts: the onchain audit log; the wire for the transaction that paid
    const pays = i.audit.filter((e) => e.campaign === c.id && e.action === 'payout');
    const payWire = (k: number): WireItem | undefined => {
      const re = new RegExp(`(?:milestone|payout) ${k} (?:of 3 )?(?:of|on) #${c.id}\\b`);
      const lines = wc.filter((w) => w.kind === 'payout' && w.tx && re.test(w.what));
      return lines.find((w) => /^paid /.test(w.what)) ?? lines[0];
    };
    if (pays.length > 0) {
      for (const e of pays) {
        const k = Number(/milestone (\d)/.exec(e.note)?.[1] ?? 0);
        if (e.outcome === 'paid') {
          const w = payWire(k);
          ev({ id: `c${c.id}:paid:${e.n}`, campaign: c.id, kind: 'paid', at: e.ts_ms, who: winner ?? nm(e.account ?? ''), text: `${winner ?? nm(e.account ?? '')} was paid for milestone ${k} of 3`, tx: w?.tx ?? null });
        } else if (e.outcome.startsWith('held')) {
          ev({ id: `c${c.id}:held:${e.n}`, campaign: c.id, kind: 'held', at: e.ts_ms, who: 'spend limits', text: `Payout ${k} held: ${HELD[e.outcome] ?? e.outcome}`, tx: null });
        }
      }
    } else if (winner) {
      // no audit read yet: the wire's payout lines
      for (let k = 1; k <= c.milestones_paid; k++) {
        const w = payWire(k);
        if (w) ev({ id: `c${c.id}:paid:w${k}`, campaign: c.id, kind: 'paid', at: w.at, who: winner, text: `${winner} was paid for milestone ${k} of 3`, tx: w.tx ?? null });
      }
    }
    // the discussion: every live content link, the latest comments (a hidden one isn't announced)
    const th = i.threads?.[c.id];
    if (th) {
      for (const l of th.links.filter((x) => !x.removed)) {
        const who = nm(l.by);
        events.push({ id: `c${c.id}:link:${l.n}`, campaign: c.id, kind: 'link', at: l.at, who, text: `${who} posted a link${l.caption ? `: ${l.caption}` : ''}`, tx: null, url: null, link: l.url });
      }
      for (const m of th.comments.filter((x) => !x.hiddenAt).slice(-10)) {
        const who = nm(m.by);
        ev({ id: `c${c.id}:comment:${m.n}`, campaign: c.id, kind: 'comment', at: m.at, who, text: `${who} commented`, tx: null });
      }
    }
    if (c.phase === 'expired' && c.deadline_ms) ev({ id: `c${c.id}:closed`, campaign: c.id, kind: 'closed', at: c.deadline_ms, who: 'Signalfire', text: `Closed at its deadline (${c.results} of ${c.target} new buyers); the unpaid budget went back to the marketing fund`, tx: null });
  }
  events.sort((a, b) => b.at - a.at);
  votes.sort((a, b) => b.at - a.at);

  return {
    startup: s.id, at: i.now, cursor: i.now, stale: !!i.stale,
    market: { circulating: s.circulating, price: priceAt(BigInt(s.circulating)).toString(), trades: s.trades, buyers: s.buyers, feesIn: s.fees_in, available: s.available },
    trades, holders: { supply: SUPPLY.toString(), minToJoin: s.constraints.min_holder_tokens, council: i.council, list }, votes, events,
  };
}

/** Only what changed since `since` (ms; with a minute of overlap for clock skew, so clients merge by id). */
export function sinceFilter(a: Activity, since: number | null): Activity {
  if (since === null) return a;
  const from = since - 60_000;
  return { ...a, trades: a.trades.filter((t) => t.at > from), votes: a.votes.filter((v) => v.at > from), events: a.events.filter((e) => e.at > from) };
}

// ---------- the cached service ----------

export interface ActivityDeps {
  hub: string;
  startup(id: string): Promise<Startup | null>;
  trades(id: string): Promise<Trade[]>;
  campaigns(id: string): Promise<Campaign[]>;
  council(dao: string): Promise<string[]>;
  balance(token: string, account: string): Promise<string>;
  proposal(dao: string, id: number): Promise<Proposal | null>;
  /** the last snapshot's copy of a campaign's proposal (no read), if any */
  snapshotProposal(campaign: number): Proposal | null | undefined;
  /** the last snapshot's audit log (no read) */
  audit(): AuditEntry[];
  wire(): WireItem[];
  relays(): Promise<Relay[]>;
  /** a campaign's discussion from disk (no chain read) */
  discussion?: (campaign: number) => Thread | null;
  creators: Persona[];
  holderAgents: Persona[];
  now?: () => number;
  /** how long one build is shared (ms) */
  ttl?: number;
}

const FINAL = new Set(['Approved', 'Rejected', 'Removed', 'Expired', 'Moved', 'Failed']);

export function createActivity(d: ActivityDeps) {
  const now = d.now ?? Date.now;
  const ttl = d.ttl ?? 1500;
  const cache = new Map<string, { at: number; p: Promise<Activity | null> }>();
  const good = new Map<string, Activity>();
  const councils = new Map<string, { at: number; v: string[] }>();
  const balances = new Map<string, { key: string; at: number; v: Record<string, string> }>();
  const finals = new Map<string, Proposal>();
  const seen = new Map<string, number | null>();
  const watched = new Set<string>();

  const councilOf = async (dao: string): Promise<string[]> => {
    const c = councils.get(dao);
    if (c && now() - c.at < Math.max(ttl, 5000)) return c.v;
    const v = await d.council(dao).catch(() => c?.v ?? []);
    councils.set(dao, { at: now(), v });
    return v;
  };

  async function balancesOf(s: Startup, trades: Trade[], council: string[]): Promise<Record<string, string>> {
    const accounts = [...new Set([...council, ...trades.map((t) => t.account)])].slice(0, 60);
    const key = `${s.trades}|${accounts.join(',')}`;
    const b = balances.get(s.id);
    if (b && b.key === key && now() - b.at < 30_000) return b.v;
    const v = Object.fromEntries(await Promise.all(accounts.map(async (a) => [a, await d.balance(s.token, a).catch(() => b?.v[a] ?? '0')] as const)));
    balances.set(s.id, { key, at: now(), v });
    return v;
  }

  async function proposalsOf(s: Startup, campaigns: Campaign[]): Promise<Record<number, Proposal | null>> {
    const recent = [...campaigns].filter((c) => c.proposal_id !== null).sort((a, b) => b.id - a.id).slice(0, 6);
    const out: Record<number, Proposal | null> = {};
    await Promise.all(recent.map(async (c) => {
      const k = `${s.dao}|${c.proposal_id}`;
      const f = finals.get(k);
      if (f) { out[c.id] = f; return; }
      const snap = d.snapshotProposal(c.id);
      // a vote still open is read every build; a settled one once
      const live = c.phase === 'voting' || c.phase === 'proposing' || !snap || !FINAL.has(snap.status);
      const p = live ? await d.proposal(s.dao, c.proposal_id!).catch(() => snap ?? null) : snap;
      if (p && FINAL.has(p.status)) finals.set(k, p);
      out[c.id] = p ?? null;
    }));
    return out;
  }

  async function build(id: string): Promise<Activity | null> {
    const s = await d.startup(id);
    if (!s) return null;
    const [trades, campaigns, council, relays] = await Promise.all([d.trades(id), d.campaigns(id), councilOf(s.dao), d.relays().catch(() => [])]);
    const [bal, proposals] = await Promise.all([balancesOf(s, trades, council), proposalsOf(s, campaigns)]);
    // votes seen on the first look were cast before we watched: their time comes from the wire, a relay or the
    // proposal; votes that appear later get the time we first saw them
    const first = !watched.has(id);
    for (const [cid, p] of Object.entries(proposals)) for (const a of Object.keys(p?.votes ?? {})) {
      const k = `v${cid}:${a}`;
      if (!seen.has(k)) seen.set(k, first ? null : now());
    }
    watched.add(id);
    return buildActivity({
      hub: d.hub, now: now(), startup: s, trades, campaigns, council, balances: bal, proposals, audit: d.audit().filter((e) => e.startup === id),
      wire: d.wire(), relays, threads: Object.fromEntries([...campaigns].sort((x, y) => y.id - x.id).slice(0, 6).map((c) => [c.id, d.discussion?.(c.id) ?? null])), creators: d.creators, holderAgents: d.holderAgents, seenAt: (k) => seen.get(k) ?? null,
    });
  }

  /**
   * The activity of one startup. A build is shared by every caller for `ttl` ms; after that, callers get the last good
   * build at once while one rebuild runs in the background (so a slow RPC never stalls a page). If the rebuild
   * fails, the last good build is marked stale.
   */
  const building = new Map<string, Promise<Activity | null>>();
  const failed = new Set<string>();
  function refresh(id: string): Promise<Activity | null> {
    const run = building.get(id);
    if (run) return run;
    const p = build(id)
      .then((a) => { if (a) good.set(id, a); else good.delete(id); failed.delete(id); cache.set(id, { at: now(), p: Promise.resolve(a) }); return a; })
      .catch((e: unknown) => { failed.add(id); if (!good.has(id)) throw e; return good.get(id)!; })
      .finally(() => building.delete(id));
    building.set(id, p);
    return p;
  }
  const mark = (a: Activity | null): Activity | null => (a && failed.has(a.startup) ? { ...a, stale: true } : a);
  async function get(id: string): Promise<Activity | null> {
    const c = cache.get(id);
    if (c && now() - c.at < ttl) return mark(await c.p);
    const g = good.get(id);
    if (g) { void refresh(id).catch(() => undefined); return mark(g); }
    return mark(await refresh(id));
  }
  return { get };
}
