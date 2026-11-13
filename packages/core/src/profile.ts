import { sha256Hex } from './bids.ts';
import { canonical, type EvidenceItem, type Fact } from './evidence.ts';

// The profile check: four plain ratings and one overall label, computed by rule from the evidence items, never by a
// model. Deterministic and isomorphic, so the server, the page and `pnpm verify-brief` all get the same answer from
// the same published evidence. It measures how much checkable evidence there is about the team, not whether the
// startup is good, and it is not advice.

export const PROFILE_RULE = 'profile-check/1';

export type CodeRating = 'active' | 'some' | 'none' | 'not-linked';
export type PresenceRating = 'verified' | 'claimed' | 'none';
export type FounderRating = 'established' | 'new' | 'brand-new' | 'unknown';
export type TrackRating = 'proven' | 'some' | 'none';
export type ProfileLabel = 'strong' | 'moderate' | 'thin' | 'not-enough';
export type SignalKey = 'code' | 'presence' | 'founder' | 'track';
export type Level = 'ok' | 'warn' | 'bad' | 'smoke';

export interface Signal { key: SignalKey; name: string; rating: string; word: string; level: Level; points: number; detail: string; cites: string[] }
export interface ProfileCheck { rule: string; label: ProfileLabel; word: string; points: number; why: string; demo: boolean; signals: Signal[]; inputsHash: string }

export const PROFILE_WORDS: Record<ProfileLabel, string> = { strong: 'Strong', moderate: 'Moderate', thin: 'Thin', 'not-enough': 'Not enough evidence' };
/** For sorting: higher is more evidence. */
export const PROFILE_RANK: Record<ProfileLabel, number> = { strong: 3, moderate: 2, thin: 1, 'not-enough': 0 };

// ---------- thresholds (documented in DESIGN.md and README step 12) ----------
/** Code activity, over the verified repositories (the most active one counts). */
export const CODE = { activeCommits30: 5, activeCommits30Team: 1, activeTeam: 2, activePushDays: 30 } as const;
/** Founder account, from NearBlocks. */
export const FOUNDER = { establishedDays: 90, establishedTxns: 50, newDays: 7 } as const;
/** Track record on Signalfire. */
export const TRACK = { provenDelivered: 3, provenMissedPerDelivered: 1 / 3 } as const;
/** Overall: points (Active/Verified/Established/Proven 2, Some/New/Some 1, else 0). */
export const OVERALL = { strongPoints: 6, moderatePoints: 3 } as const;

const num = (v: Fact | undefined): number => (typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10) || 0);
const isNum = (v: Fact | undefined): v is number => typeof v === 'number' && Number.isFinite(v);
const s = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Days since 1970-01-01 for a "YYYY-MM-DD" date (no Date: packages/core stays deterministic). */
export function dayNumber(ymd: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
  if (!m) return null;
  let y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  y -= mo <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (mo + (mo > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** Exactly the facts the rule reads, by evidence id. Their hash goes in the brief bundle. */
export function profileInputs(items: EvidenceItem[]): Record<string, Record<string, Fact>> {
  const pick: Record<string, string[]> = {
    links: ['verified', 'verified_github_repos', 'verified_github_accounts', 'verified_x', 'claimed_unproven'],
    'link-proof': ['link'],
    'founder-account': ['age_days', 'txns', 'active_days', 'signalfire_operator'],
    'github-repo': ['repo', 'commits_30d', 'commits_90d', 'last_push', 'contributors', 'archived'],
    campaigns: ['delivered', 'missed', 'new_buyers_from_delivered', 'cost_per_new_buyer_near'],
  };
  const out: Record<string, Record<string, Fact>> = {};
  for (const i of items) {
    const keys = pick[i.kind];
    if (!keys) continue;
    const f: Record<string, Fact> = { kind: i.kind };
    for (const k of keys) f[k] = i.facts[k] ?? null;
    if (i.kind === 'github-repo') f.fetched_day = Math.floor(i.fetchedAt / 86_400_000);
    out[i.id] = f;
  }
  return out;
}

function codeSignal(items: EvidenceItem[], linksId: string[]): Signal {
  const base = { key: 'code' as const, name: 'Code activity' };
  const repos = items.filter((i) => i.kind === 'github-repo');
  if (!repos.length) {
    const verifiedRepos = num(items.find((i) => i.kind === 'links')?.facts.verified_github_repos);
    return {
      ...base, rating: 'not-linked', word: 'Not linked', level: 'smoke', points: 0, cites: linksId,
      detail: verifiedRepos ? 'A verified repository could not be read from GitHub this time.' : 'No verified code repository, so there is no code to look at.',
    };
  }
  const rate = (r: EvidenceItem): { rating: CodeRating; detail: string } => {
    const c30 = num(r.facts.commits_30d);
    const c90 = num(r.facts.commits_90d);
    const team = num(r.facts.contributors);
    const push = typeof r.facts.last_push === 'string' ? dayNumber(r.facts.last_push) : null;
    const since = push === null ? null : Math.floor(r.fetchedAt / 86_400_000) - push;
    const repo = String(r.facts.repo ?? r.title);
    const what = `${repo}: ${s(c30, 'commit')} in 30 days, ${c90} in 90, ${s(team, 'contributor')}${typeof r.facts.last_push === 'string' ? `, last push ${r.facts.last_push}` : ''}.`;
    if (r.facts.archived === true) return { rating: 'none', detail: `${repo} is archived.` };
    const recent = since !== null && since <= CODE.activePushDays;
    if (recent && (c30 >= CODE.activeCommits30 || (c30 >= CODE.activeCommits30Team && team >= CODE.activeTeam))) return { rating: 'active', detail: what };
    if (c90 >= 1 || c30 >= 1) return { rating: 'some', detail: what };
    return { rating: 'none', detail: what };
  };
  const order: CodeRating[] = ['active', 'some', 'none'];
  const rated = repos.map((r) => ({ r, ...rate(r) })).sort((a, b) => order.indexOf(a.rating) - order.indexOf(b.rating));
  const best = rated[0];
  const word = { active: 'Active', some: 'Some', none: 'None', 'not-linked': 'Not linked' }[best.rating];
  const level: Level = best.rating === 'active' ? 'ok' : best.rating === 'some' ? 'warn' : 'bad';
  return { ...base, rating: best.rating, word, level, points: best.rating === 'active' ? 2 : best.rating === 'some' ? 1 : 0, detail: best.detail, cites: [best.r.id] };
}

function presenceSignal(items: EvidenceItem[]): Signal {
  const base = { key: 'presence' as const, name: 'Public presence' };
  const links = items.find((i) => i.kind === 'links');
  const proofs = items.filter((i) => i.kind === 'link-proof').map((i) => i.id);
  const verified = num(links?.facts.verified);
  const claimed = num(links?.facts.claimed_unproven);
  const cites = links ? [links.id, ...proofs].slice(0, 4) : [];
  if (verified > 0) {
    const parts = [num(links?.facts.verified_github_repos) && s(num(links?.facts.verified_github_repos), 'GitHub repository', 'GitHub repositories'), num(links?.facts.verified_github_accounts) && s(num(links?.facts.verified_github_accounts), 'GitHub account'), num(links?.facts.verified_x) && s(num(links?.facts.verified_x), 'X account')].filter(Boolean);
    return { ...base, rating: 'verified', word: 'Verified', level: 'ok', points: 2, cites, detail: `${s(verified, 'link')} proven with the founder’s signature${parts.length ? ` (${parts.join(', ')})` : ''}${claimed ? `; ${claimed} more only claimed` : ''}.` };
  }
  if (claimed > 0) return { ...base, rating: 'claimed', word: 'Claimed only', level: 'warn', points: 0, cites, detail: `${s(claimed, 'link')} claimed but not proven: only the founder’s word.` };
  return { ...base, rating: 'none', word: 'None', level: 'smoke', points: 0, cites, detail: 'No GitHub or X account linked.' };
}

function founderSignal(items: EvidenceItem[]): Signal {
  const base = { key: 'founder' as const, name: 'Founder account' };
  const a = items.find((i) => i.kind === 'founder-account');
  if (!a || !isNum(a.facts.age_days)) {
    return { ...base, rating: 'unknown', word: 'Unknown', level: 'smoke', points: 0, cites: a ? [a.id] : [], detail: 'The founder’s NEAR account could not be read this time.' };
  }
  const age = a.facts.age_days;
  const txns = num(a.facts.txns);
  const what = `${String(a.facts.account ?? 'The account')} is ${s(age, 'day')} old with ${String(a.facts.txns ?? 0)} transactions${a.facts.signalfire_operator === true ? '; it is the Signalfire operator (a demo founder)' : ''}.`;
  if (age >= FOUNDER.establishedDays && txns >= FOUNDER.establishedTxns) return { ...base, rating: 'established', word: 'Established', level: 'ok', points: 2, cites: [a.id], detail: what };
  if (age >= FOUNDER.newDays) return { ...base, rating: 'new', word: 'New', level: 'warn', points: 1, cites: [a.id], detail: what };
  return { ...base, rating: 'brand-new', word: 'Brand new', level: 'bad', points: 0, cites: [a.id], detail: what };
}

function trackSignal(items: EvidenceItem[]): Signal {
  const base = { key: 'track' as const, name: 'Track record on Signalfire' };
  const c = items.find((i) => i.kind === 'campaigns');
  if (!c) return { ...base, rating: 'none', word: 'None yet', level: 'smoke', points: 0, cites: [], detail: 'No campaign record could be read.' };
  const delivered = num(c.facts.delivered);
  const missed = num(c.facts.missed);
  const buyers = num(c.facts.new_buyers_from_delivered);
  const cost = c.facts.cost_per_new_buyer_near;
  const what = `${s(delivered, 'campaign')} delivered, ${missed} missed${buyers ? `; ${s(buyers, 'new buyer')}${isNum(cost) ? ` at ${cost} NEAR each` : ''}` : ''}.`;
  if (delivered >= TRACK.provenDelivered && missed <= delivered * TRACK.provenMissedPerDelivered && buyers > 0) return { ...base, rating: 'proven', word: 'Proven', level: 'ok', points: 2, cites: [c.id], detail: what };
  if (delivered >= 1) return { ...base, rating: 'some', word: 'Some', level: missed > delivered ? 'bad' : 'warn', points: 1, cites: [c.id], detail: what };
  return { ...base, rating: 'none', word: 'None yet', level: missed ? 'bad' : 'smoke', points: 0, cites: [c.id], detail: what };
}

/**
 * The rule (profile-check/1):
 * - Not enough evidence: no proven founder link and no delivered campaign (nothing checkable about the team).
 * - Demo startup (the founder is the Signalfire operator): at most Thin, whatever its record.
 * - Strong: 6+ points, a verified link, active code and a founder account that is not brand new.
 * - Moderate: 3+ points and a verified link.
 * - Thin: anything else.
 */
export function profileCheck(items: EvidenceItem[]): ProfileCheck {
  const links = items.find((i) => i.kind === 'links');
  const code = codeSignal(items, links ? [links.id] : []);
  const presence = presenceSignal(items);
  const founder = founderSignal(items);
  const track = trackSignal(items);
  const signals = [code, presence, founder, track];
  const points = signals.reduce((a, x) => a + x.points, 0);
  const demo = items.some((i) => i.kind === 'founder-account' && i.facts.signalfire_operator === true);
  const verified = presence.rating === 'verified';
  let label: ProfileLabel;
  let why: string;
  if (!verified && track.rating === 'none') {
    label = 'not-enough';
    why = 'No founder link is proven and no campaign has been delivered, so there is nothing about the team to check yet.';
  } else if (demo) {
    label = 'thin';
    why = 'A demo startup run by the Signalfire team with a fictional founder: only its record on Signalfire is real, so it is never rated above Thin.';
  } else if (verified && points >= OVERALL.strongPoints && code.rating === 'active' && founder.rating !== 'brand-new' && founder.rating !== 'unknown') {
    label = 'strong';
    why = `${points} of 8 points, with proven links, active code and a founder account that is not brand new.`;
  } else if (verified && points >= OVERALL.moderatePoints) {
    label = 'moderate';
    why = `${points} of 8 points with at least one proven link${code.rating !== 'active' ? '; Strong needs active code' : ''}${founder.rating === 'brand-new' || founder.rating === 'unknown' ? '; Strong needs a founder account at least a week old' : ''}${points < OVERALL.strongPoints ? `; Strong needs ${OVERALL.strongPoints} points` : ''}.`;
  } else {
    label = 'thin';
    why = verified ? `${points} of 8 points; Moderate needs ${OVERALL.moderatePoints}.` : `${points} of 8 points, but no founder link is proven; Moderate needs at least one.`;
  }
  return { rule: PROFILE_RULE, label, word: PROFILE_WORDS[label], points, why, demo, signals, inputsHash: sha256Hex(canonical(profileInputs(items))) };
}

/** The profile check as the brief's prompt receives it: the ratings as facts, each with the evidence ids it rests on. */
export function profilePrompt(p: ProfileCheck): string {
  return [
    `Profile check (computed by code with rule ${p.rule} from the evidence above; you may explain it, you may not change it or rate anything yourself):`,
    canonical({ profile_strength: p.word, why: p.why, demo_startup: p.demo }),
    ...p.signals.map((x) => canonical({ signal: x.name, rating: x.word, rests_on: x.cites, detail: x.detail })),
    'Your first "reading" line says what the profile strength and its weakest signal rest on, citing the evidence ids the signals rest on. Never call the profile check a reason to buy, sell or hold.',
  ].join('\n');
}

/** A brief line that names a profile strength other than the rule's. */
export function contradictsProfile(text: string, p: ProfileCheck): boolean {
  const named = [...text.matchAll(/\b(strong|moderate|thin|not enough evidence)\b[^.]{0,12}\b(profile|strength)\b|\b(profile strength|profile)\b[^.]{0,20}\b(strong|moderate|thin|not enough evidence)\b/gi)]
    .map((m) => (m[1] ?? m[4]).toLowerCase());
  const mine = p.word.toLowerCase();
  return named.some((w) => w !== mine);
}
