import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LinkKind } from '@signalfire/core';
import { config } from '../config.ts';

// JSON records under DATA_DIR/evidence: founder links with their proofs, research briefs with their NEAR AI proofs,
// and a cache of what we fetched from GitHub and NearBlocks (their rate limits are low).

function dir(...parts: string[]): string {
  const d = join(config.dataDir, 'evidence', ...parts);
  mkdirSync(d, { recursive: true });
  return d;
}
function write(file: string, v: unknown): void {
  writeFileSync(`${file}.tmp`, JSON.stringify(v, null, 1));
  renameSync(`${file}.tmp`, file);
}
function read<T>(file: string): T | null {
  try { return JSON.parse(readFileSync(file, 'utf8')) as T; } catch { return null; }
}
const safe = (k: string): string => k.replace(/[^a-z0-9._-]/gi, '_').slice(0, 120);

/**
 * A founder-linked source. "claimed" until a proof checks out: the founder's wallet signed `message` (NEP-413,
 * recipient = the hub, nonce = sha256(message)) with a full-access key of the founder's account, and the signature
 * was published at `proofUrl` by the GitHub or X account itself. Anyone can recheck it: `pnpm verify-brief`.
 */
export interface FounderLink {
  kind: LinkKind;
  target: string;
  status: 'claimed' | 'verified';
  claimedAt: number;
  proofUrl?: string;
  message?: string;
  signature?: string;
  publicKey?: string;
  checkedAt?: number;
  /** the last proof attempt's problem, shown to the founder */
  error?: string;
}
export interface LinkRecord { startup: string; founder: string; links: FounderLink[] }
const linkFile = (startup: string): string => join(dir('links'), `${safe(startup)}.json`);
export function loadLinks(startup: string, founder: string): LinkRecord {
  const r = read<LinkRecord>(linkFile(startup));
  // a record written for another founder (a symbol can't be relaunched, but be strict) counts for nothing
  return r && r.founder === founder ? r : { startup, founder, links: [] };
}
export const saveLinks = (r: LinkRecord): void => write(linkFile(r.startup), r);

/** The latest research brief per startup, plus a short history. */
export function saveBrief<T extends { startup: string; at: number }>(b: T): void {
  write(join(dir('briefs'), `${safe(b.startup)}.json`), b);
  const h = dir('briefs', safe(b.startup));
  write(join(h, `${b.at}.json`), b);
  const old = readdirSync(h).filter((f) => f.endsWith('.json')).sort().slice(0, -20);
  for (const f of old) { try { unlinkSync(join(h, f)); } catch { /* gone */ } }
}
export const loadBrief = <T>(startup: string): T | null => read<T>(join(dir('briefs'), `${safe(startup)}.json`));

/** A cached fetch: fresh for `ttlMs`; on an error, the last good value (marked stale) if there is one. */
export async function cached<T>(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<{ value: T; at: number; stale?: boolean }> {
  const file = join(dir('cache'), `${safe(key)}.json`);
  const hit = read<{ value: T; at: number }>(file);
  if (hit && Date.now() - hit.at < ttlMs) return hit;
  try {
    const value = await fetcher();
    const fresh = { value, at: Date.now() };
    write(file, fresh);
    return fresh;
  } catch (e) {
    if (hit) return { ...hit, stale: true };
    throw e;
  }
}
