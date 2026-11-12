import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { sha256Hex } from './bids.ts';

// Evidence about the team behind a startup, and the guardrails on the AI research brief written from it.
// Deterministic and isomorphic: the server, the browser and `pnpm verify-brief` run the same code, so anyone can
// re-run the guard on the model's signed reply and get the brief the page shows.

// ---------- founder-linked sources (GitHub, X), proven with a NEP-413 signature ----------

export type LinkKind = 'github' | 'x';
export interface LinkClaim { startup: string; founder: string; kind: LinkKind; target: string }

/** GitHub: a user or org (`name`) or a repository (`owner/repo`). X: a handle without the @. Lowercase. */
export function normalizeTarget(kind: LinkKind, raw: string): string | null {
  let t = raw.trim().replace(/^@/, '').replace(/\.git$/, '').replace(/\/+$/, '');
  if (kind === 'github') t = t.replace(/^https?:\/\/(www\.)?github\.com\//i, '');
  if (kind === 'x') t = t.replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, '');
  t = t.toLowerCase();
  if (kind === 'github') return /^[a-z0-9](?:[a-z0-9-]{0,38})(?:\/[a-z0-9._-]{1,100})?$/.test(t) ? t : null;
  return /^[a-z0-9_]{1,15}$/.test(t) ? t : null;
}
export const isRepo = (target: string): boolean => target.includes('/');

/** The exact text the founder's wallet signs (NEP-413 `message`). It names the startup, the account and the link. */
export function linkMessage(c: LinkClaim, hub: string): string {
  const what = c.kind === 'x' ? `the X account @${c.target}` : isRepo(c.target) ? `the GitHub repository ${c.target}` : `the GitHub account ${c.target}`;
  return [
    'Signalfire founder link',
    `${c.founder} (founder of ${c.startup.toUpperCase()} on ${hub}) controls ${what}.`,
    `startup: ${c.startup}`,
    `founder: ${c.founder}`,
    `link: ${c.kind}:${c.target}`,
  ].join('\n');
}
/** NEP-413 wants a 32-byte nonce; ours is sha256(message), so a proof needs nothing but the signature. */
export const linkNonce = (message: string): Uint8Array => sha256(utf8ToBytes(message));

/** The one line the founder publishes (a gist, a file in the repo, or an X post). Short enough for a post. */
export const proofLine = (c: LinkClaim, signatureB58: string): string => `signalfire-proof:${c.startup}:${c.founder}:${c.kind}:${c.target}:${signatureB58}`;
const PROOF_RE = /signalfire-proof:([a-z0-9]{2,8}):([a-z0-9._-]{2,64}):(github|x):([a-z0-9._/-]{1,141}):([1-9A-HJ-NP-Za-km-z]{60,100})/g;
export function parseProofLines(text: string): (LinkClaim & { signature: string })[] {
  return [...text.matchAll(PROOF_RE)].map((m) => ({ startup: m[1], founder: m[2], kind: m[3] as LinkKind, target: m[4], signature: m[5] }));
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = `1${out}`; }
  return out;
}
export function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error('not base58');
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) { bytes.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of s) { if (c !== '1') break; bytes.unshift(0); }
  return Uint8Array.from(bytes);
}
/** Wallets return "ed25519:<base58>" or plain base64; the proof line carries base58. */
export function signatureToB58(sig: string): string {
  if (sig.startsWith('ed25519:')) return sig.slice(8);
  const bin = typeof atob === 'function' ? atob(sig) : '';
  return base58Encode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
}

// ---------- evidence items ----------

export type Fact = string | number | boolean | null;
export type EvidenceGroup = 'links' | 'founder' | 'shipped' | 'onchain';
export interface EvidenceItem {
  /** E1, E2, … : what the brief cites */
  id: string;
  group: EvidenceGroup;
  /** what the facts are about: links, founder-account, founder-startups, github-repo, github-user, x-account, treasury, campaigns, holders, creators */
  kind: string;
  title: string;
  facts: Record<string, Fact>;
  source: { label: string; url: string };
  fetchedAt: number;
}

/** JSON with sorted keys, so the same evidence always hashes the same. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}
export const evidenceHash = (items: EvidenceItem[]): string => sha256Hex(canonical(items));

/** What the model is given: only the evidence, each item under its id. */
export function evidencePrompt(startup: { id: string; name: string }, items: EvidenceItem[]): string {
  return `Startup: ${startup.name} (${startup.id.toUpperCase()})\nEvidence (JSON, one object per source; cite by id):\n${items.map((i) => canonical({ id: i.id, title: i.title, facts: i.facts, source: i.source.label })).join('\n')}`;
}

const fact = (items: EvidenceItem[], kind: string): EvidenceItem | undefined => items.find((i) => i.kind === kind);
const num = (v: Fact | undefined): number => (typeof v === 'number' ? v : Number(v ?? 0) || 0);

// ---------- rule checks: gaps and red flags computed by code, not by the model ----------

export interface Flag { text: string; cites: string[]; level: 'red' | 'gap' }
export function ruleFlags(items: EvidenceItem[]): Flag[] {
  const out: Flag[] = [];
  const links = fact(items, 'links');
  if (links) {
    const repos = num(links.facts.verified_github_repos);
    const verified = num(links.facts.verified);
    const claimed = num(links.facts.claimed_unproven);
    if (verified === 0) out.push({ text: 'No verified founder links: no GitHub or X account is proven to belong to the founder.', cites: [links.id], level: 'gap' });
    if (repos === 0) out.push({ text: 'No verified repository: there is no proven code to look at.', cites: [links.id], level: 'gap' });
    if (claimed > 0) out.push({ text: `${claimed} link(s) are claimed but not proven; treat them as the founder’s say-so.`, cites: [links.id], level: 'gap' });
  }
  const acct = fact(items, 'founder-account');
  if (acct) {
    if (acct.facts.signalfire_operator === true) out.push({ text: 'The founder account is the Signalfire operator: this is a demo startup run by the platform, with a fictional founder.', cites: [acct.id], level: 'red' });
    const age = acct.facts.age_days;
    if (typeof age === 'number' && age < 7) out.push({ text: `The founder account is ${age} day(s) old.`, cites: [acct.id], level: 'red' });
    else if (typeof age === 'number' && age < 30) out.push({ text: `The founder account is less than a month old (${age} days).`, cites: [acct.id], level: 'gap' });
  }
  for (const r of items.filter((i) => i.kind === 'github-repo')) {
    if (r.facts.commits_90d === 0) out.push({ text: `The verified repository ${String(r.facts.repo)} has no commits in the last 90 days.`, cites: [r.id], level: 'red' });
    if (r.facts.archived === true) out.push({ text: `The verified repository ${String(r.facts.repo)} is archived.`, cites: [r.id], level: 'red' });
  }
  const camp = fact(items, 'campaigns');
  if (camp) {
    if (num(camp.facts.delivered) === 0) out.push({ text: 'No marketing campaign delivered yet.', cites: [camp.id], level: 'gap' });
    if (num(camp.facts.missed) > 0) out.push({ text: `${num(camp.facts.missed)} campaign(s) missed their deadline.`, cites: [camp.id], level: 'red' });
  }
  const tr = fact(items, 'treasury');
  if (tr && tr.facts.fees_in_near === 0) out.push({ text: 'No trading fees yet: nobody has traded the token.', cites: [tr.id], level: 'gap' });
  return out;
}

// ---------- the summary Discover filters and sorts on ----------

export interface EvidenceSummary { verifiedLinks: number; verifiedRepos: number; claimed: number; repoActive30: boolean; delivered: number; demo: boolean; ageDays: number | null; score: number }
/**
 * How much checkable evidence a startup has, not whether it is good: +2 per verified repository (max 2), +1 per
 * other verified link (max 2), +2 if a verified repository had commits in the last 30 days, +1 if the founder
 * account is 90+ days old, +1 per delivered campaign (max 3).
 */
export function summarize(items: EvidenceItem[]): EvidenceSummary {
  const links = fact(items, 'links');
  const acct = fact(items, 'founder-account');
  const camp = fact(items, 'campaigns');
  const verifiedRepos = num(links?.facts.verified_github_repos);
  const verifiedLinks = num(links?.facts.verified);
  const repoActive30 = items.some((i) => i.kind === 'github-repo' && num(i.facts.commits_30d) > 0);
  const delivered = num(camp?.facts.delivered);
  const ageDays = typeof acct?.facts.age_days === 'number' ? acct.facts.age_days : null;
  const score = 2 * Math.min(verifiedRepos, 2) + Math.min(verifiedLinks - verifiedRepos, 2) + (repoActive30 ? 2 : 0) + (ageDays !== null && ageDays >= 90 ? 1 : 0) + Math.min(delivered, 3);
  return { verifiedLinks, verifiedRepos, claimed: num(links?.facts.claimed_unproven), repoActive30, delivered, demo: acct?.facts.signalfire_operator === true, ageDays, score };
}

// ---------- the brief's guard ----------

export type Section = 'observed' | 'reading' | 'gaps' | 'check';
export const SECTIONS: Section[] = ['observed', 'reading', 'gaps', 'check'];
export interface BriefLine { text: string; cites: string[] }
export type Brief = Record<Section, BriefLine[]>;
export interface Dropped { section: Section; text: string; reason: string }

const MAX: Record<Section, number> = { observed: 8, reading: 5, gaps: 6, check: 6 };

/** Advice, predictions and fundraising words: never allowed, in any section. */
const ADVICE: RegExp[] = [
  /\b(should|must|recommend\w*|advis\w*|consider|worth)\b[^.]{0,60}\b(buy|buying|sell|selling|hold|holding|invest\w*|back|backing|ape)\b/i,
  /\b(invest|invested|investing|investment|investments|investor|investors|returns?|roi|profit\w*|yields?|undervalued|overvalued|moon\w*|pump\w*|dump\w*|guarantee\w*|upside|downside|equity|dividends?|fundrais\w*)\b/i,
  /\b(rais(e|ed|es|ing)|seed|series [a-c])\b[^.]{0,20}\b(money|funds|capital|round)\b/i,
  /\b(ownership|stake|shares?)\b[^.]{0,30}\b(company|startup|token|treasury|revenue|business)\b/i,
  /\bprice target\b/i,
  /\b(will|going to|likely to|expected to|poised to|set to|bound to)\b[^.]{0,40}\b(rise|increase|grow|go up|climb|fall|drop|decline|succeed|fail|moon|double|outperform|appreciate)\b/i,
  /\b(price|token)\b[^.]{0,40}\b(cheap|expensive|bargain|good deal|good entry|opportunit\w*)\b/i,
  /\b(good|great|safe|smart|risky|bad) (buy|bet|investment|entry|trade)\b/i,
];
/** Hedged words mark an inference; it may not sit among the observed facts. */
const HEDGE = /\b(likely|unlikely|probably|possibly|perhaps|suggests?|suggesting|indicat\w*|appears?|seems?|may|might|could|implies|imply|presumably|reflects?)\b/i;

const clean = (s: string): string => s.replace(/[*`#]/g, '').replace(/\s+/g, ' ').trim().slice(0, 320);
/** "E2 shows that the account …" → "The account …": the ids live in `cites`, not in the sentence. */
const LEAD = /^(?:evidence\s+|source\s+)?\(?\[?E\d{1,3}\]?\)?(?:\s*(?:,|and)\s*\[?E\d{1,3}\]?)*\s+(?:shows|states|reports|confirms|notes|lists|records|says|gives|indicates|marks|has)(?:\s+that)?\s+/i;
const unlead = (s: string): string => { const t = s.replace(LEAD, ''); return t === s ? s : t.charAt(0).toUpperCase() + t.slice(1); };
const stripCites = (s: string): string => s.replace(/\s*\b(?:as cited in|cited in|in|from|see|per|source)\s+(?=[[(]?E\d)/gi, ' ').replace(/\[?\(?\bE\d{1,3}\b(?:\s*,\s*E\d{1,3}\b)*\)?\]?/g, ' ');

/** Every number in a line must appear in the evidence it cites (in a fact, a key or a title). */
function numbersCited(text: string, cites: string[], byId: Map<string, EvidenceItem>): boolean {
  let t = stripCites(text).replace(/(\d),(\d{3})/g, '$1$2');
  const dates = t.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? [];
  t = t.replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ');
  // standalone numbers only: not the 1112 in an account name, the 413 in NEP-413 or the 3 in v3
  const nums = [...dates, ...(t.match(/(?<![\w.\-/:])\d+(?:\.\d+)?(?![\w\-/])/g) ?? [])];
  if (!nums.length) return true;
  const hay = cites.map((c) => { const i = byId.get(c)!; return `${i.title} ${i.source.label} ${canonical(i.facts)}`; }).join(' ').replace(/(\d),(\d{3})/g, '$1$2');
  return nums.every((n) => hay.includes(n) || hay.includes(n.replace(/\.0+$/, '')));
}

/**
 * Turns the model's raw JSON into the brief the page shows. Drops a line when it has no valid citation, gives
 * advice or a prediction, or holds a number its sources don't; moves a hedged "observation" to the AI reading.
 * Deterministic: `pnpm verify-brief` re-runs it on the signed reply and must get the same brief.
 */
export function guardBrief(raw: unknown, items: EvidenceItem[]): { brief: Brief; dropped: Dropped[] } {
  const byId = new Map(items.map((i) => [i.id, i]));
  const brief: Brief = { observed: [], reading: [], gaps: [], check: [] };
  const dropped: Dropped[] = [];
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  for (const section of SECTIONS) {
    const list = Array.isArray(src[section]) ? (src[section] as unknown[]) : [];
    for (const entry of list) {
      const e = (entry && typeof entry === 'object' ? entry : { text: entry }) as { text?: unknown; cites?: unknown };
      const original = clean(typeof e.text === 'string' ? e.text : '');
      const text = unlead(original);
      if (!text) continue;
      const fromText = [...original.matchAll(/\bE\d{1,3}\b/g)].map((m) => m[0]);
      const given = Array.isArray(e.cites) ? e.cites.filter((c): c is string => typeof c === 'string').map((c) => c.trim().toUpperCase()) : [];
      const cites = [...new Set([...given, ...fromText])];
      const valid = cites.filter((c) => byId.has(c));
      const drop = (reason: string): void => { dropped.push({ section, text, reason }); };
      if (!cites.length) { drop('no valid citation'); continue; }
      if (valid.length !== cites.length) { drop('cites a source that does not exist'); continue; }
      if (ADVICE.some((r) => r.test(text))) { drop('advice, a prediction or fundraising language'); continue; }
      if (!numbersCited(text, valid, byId)) { drop('a number that is not in the cited sources'); continue; }
      const line = { text: stripCites(text).replace(/\s+([.,;:])/g, '$1').replace(/\s+/g, ' ').trim(), cites: valid };
      const to: Section = section === 'observed' && HEDGE.test(text) ? 'reading' : section;
      if (brief[to].length >= MAX[to]) continue; // past the section's limit: not shown, not a violation
      brief[to].push(line);
    }
  }
  return { brief, dropped };
}

/** The brief without a model (NEAR AI off or failing): only the facts and the rule checks, nothing inferred. */
export function plainBrief(items: EvidenceItem[]): Brief {
  const show = (i: EvidenceItem): string => `${i.title}: ${Object.entries(i.facts).filter(([, v]) => v !== null && v !== '').slice(0, 5).map(([k, v]) => `${k.replace(/_/g, ' ')} ${String(v)}`).join(', ')}.`;
  return {
    observed: items.slice(0, MAX.observed).map((i) => ({ text: show(i), cites: [i.id] })),
    reading: [],
    gaps: [],
    check: items.filter((i) => i.group === 'links' || i.kind === 'github-repo').slice(0, 3).map((i) => ({ text: `Open the source of “${i.title}” and compare it with the figures here.`, cites: [i.id] })),
  };
}
