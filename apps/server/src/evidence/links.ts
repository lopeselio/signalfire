import { normalizeTarget, type LinkKind } from '@signalfire/core';
import { config } from '../config.ts';
import { getStartup } from '../hub.ts';
import { checkProof } from './proofs.ts';
import { loadLinks, saveLinks, type FounderLink, type LinkRecord } from './store.ts';

// A founder claims a GitHub account or repository or an X handle, then proves it: their wallet signs the link
// message (NEP-413), they publish the signature from that account, and paste the URL here. Only the founder's own
// session can add or remove claims; the proof itself is checked against the founder's onchain full-access keys,
// so this server could not forge one.

const MAX_LINKS = 6;
const fail = (code: number, message: string): never => { throw Object.assign(new Error(message), { code }); };

async function founderRecord(startup: string, me: string | null): Promise<LinkRecord> {
  const s = await getStartup(startup).catch(() => null);
  if (!s) return fail(404, 'no such startup');
  if (!me) return fail(401, 'sign in as the founder');
  if (s.founder !== me) return fail(403, `only the founder (${s.founder}) can link sources to ${startup.toUpperCase()}`);
  return loadLinks(startup, s.founder);
}
function target(kind: unknown, raw: unknown): { kind: LinkKind; target: string } {
  if (kind !== 'github' && kind !== 'x') return fail(400, 'kind: github or x');
  const t = typeof raw === 'string' ? normalizeTarget(kind, raw) : null;
  if (!t) return fail(400, kind === 'github' ? 'GitHub: a user or org name, or owner/repo' : 'X: a handle (letters, digits, _; up to 15)');
  return { kind, target: t };
}

export async function claim(startup: string, me: string | null, b: { kind?: unknown; target?: unknown }): Promise<LinkRecord> {
  const rec = await founderRecord(startup, me);
  const t = target(b.kind, b.target);
  if (!rec.links.some((l) => l.kind === t.kind && l.target === t.target)) {
    if (rec.links.length >= MAX_LINKS) fail(400, `at most ${MAX_LINKS} links`);
    rec.links.push({ ...t, status: 'claimed', claimedAt: Date.now() });
    saveLinks(rec);
  }
  return rec;
}

export async function unlink(startup: string, me: string | null, b: { kind?: unknown; target?: unknown }): Promise<LinkRecord> {
  const rec = await founderRecord(startup, me);
  const t = target(b.kind, b.target);
  rec.links = rec.links.filter((l) => !(l.kind === t.kind && l.target === t.target));
  saveLinks(rec);
  return rec;
}

export async function prove(startup: string, me: string | null, b: { kind?: unknown; target?: unknown; url?: unknown }): Promise<{ record: LinkRecord; link: FounderLink }> {
  const rec = await founderRecord(startup, me);
  const t = target(b.kind, b.target);
  if (typeof b.url !== 'string' || b.url.length > 400) fail(400, 'url: the proof’s URL');
  let link = rec.links.find((l) => l.kind === t.kind && l.target === t.target);
  if (!link) {
    if (rec.links.length >= MAX_LINKS) fail(400, `at most ${MAX_LINKS} links`);
    link = { ...t, status: 'claimed', claimedAt: Date.now() };
    rec.links.push(link);
  }
  const r = await checkProof({ startup, founder: rec.founder, ...t }, String(b.url), config.hub);
  link.checkedAt = Date.now();
  if (r.ok) {
    Object.assign(link, { status: 'verified', proofUrl: String(b.url).trim(), message: r.message, signature: r.signature, publicKey: r.publicKey });
    delete link.error;
  } else {
    // a failed attempt never downgrades a link that was already proven
    link.error = r.error;
  }
  saveLinks(rec);
  return { record: rec, link };
}
