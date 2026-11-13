import { useEffect, useState, type CSSProperties } from 'react';
import { PROFILE_RANK, PROFILE_WORDS, type EvidenceSummary, type ProfileLabel } from '@signalfire/core';
import { api } from './api.ts';
import './evidence.css';

// Evidence on Discover: small chips on each card and filters, from GET /api/evidence (one summary per startup,
// computed by packages/core's `summarize` and `profileCheck` from the same evidence the Evidence tab shows).

export type Sum = EvidenceSummary & { briefAt: number | null; strength?: ProfileLabel };
export type Summaries = Record<string, Sum>;
const LEVEL: Record<ProfileLabel, string> = { strong: 'ok', moderate: 'warn', thin: 'smoke', 'not-enough': 'smoke' };
/** For Discover's "Most evidence" sort: profile strength first, then the amount of checkable evidence. */
export const evidenceRank = (sum: Sum | undefined): number => (sum ? (PROFILE_RANK[sum.strength ?? 'not-enough'] ?? 0) * 100 + sum.score : -1);
let cache: { at: number; p: Promise<Summaries> } | null = null;
function load(): Promise<Summaries> {
  if (!cache || Date.now() - cache.at > 120_000) {
    cache = { at: Date.now(), p: api<Summaries>('/evidence') };
    cache.p.catch(() => { cache = null; });
  }
  return cache.p;
}
export function useEvidenceSummaries(): Summaries | null {
  const [s, setS] = useState<Summaries | null>(null);
  useEffect(() => { let on = true; void load().then((x) => on && setS(x)).catch(() => undefined); return () => { on = false; }; }, []);
  return s;
}

export function EvidenceChips({ sum }: { sum: Sum | undefined }) {
  if (!sum) return null;
  return (
    <div className="ev-card-chips" aria-label="Evidence">
      {sum.strength && <span className={`chip strength ${LEVEL[sum.strength]}`} title="Profile check: computed by rule from public evidence, not advice"><i className="ev-mini" style={{ '--n': PROFILE_RANK[sum.strength] + 1 } as CSSProperties} aria-hidden="true" />profile: {PROFILE_WORDS[sum.strength]}</span>}
      {sum.verifiedLinks > 0 ? <span className="chip ok">verified founder</span> : <span className="chip smoke">{sum.demo ? 'demo founder' : 'founder not verified'}</span>}
      {sum.verifiedRepos > 0 && <span className={`chip ${sum.repoActive30 ? 'ok' : 'warn'}`}>{sum.repoActive30 ? 'code updated this month' : 'no code updates in 30 days'}</span>}
      <span className={`chip ${sum.delivered ? 'ok' : 'smoke'}`}>{sum.delivered} campaign{sum.delivered === 1 ? '' : 's'} delivered</span>
    </div>
  );
}

export interface EvidenceFilter { verified: boolean; active: boolean; delivered: boolean; profile?: boolean }
export const NO_FILTER: EvidenceFilter = { verified: false, active: false, delivered: false, profile: false };
export const passes = (f: EvidenceFilter, sum: Sum | undefined): boolean =>
  (!f.verified || (sum?.verifiedLinks ?? 0) > 0) && (!f.active || !!sum?.repoActive30) && (!f.delivered || (sum?.delivered ?? 0) > 0)
  && (!f.profile || PROFILE_RANK[sum?.strength ?? 'not-enough'] >= PROFILE_RANK.moderate);

export function EvidenceFilters({ f, set }: { f: EvidenceFilter; set: (f: EvidenceFilter) => void }) {
  const opts: [keyof EvidenceFilter, string][] = [['profile', 'Profile Moderate or Strong'], ['verified', 'Verified founder'], ['active', 'Code updated in the last 30 days'], ['delivered', 'Delivered a campaign']];
  return (
    <div className="d-tools ev-filters" role="group" aria-label="Filter by evidence" data-tour="evidence-filters">
      <span className="muted small">Show only</span>
      {opts.map(([k, l]) => <button key={k} aria-pressed={f[k]} className={`pill${f[k] ? ' on' : ''}`} onClick={() => set({ ...f, [k]: !f[k] })}>{l}</button>)}
    </div>
  );
}
