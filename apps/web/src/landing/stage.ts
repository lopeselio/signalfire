import { useEffect, useState } from 'react';
import type { Campaign, Startup, State } from '../api.ts';

// Where each startup's campaign stands, in plain words, mapped onto the hub's real campaign phases
// (contracts/hub: bidding → proposing/voting → funded → done | expired | no_bids | closed).

export type Stage = 'offers' | 'next' | 'picking' | 'running' | 'paid';

/** Tab order and words. `tip` keeps the precise phase names for anyone who hovers. */
export const STAGES: { id: Stage; label: string; tip: string }[] = [
  { id: 'offers', label: 'Taking offers', tip: 'A brief is open and creators are sealing offers (phase: bidding, before the commit deadline)' },
  { id: 'next', label: 'Next brief soon', tip: 'No campaign is running; the founder can post the next brief' },
  { id: 'picking', label: 'Picking the winner', tip: 'Offers are being opened and scored, or the holders are voting (phases: reveal, proposing, voting)' },
  { id: 'running', label: 'Running', tip: 'A creator is at work and is paid per milestone of new buyers (phase: funded)' },
  { id: 'paid', label: 'Paid out', tip: 'At least one campaign finished with every milestone paid (phase: done)' },
];

const ACTIVE = ['bidding', 'proposing', 'voting', 'funded', 'propose_failed'];

/** The startup's campaign that is under way now, if any (one at a time). */
export const activeCampaign = (state: State, id: string): Campaign | undefined =>
  state.campaigns.filter((c) => c.startup === id && ACTIVE.includes(c.phase)).sort((a, b) => b.id - a.id)[0];

/** The stage of one campaign at `now`, or null once it has ended. */
export function campaignStage(c: Campaign, now: number): Stage | null {
  if (c.phase === 'bidding') return now < c.commit_ends_ms ? 'offers' : 'picking';
  if (c.phase === 'proposing' || c.phase === 'voting' || c.phase === 'propose_failed') return 'picking';
  if (c.phase === 'funded') return 'running';
  return null;
}

/** Every tab a startup belongs to: its live stage (or "next brief soon"), plus "paid out" if it has delivered. */
export function stagesOf(state: State, s: Startup, now: number): Set<Stage> {
  const out = new Set<Stage>();
  const c = activeCampaign(state, s.id);
  const st = c ? campaignStage(c, now) : null;
  out.add(st ?? 'next');
  if (state.campaigns.some((x) => x.startup === s.id && x.phase === 'done')) out.add('paid');
  return out;
}

export const delivered = (state: State, id: string): number => state.campaigns.filter((c) => c.startup === id && c.phase === 'done').length;

/**
 * Trades in the last 24 hours per startup, from GET /api/s/:id/activity (read once a minute, not the startup page's
 * 2-second poll). Null until the first answer.
 */
export function useTrades24h(ids: string[]): Record<string, number> | null {
  const [out, setOut] = useState<Record<string, number> | null>(null);
  const key = ids.join(',');
  useEffect(() => {
    let on = true;
    const load = (): void => {
      void Promise.all(key.split(',').filter(Boolean).map(async (id) => {
        const r = await fetch(`/api/s/${id}/activity`, { credentials: 'same-origin' }).then((x) => (x.ok ? x.json() : null)).catch(() => null) as { trades?: { at: number }[] } | null;
        const since = Date.now() - 86_400_000;
        return [id, r?.trades ? r.trades.filter((t) => t.at >= since).length : -1] as const;
      })).then((rows) => { if (on) setOut(Object.fromEntries(rows.filter(([, n]) => n >= 0))); });
    };
    load();
    const t = setInterval(load, 60_000);
    return () => { on = false; clearInterval(t); };
  }, [key]);
  return out;
}
