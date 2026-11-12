import { useEffect, useState } from 'react';
import type { EvidenceSummary } from '@signalfire/core';
import { api } from './api.ts';
import './evidence.css';

// Evidence on Discover: small chips on each card and filters, from GET /api/evidence (one summary per startup,
// computed by packages/core's `summarize` from the same evidence the Evidence tab shows).

export type Summaries = Record<string, EvidenceSummary & { briefAt: number | null }>;
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

export function EvidenceChips({ sum }: { sum: EvidenceSummary | undefined }) {
  if (!sum) return null;
  return (
    <div className="ev-card-chips" aria-label="Evidence">
      {sum.verifiedLinks > 0 ? <span className="chip ok">verified founder</span> : <span className="chip smoke">{sum.demo ? 'demo founder' : 'founder not verified'}</span>}
      {sum.verifiedRepos > 0 && <span className={`chip ${sum.repoActive30 ? 'ok' : 'warn'}`}>{sum.repoActive30 ? 'repo active 30 d' : 'repo quiet 30 d'}</span>}
      <span className={`chip ${sum.delivered ? 'ok' : 'smoke'}`}>{sum.delivered} delivered</span>
    </div>
  );
}

export interface EvidenceFilter { verified: boolean; active: boolean; delivered: boolean }
export const NO_FILTER: EvidenceFilter = { verified: false, active: false, delivered: false };
export const passes = (f: EvidenceFilter, sum: EvidenceSummary | undefined): boolean =>
  (!f.verified || (sum?.verifiedLinks ?? 0) > 0) && (!f.active || !!sum?.repoActive30) && (!f.delivered || (sum?.delivered ?? 0) > 0);

export function EvidenceFilters({ f, set }: { f: EvidenceFilter; set: (f: EvidenceFilter) => void }) {
  const opts: [keyof EvidenceFilter, string][] = [['verified', 'Verified founder'], ['active', 'Repo active in 30 days'], ['delivered', 'Delivered a campaign']];
  return (
    <div className="d-tools ev-filters" role="group" aria-label="Filter by evidence" data-tour="evidence-filters">
      <span className="muted small">Show only</span>
      {opts.map(([k, l]) => <button key={k} aria-pressed={f[k]} className={`pill${f[k] ? ' on' : ''}`} onClick={() => set({ ...f, [k]: !f[k] })}>{l}</button>)}
    </div>
  );
}
