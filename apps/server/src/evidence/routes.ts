import type { IncomingMessage, ServerResponse } from 'node:http';
import { evidenceHash, ruleFlags, summarize, type EvidenceSummary } from '@signalfire/core';
import { config } from '../config.ts';
import { nearAiEnabled } from '../nearai.ts';
import { latest as snapshot } from '../snapshot.ts';
import { EVERY_H, MIN_GAP_MIN, generating, latestBrief, refreshIfStale, requestBrief, type BriefRecord } from './brief.ts';
import { gather, type Gathered } from './gather.ts';
import { claim, prove, unlink } from './links.ts';
import { loadLinks } from './store.ts';

// /api/evidence…: the Evidence tab, Discover's evidence chips, founder links, the research brief and its proof.

const json = (res: ServerResponse, code: number, body: unknown): void => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
async function body<T>(req: IncomingMessage, max = 4000): Promise<T> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw Object.assign(new Error('request too large'), { code: 413 });
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as T;
}

// gathering reads cached files and the shared snapshot; keep each startup's result for a minute
const recent = new Map<string, { at: number; p: Promise<Gathered | null> }>();
function evidenceOf(id: string): Promise<Gathered | null> {
  const hit = recent.get(id);
  if (hit && Date.now() - hit.at < 60_000) return hit.p;
  const p = gather(id);
  recent.set(id, { at: Date.now(), p });
  p.catch(() => recent.delete(id));
  return p;
}
const forget = (id: string): void => { recent.delete(id); summaries = null; };

let summaries: { at: number; p: Promise<Record<string, EvidenceSummary & { briefAt: number | null }>> } | null = null;

/** What the page shows of a brief: everything but the raw request/response (those are in /proof and /api/reply). */
const briefView = (b: BriefRecord | null) => b && {
  at: b.at, trigger: b.trigger, evidence: b.evidence, evidenceHash: b.evidenceHash, parsed: b.parsed, brief: b.brief, dropped: b.dropped, flags: b.flags,
  model: b.proof?.model ?? null, signed: !!b.proof?.signature, signingAddress: b.proof?.signingAddress ?? null,
};

/** Handles the request if it is ours; returns false otherwise. */
export async function evidenceRoute(req: IncomingMessage, res: ServerResponse, p: string, me: () => Promise<string | null>): Promise<boolean> {
  const post = req.method === 'POST';
  if (p === '/api/evidence') {
    if (!summaries || Date.now() - summaries.at > 120_000) {
      summaries = {
        at: Date.now(),
        p: (async () => {
          const s = await snapshot();
          const out: Record<string, EvidenceSummary & { briefAt: number | null }> = {};
          for (const st of s.startups.filter((x) => x.status === 'live')) {
            const g = await evidenceOf(st.id).catch(() => null);
            if (g) out[st.id] = { ...summarize(g.items), briefAt: latestBrief(st.id)?.at ?? null };
          }
          return out;
        })(),
      };
      summaries.p.catch(() => { summaries = null; });
    }
    json(res, 200, await summaries.p);
    return true;
  }
  let m = /^\/api\/reply\/brief\/([a-z0-9]{2,8})$/.exec(p);
  if (m) {
    // the brief's exact NEAR AI request, reply and TEE signature, for the Private AI badge
    const pr = latestBrief(m[1])?.proof;
    if (!pr?.signature) json(res, 404, { error: 'no signed brief' });
    else json(res, 200, { model: pr.model, request: pr.request, response: pr.response, signedText: pr.signedText ?? null, signature: pr.signature, signingAddress: pr.signingAddress ?? null, at: pr.at });
    return true;
  }
  m = /^\/api\/evidence\/([a-z0-9]{2,8})(?:\/(brief|proof|links|unlink|prove))?$/.exec(p);
  if (!m) return false;
  const id = m[1];
  const what = m[2];
  if (!what) {
    const g = await evidenceOf(id);
    if (!g) { json(res, 404, { error: 'no such startup' }); return true; }
    refreshIfStale(id);
    const b = latestBrief(id);
    json(res, 200, {
      startup: g.startup, items: g.items, errors: g.errors, evidenceHash: evidenceHash(g.items), flags: ruleFlags(g.items), summary: summarize(g.items),
      links: loadLinks(id, g.startup.founder).links,
      brief: briefView(b), generating: generating(id), nearAi: nearAiEnabled(), everyHours: EVERY_H,
      nextRequestAt: b ? b.at + MIN_GAP_MIN * 60_000 : 0,
    });
    return true;
  }
  if (what === 'proof') {
    // everything `pnpm verify-brief` needs: the link proofs and the brief with its evidence and signed exchange
    const s = (await snapshot()).startups.find((x) => x.id === id);
    if (!s) { json(res, 404, { error: 'no such startup' }); return true; }
    json(res, 200, { hub: config.hub, startup: id, founder: s.founder, links: loadLinks(id, s.founder).links, brief: latestBrief(id) });
    return true;
  }
  if (!post) { json(res, 405, { error: 'POST' }); return true; }
  if (what === 'brief') {
    json(res, 200, { brief: briefView(await requestBrief(id)) });
    forget(id);
    return true;
  }
  const who = await me();
  const b = await body<{ kind?: unknown; target?: unknown; url?: unknown }>(req);
  if (what === 'links') json(res, 200, (await claim(id, who, b)).links);
  else if (what === 'unlink') json(res, 200, (await unlink(id, who, b)).links);
  else {
    const r = await prove(id, who, b);
    json(res, r.link.status === 'verified' && !r.link.error ? 200 : 422, { links: r.record.links, link: r.link, error: r.link.error ?? null });
  }
  forget(id);
  return true;
}
