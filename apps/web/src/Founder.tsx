import { useState } from 'react';
import {
  MILESTONES, briefErrors, constraintErrors, fmtNear, fmtTokens, milestoneAmount, parseNear, parseTokens, threshold, type Constraints,
} from '@signalfire/core';
import type { Startup } from './api.ts';
import { FounderLinks } from './Evidence.tsx';
import { Near, useApp } from './ui.tsx';
import { call } from './wallet.ts';

// The founder's two levers, and nothing else: post a campaign brief (create_campaign) and set the constraints the
// rules run within (set_constraints). Both are checked here with packages/core's copy of the hub's limits, then
// signed from the founder's wallet (no deposit: gasless through the relayer). Money never moves from here.

const tryNear = (s: string): bigint | null => { try { return parseNear(s); } catch { return null; } };
const tryTokens = (s: string): bigint | null => { try { return parseTokens(s); } catch { return null; } };
const secs = (minutes: string): number => Math.round(Number(minutes) * 60);

export function FounderForms({ s }: { s: Startup }) {
  const { account } = useApp();
  if (!account || account !== s.founder) return null;
  return (
    <section className="panel founder">
      <h2>Founder’s desk</h2>
      <p className="muted small">You’re {s.name}’s founder. You can post briefs and set constraints; you can’t move the treasury. Funding a campaign is the holders’ decision: settling an auction files the DAO proposal by itself. The payee allowlist (only the winning, admitted creator), the 3 milestones and the 2% fee are fixed by the contract.</p>
      <BriefForm s={s} />
      <ConstraintsForm s={s} />
      <FounderLinks s={s} />
    </section>
  );
}

function BriefForm({ s }: { s: Startup }) {
  const { state, run, busy } = useApp();
  const [title, setTitle] = useState('');
  const [brief, setBrief] = useState('');
  const [target, setTarget] = useState('3');
  const [budget, setBudget] = useState('');
  const [commitMin, setCommitMin] = useState('10');
  const [revealMin, setRevealMin] = useState('5');
  const [durationH, setDurationH] = useState('24');
  const cap = BigInt(s.constraints.campaign_cap);
  const free = BigInt(s.available);
  const yocto = tryNear(budget || '0');
  const t = Number(target);
  const input = { title: title.trim(), brief: brief.trim(), target: t, budget: yocto ?? -1n, commitSecs: secs(commitMin), revealSecs: secs(revealMin), durationSecs: Math.round(Number(durationH) * 3600) };
  const errors = briefErrors(input, cap, free);
  const max = cap < free ? cap : free;
  const post = (): void => {
    void run(`Post the brief “${input.title}”`, () => call(state!.hub, 'create_campaign', {
      startup: s.id, title: input.title, brief: input.brief, target: input.target, budget: input.budget.toString(),
      commit_secs: input.commitSecs, reveal_secs: input.revealSecs, duration_secs: input.durationSecs,
    })).then((ok) => { if (ok) { setTitle(''); setBrief(''); setBudget(''); } });
  };
  return (
    <div className="founder-form" data-tour="founder-brief">
      <h3>Post a campaign brief</h3>
      <label className="field"><span>Title</span><input maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} /></label>
      <label className="field"><span>Goal (what creators should do; max 600 bytes)</span><textarea value={brief} onChange={(e) => setBrief(e.target.value)} /></label>
      <div className="form-grid">
        <label className="field"><span>New buyers wanted</span><input inputMode="numeric" value={target} onChange={(e) => setTarget(e.target.value.replace(/\D/g, ''))} /></label>
        <label className="field"><span>Budget (NEAR, up to {fmtNear(max, 3)})</span><input inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder={fmtNear((max * 6n) / 10n, 2)} /></label>
        <label className="field"><span>Bidding window (minutes)</span><input inputMode="decimal" value={commitMin} onChange={(e) => setCommitMin(e.target.value)} /></label>
        <label className="field"><span>Reveal window (minutes)</span><input inputMode="decimal" value={revealMin} onChange={(e) => setRevealMin(e.target.value)} /></label>
        <label className="field"><span>Deadline after funding (hours)</span><input inputMode="decimal" value={durationH} onChange={(e) => setDurationH(e.target.value)} /></label>
      </div>
      {t >= 1 && yocto !== null && yocto > 0n && (
        <p className="small">Milestones (fixed at {MILESTONES}): {Array.from({ length: MILESTONES }, (_, k) => `${threshold(t, k + 1)} buyers → ${fmtNear(milestoneAmount(yocto, k + 1), 4)} NEAR`).join(' · ')}, at most; each pays a third of the <em>winning</em> price, in tUSD. If the target isn’t reached {durationH || '?'} h after the DAO funds it, the unpaid part goes back to the treasury.</p>
      )}
      <p className="muted small">The treasury has <Near y={free} /> free; your campaign cap is <Near y={cap} d={2} />.</p>
      {(title || budget) && errors.length > 0 && <ul className="bad-text small">{errors.map((e) => <li key={e}>{e}</li>)}</ul>}
      <button className="primary small" disabled={errors.length > 0 || yocto === null || !!busy} onClick={post}>Post the brief</button>
    </div>
  );
}

function ConstraintsForm({ s }: { s: Startup }) {
  const { state, run, busy } = useApp();
  const c = s.constraints;
  const [cap, setCap] = useState(fmtNear(c.campaign_cap, 6));
  const [maxPayout, setMaxPayout] = useState(fmtNear(c.max_payout, 6));
  const [perHour, setPerHour] = useState(String(c.payouts_per_hour));
  const [floorPct, setFloorPct] = useState(String(c.min_bid_bps / 100));
  const [holderMin, setHolderMin] = useState(fmtTokens(c.min_holder_tokens, 6));
  const capY = tryNear(cap);
  const payY = tryNear(maxPayout);
  const holdR = tryTokens(holderMin);
  const bps = Math.round(Number(floorPct) * 100);
  const next: Constraints | null = capY !== null && payY !== null && holdR !== null && floorPct.trim() !== '' && Number.isFinite(bps)
    ? { campaign_cap: capY.toString(), max_payout: payY.toString(), payouts_per_hour: Number(perHour), min_bid_bps: bps, min_holder_tokens: holdR.toString() }
    : null;
  const errors = next ? constraintErrors(next) : ['enter a number in every field'];
  const same = !!next && next.campaign_cap === c.campaign_cap && next.max_payout === c.max_payout && next.payouts_per_hour === c.payouts_per_hour && next.min_bid_bps === c.min_bid_bps && next.min_holder_tokens === c.min_holder_tokens;
  const sym = s.id.toUpperCase();
  return (
    <div className="founder-form" data-tour="founder-constraints">
      <h3>Treasury constraints</h3>
      <p className="muted small">Hard limits in the contract: campaign cap up to 1,000 NEAR; per-payout cap above 0 (a larger payout is held); 1 to 60 payouts an hour (more are held); credible-bid floor up to 90% of the budget; holder minimum 1 {sym} to 1% of the supply. Changes apply to future briefs, bids and payouts and are written to the audit log.</p>
      <div className="form-grid">
        <label className="field"><span>Largest campaign budget (NEAR)</span><input inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} /></label>
        <label className="field"><span>Largest single payout (NEAR)</span><input inputMode="decimal" value={maxPayout} onChange={(e) => setMaxPayout(e.target.value)} /></label>
        <label className="field"><span>Payouts per hour</span><input inputMode="numeric" value={perHour} onChange={(e) => setPerHour(e.target.value.replace(/\D/g, ''))} /></label>
        <label className="field"><span>Credible bid floor (% of budget)</span><input inputMode="decimal" value={floorPct} onChange={(e) => setFloorPct(e.target.value)} /></label>
        <label className="field"><span>To join the holders ({sym})</span><input inputMode="decimal" value={holderMin} onChange={(e) => setHolderMin(e.target.value)} /></label>
      </div>
      {errors.length > 0 && <ul className="bad-text small">{errors.map((e) => <li key={e}>{e}</li>)}</ul>}
      <button className="primary small" disabled={errors.length > 0 || same || !!busy} onClick={() => void run('Set constraints', () => call(state!.hub, 'set_constraints', { startup: s.id, constraints: next }))}>Save constraints</button>
    </div>
  );
}
