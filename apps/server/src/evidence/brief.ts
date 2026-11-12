import { evidenceHash, evidencePrompt, plainBrief, ruleFlags, type Brief, type Dropped, type EvidenceItem, type Flag } from '@signalfire/core';
import { ask, nearAiEnabled, type Signed } from '../nearai.ts';
import { gather } from './gather.ts';
import { RESPONSE_FORMAT, SYSTEM, briefFrom } from './parse.ts';
import { loadBrief, saveBrief } from './store.ts';

// The AI research brief: the TEE model on NEAR AI Cloud reads only the gathered evidence (each item under its id) and
// answers in four sections. Code, not the model, then has the last word: packages/core's guard drops every line
// without a valid citation, with advice or a prediction, or with a number its sources don't hold, and moves hedged
// "observations" to the AI reading. Gaps and red flags computed by rule sit beside the model's. The exact request,
// response and the enclave's signature are kept, so anyone can re-run the guard and check the signature.

export interface BriefRecord {
  startup: string;
  name: string;
  at: number;
  trigger: 'auto' | 'request';
  /** exactly what the model was given */
  evidence: EvidenceItem[];
  evidenceHash: string;
  /** the NEAR AI request/response with the TEE signature; null when written without NEAR AI (plain, unsigned) */
  proof: Signed | null;
  /** the model's reply parsed as JSON (false: unreadable, so the brief keeps only rule checks) */
  parsed: boolean;
  brief: Brief;
  dropped: Dropped[];
  flags: Flag[];
  errors: string[];
}

const env = (k: string, d: number): number => (Number.isFinite(Number(process.env[k])) && process.env[k] ? Number(process.env[k]) : d);
export const EVERY_H = env('BRIEF_EVERY_H', 6);
export const MIN_GAP_MIN = env('BRIEF_MIN_GAP_MIN', 15);
const PER_HOUR = env('BRIEF_PER_HOUR', 12);

export const latestBrief = (id: string): BriefRecord | null => loadBrief<BriefRecord>(id);

async function write(id: string, trigger: BriefRecord['trigger']): Promise<BriefRecord> {
  const g = await gather(id);
  if (!g) throw Object.assign(new Error('no such startup'), { code: 404 });
  const evidence = g.items;
  const flags = ruleFlags(evidence);
  const user = evidencePrompt(g.startup, evidence);
  let proof: Signed | null = null;
  let brief: Brief = plainBrief(evidence);
  let dropped: Dropped[] = [];
  let parsed = false;
  if (nearAiEnabled()) {
    const r = await ask(`brief:${id}`, SYSTEM, user, '', 1500, 90_000, 0.3, { response_format: RESPONSE_FORMAT });
    if (r.model !== 'none' && r.response) {
      proof = r;
      const b = briefFrom(r.response, evidence);
      parsed = b.parsed;
      if (b.parsed) { brief = b.brief; dropped = b.dropped; }
    }
  }
  const rec: BriefRecord = { startup: id, name: g.startup.name, at: Date.now(), trigger, evidence, evidenceHash: evidenceHash(evidence), proof, parsed, brief, dropped, flags, errors: g.errors };
  saveBrief(rec);
  return rec;
}

// one model call at a time, one per startup in flight
let queue: Promise<unknown> = Promise.resolve();
const inflight = new Map<string, Promise<BriefRecord>>();
function generate(id: string, trigger: BriefRecord['trigger']): Promise<BriefRecord> {
  const had = inflight.get(id);
  if (had) return had;
  const p = queue.catch(() => undefined).then(() => write(id, trigger));
  queue = p.catch(() => undefined);
  inflight.set(id, p);
  void p.catch((e) => console.warn(`brief for ${id}: ${(e as Error).message}`)).finally(() => inflight.delete(id));
  return p;
}
export const generating = (id: string): boolean => inflight.has(id);

/** Regenerate in the background when there is no brief or it is older than BRIEF_EVERY_H hours. */
export function refreshIfStale(id: string): void {
  const b = latestBrief(id);
  if (!b || Date.now() - b.at > EVERY_H * 3_600_000) void generate(id, 'auto').catch(() => undefined);
}

const recent: number[] = [];
/** On demand: at most once per BRIEF_MIN_GAP_MIN minutes per startup, and BRIEF_PER_HOUR across all startups. */
export async function requestBrief(id: string): Promise<BriefRecord> {
  const b = latestBrief(id);
  const wait = b ? b.at + MIN_GAP_MIN * 60_000 - Date.now() : 0;
  if (wait > 0) throw Object.assign(new Error(`a brief was written ${Math.round((Date.now() - b!.at) / 60_000)} min ago; a new one in ${Math.ceil(wait / 60_000)} min`), { code: 429 });
  while (recent.length && Date.now() - recent[0] > 3_600_000) recent.shift();
  if (recent.length >= PER_HOUR && !inflight.has(id)) throw Object.assign(new Error('too many briefs this hour; try again later'), { code: 429 });
  if (!inflight.has(id)) recent.push(Date.now());
  return generate(id, 'request');
}
