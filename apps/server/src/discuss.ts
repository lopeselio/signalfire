import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';

// A campaign's posted content links and discussion thread.
//
// Content links: the campaign's winning creator (and only them) shows backers what they made. They are never read by
// payouts, vetting or scoring: payouts follow attributed new buyers onchain, nothing here.
// Discussion: plain-text comments by signed-in accounts; the startup's founder can hide one (kept, shown as hidden).
//
// Every write needs a session (the caller passes the account behind the cookie), a JSON body from our own origin, and
// passes length, URL and rate checks. One JSON file per campaign under DATA_DIR/discuss, size-capped.
// DISCUSS_WRITES=off turns every write off (reads keep working).

export const LIMITS = {
  comment: 500, caption: 140, url: 300,
  /** per account, across campaigns */
  perMinute: 5, perDay: 30,
  /** per campaign, all accounts */
  campaignPerMinute: 20,
  commentsPerCampaign: 400, linksPerCampaign: 6, linksPerCreator: 6,
};

export interface ContentLink { n: number; url: string; caption: string; by: string; at: number; removed?: boolean }
export interface Comment { n: number; by: string; text: string; at: number; hiddenAt?: number }
interface Thread { campaign: number; links: ContentLink[]; comments: Comment[]; next: number }

/** Who a campaign's badges and permissions go to, from the hub's state. null: no such campaign. */
export interface Roles { startup: string; founder: string; winner: string | null; phase: string; holders: string[] }
export type Badge = 'Creator' | 'Founder' | 'Holder' | null;

export interface Deps {
  dataDir: string;
  roles: (campaign: number) => Promise<Roles | null>;
  /** the NEAR account behind the request's session cookie, or null */
  me: () => Promise<string | null>;
  writes: boolean;
  /** the page's own origin: a write that names another origin is refused */
  origin: string | null;
  now?: () => number;
}

// ---------- validation (pure) ----------

// control characters (but newline and tab) and bidirectional overrides, which can make text read as something else
// eslint-disable-next-line no-control-regex
const range = (a: number, b: number): string => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`;
const STRIP = new RegExp(`[${[range(0x00, 0x08), range(0x0b, 0x1f), range(0x7f, 0x9f), range(0x200e, 0x200f), range(0x202a, 0x202e), range(0x2066, 0x2069)].join('')}]`, 'gu');
const HAS_STRIP = new RegExp(STRIP.source);

/** Plain text as we store it, or an error. Never HTML: the page renders it as text. */
export function cleanText(raw: unknown, max: number, what: string, allowEmpty = false): { ok: true; text: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') return { ok: false, error: `${what}: text` };
  const text = raw.replace(/\r\n?/g, '\n').replace(STRIP, '').replace(/\t/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (!text && !allowEmpty) return { ok: false, error: `${what}: write something first` };
  if ([...text].length > max) return { ok: false, error: `${what}: at most ${max} characters` };
  return { ok: true, text };
}

/** An http(s) link with a real host and no login in it, at most LIMITS.url long; returns its normal form. */
export function cleanUrl(raw: unknown): { ok: true; url: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') return { ok: false, error: 'link: a web address' };
  const s = raw.trim();
  if (!s || s.length > LIMITS.url) return { ok: false, error: `link: 1 to ${LIMITS.url} characters` };
  if (/[\s<>"'`\\]/.test(s) || HAS_STRIP.test(s)) return { ok: false, error: 'link: no spaces or quotes' };
  let u: URL;
  try { u = new URL(s); } catch { return { ok: false, error: 'link: not a web address' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, error: 'link: only http:// or https:// addresses' };
  if (u.username || u.password) return { ok: false, error: 'link: no logins in the address' };
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname) && !/^xn--/.test(u.hostname)) return { ok: false, error: 'link: needs a real site name' };
  if (u.href.length > LIMITS.url) return { ok: false, error: `link: at most ${LIMITS.url} characters` };
  return { ok: true, url: u.href };
}

export function badgeOf(account: string, r: Roles): Badge {
  if (r.winner === account) return 'Creator';
  if (r.founder === account) return 'Founder';
  if (r.holders.includes(account)) return 'Holder';
  return null;
}

/** Content links can be added once the creator won and the campaign was funded (and after it ends). */
export const linksOpen = (r: Roles): boolean => !!r.winner && ['funded', 'done', 'expired'].includes(r.phase);

// ---------- storage ----------

function dirOf(d: Deps): string {
  const p = join(d.dataDir, 'discuss');
  mkdirSync(p, { recursive: true });
  return p;
}
function readJson<T>(file: string): T | null {
  try { return JSON.parse(readFileSync(file, 'utf8')) as T; } catch { return null; }
}
function writeJson(file: string, v: unknown): void {
  writeFileSync(`${file}.tmp`, JSON.stringify(v));
  renameSync(`${file}.tmp`, file);
}
const threadFile = (d: Deps, id: number): string => join(dirOf(d), `${id}.json`);
export const loadThread = (d: Deps, id: number): Thread => readJson<Thread>(threadFile(d, id)) ?? { campaign: id, links: [], comments: [], next: 1 };

/** Per-account write times in the last day, kept on disk so a restart doesn't reset the daily limit. */
function rateCheck(d: Deps, account: string, now: number): string | null {
  const file = join(dirOf(d), '_rate.json');
  const all = readJson<Record<string, number[]>>(file) ?? {};
  const mine = (all[account] ?? []).filter((t) => now - t < 86_400_000);
  if (mine.filter((t) => now - t < 60_000).length >= LIMITS.perMinute) return `slow down: at most ${LIMITS.perMinute} posts a minute`;
  if (mine.length >= LIMITS.perDay) return `that's ${LIMITS.perDay} posts today: try again tomorrow`;
  mine.push(now);
  const pruned: Record<string, number[]> = {};
  for (const [a, ts] of Object.entries(all)) { const keep = ts.filter((t) => now - t < 86_400_000); if (keep.length) pruned[a] = keep; }
  pruned[account] = mine;
  writeJson(file, pruned);
  return null;
}

// ---------- the public view ----------

export function view(d: Deps, id: number, r: Roles) {
  const t = loadThread(d, id);
  return {
    campaign: id,
    writes: d.writes,
    linksOpen: linksOpen(r),
    creator: r.winner,
    founder: r.founder,
    note: 'Posted links are for backers to see. They are not checked and never used for payouts: payouts follow attributed new buyers onchain.',
    limits: { comment: LIMITS.comment, caption: LIMITS.caption, url: LIMITS.url, perMinute: LIMITS.perMinute, perDay: LIMITS.perDay },
    links: t.links.filter((l) => !l.removed).map((l) => ({ n: l.n, url: l.url, caption: l.caption, by: l.by, at: l.at })),
    // a hidden comment's text is not sent at all
    comments: t.comments.map((c) => ({ n: c.n, by: c.by, badge: badgeOf(c.by, r), at: c.at, hidden: !!c.hiddenAt, text: c.hiddenAt ? null : c.text })),
  };
}

// ---------- routes ----------

class HttpError extends Error { constructor(public code: number, msg: string) { super(msg); } }

async function body(req: IncomingMessage, max = 2000): Promise<Record<string, unknown>> {
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'send JSON');
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new HttpError(413, 'request too large');
    chunks.push(c as Buffer);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch { throw new HttpError(400, 'bad JSON'); }
}

const send = (res: ServerResponse, code: number, b: unknown): void => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(b));
};

const ROUTE = /^\/api\/campaign\/(\d{1,6})\/discussion(?:\/(comment|hide|link|unlink))?$/;

/** Handles the request if it is ours; returns false otherwise. */
export async function discussRoute(req: IncomingMessage, res: ServerResponse, p: string, d: Deps): Promise<boolean> {
  const m = ROUTE.exec(p);
  if (!m) return false;
  const id = Number(m[1]);
  const action = m[2];
  const now = (d.now ?? Date.now)();
  try {
    const r = await d.roles(id);
    if (!r) throw new HttpError(404, 'no such campaign');
    if (!action) {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'GET');
      send(res, 200, view(d, id, r));
      return true;
    }
    if (req.method !== 'POST') throw new HttpError(405, 'POST');
    if (!d.writes) throw new HttpError(503, 'posting is switched off on this server right now');
    const origin = req.headers.origin;
    if (origin && d.origin && origin !== d.origin) throw new HttpError(403, 'post from Signalfire’s own page');
    const me = await d.me();
    if (!me) throw new HttpError(401, 'sign in first');
    const b = await body(req);
    const t = loadThread(d, id);

    if (action === 'comment') {
      const c = cleanText(b.text, LIMITS.comment, 'comment');
      if (!c.ok) throw new HttpError(400, c.error);
      if (t.comments.length >= LIMITS.commentsPerCampaign) throw new HttpError(409, 'this thread is full');
      if (t.comments.filter((x) => now - x.at < 60_000).length >= LIMITS.campaignPerMinute) throw new HttpError(429, 'this thread is busy: try again in a minute');
      const limited = rateCheck(d, me, now);
      if (limited) throw new HttpError(429, limited);
      const n = t.next++;
      t.comments.push({ n, by: me, text: c.text, at: now });
      writeJson(threadFile(d, id), t);
      send(res, 200, { ok: true, n });
      return true;
    }
    if (action === 'hide') {
      if (me !== r.founder) throw new HttpError(403, 'only the startup’s founder can hide comments');
      const c = t.comments.find((x) => x.n === b.n);
      if (!c) throw new HttpError(404, 'no such comment');
      c.hiddenAt ??= now;
      writeJson(threadFile(d, id), t);
      send(res, 200, { ok: true });
      return true;
    }
    if (action === 'link') {
      if (me !== r.winner) throw new HttpError(403, 'only the campaign’s winning creator can post content links');
      if (!linksOpen(r)) throw new HttpError(409, 'content links open once the campaign is funded');
      const u = cleanUrl(b.url);
      if (!u.ok) throw new HttpError(400, u.error);
      const cap = cleanText(b.caption ?? '', LIMITS.caption, 'caption', true);
      if (!cap.ok) throw new HttpError(400, cap.error);
      const live = t.links.filter((l) => !l.removed);
      if (live.length >= LIMITS.linksPerCampaign) throw new HttpError(409, `at most ${LIMITS.linksPerCampaign} links per campaign: remove one first`);
      if (t.links.length >= LIMITS.linksPerCampaign * 4) throw new HttpError(409, 'too many link changes on this campaign');
      if (live.some((l) => l.url === u.url)) throw new HttpError(409, 'that link is already posted');
      const limited = rateCheck(d, me, now);
      if (limited) throw new HttpError(429, limited);
      const n = t.next++;
      t.links.push({ n, url: u.url, caption: cap.text, by: me, at: now });
      writeJson(threadFile(d, id), t);
      send(res, 200, { ok: true, n });
      return true;
    }
    // unlink: the creator takes down one of their own links
    const l = t.links.find((x) => x.n === b.n && !x.removed);
    if (!l) throw new HttpError(404, 'no such link');
    if (l.by !== me) throw new HttpError(403, 'only the creator who posted a link can remove it');
    l.removed = true;
    writeJson(threadFile(d, id), t);
    send(res, 200, { ok: true });
    return true;
  } catch (e) {
    send(res, e instanceof HttpError ? e.code : 400, { error: (e as Error).message });
    return true;
  }
}

/** The /api/campaign/:id/discussion deps from the hub snapshot. */
export function rolesFrom(s: { campaigns: { id: number; startup: string; winner: string | null; phase: string }[]; startups: { id: string; founder: string }[]; holders: Record<string, string[]> }, id: number): Roles | null {
  const c = s.campaigns.find((x) => x.id === id);
  const st = c && s.startups.find((x) => x.id === c.startup);
  if (!c || !st) return null;
  return { startup: st.id, founder: st.founder, winner: c.winner, phase: c.phase, holders: s.holders[st.id] ?? [] };
}
