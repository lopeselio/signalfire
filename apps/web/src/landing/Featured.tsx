import { MILESTONES, fmtNear, threshold } from '@signalfire/core';
import type { Campaign } from '../api.ts';
import { StartupLogo } from '../Discover.tsx';
import { nameOf, nextBrief } from '../tour/state.ts';
import { fmtLeft, useApp, useNow } from '../ui.tsx';
import { campaignStage, type Stage } from './stage.ts';

// The landing's "happening now" card: the one campaign people can act on, with a countdown, its progress toward
// new buyers and one big button. With nothing open it says when the next brief is due.

const HEAD: Record<Exclude<Stage, 'next' | 'paid'>, string> = {
  offers: 'Taking offers now',
  picking: 'Picking the winner',
  running: 'Running now',
};

/** Scrolls to a panel once the page has rendered it. */
function scrollWhenReady(sel: string): void {
  let k = 0;
  const t = setInterval(() => {
    const el = document.querySelector(sel);
    if (el || ++k > 20) { clearInterval(t); el?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  }, 150);
}

export function Featured() {
  const { state, me, account, go, signIn } = useApp();
  const now = useNow(1000);
  const s = state!;
  const order: Stage[] = ['offers', 'picking', 'running'];
  const pick = s.campaigns
    .map((c) => ({ c, st: campaignStage(c, now) }))
    .filter((x): x is { c: Campaign; st: 'offers' | 'picking' | 'running' } => x.st !== null && x.st !== 'next' && x.st !== 'paid')
    .sort((a, b) => order.indexOf(a.st) - order.indexOf(b.st) || b.c.id - a.c.id)[0];

  if (!pick) {
    const n = nextBrief(s, now);
    return (
      <article className="now-card quiet" aria-label="Next campaign">
        <span className="now-tag">Between campaigns</span>
        <h3>The next brief opens {n ? n.when : 'when a founder posts one'}</h3>
        <p className="muted">{n?.startup ? <>Probably for <strong>{nameOf(s, n.startup)}</strong>. </> : null}Creators get about a minute and a half to seal their offers, so check back then, or launch your own startup and post a brief now.</p>
        <div className="row">
          <button className="primary big" onClick={() => go(n?.startup ? `/s/${n.startup}` : '/discover')}>{n?.startup ? `Meet ${nameOf(s, n.startup)}` : 'Explore startups'}</button>
        </div>
      </article>
    );
  }

  const { c, st } = pick;
  const sym = c.startup.toUpperCase();
  const name = nameOf(s, c.startup);
  const pct = Math.round((Math.min(c.results, c.target) / Math.max(1, c.target)) * 100);
  const ends = st === 'offers' ? c.commit_ends_ms : st === 'running' ? c.deadline_ms : c.phase === 'bidding' ? c.reveal_ends_ms : null;
  const clock = ends ? `${st === 'offers' ? 'Offers close in' : st === 'running' ? 'Ends in' : 'Opening offers:'} ${fmtLeft(ends - now)}` : st === 'picking' ? 'Holders are voting' : null;
  const creator = !!me?.creator && !me.creator.creator.revoked;
  const big = !account
    ? { label: 'Sign in to take part', act: () => void signIn() }
    : st === 'offers' && creator
      ? { label: 'Seal an offer', act: () => { go(`/s/${c.startup}?tab=treasury`); scrollWhenReady('[data-tour="campaigns"]'); } }
      : { label: `Buy ${sym} tokens`, act: () => { go(`/s/${c.startup}?tab=market`); scrollWhenReady('[data-tour="trade"]'); } };
  const budget = c.price !== '0' ? c.price : c.budget;
  return (
    <article className={`now-card ${st}`} aria-label={HEAD[st]}>
      <div className="now-top">
        <span className="now-tag"><i className="pulse" aria-hidden="true" />{HEAD[st]}</span>
        {clock && <span className="now-clock" aria-live="off">{clock}</span>}
      </div>
      <div className="now-who">
        <StartupLogo id={c.startup} size={40} />
        <div>
          <h3>{c.title}</h3>
          <p className="muted small">{name} · campaign #{c.id}</p>
        </div>
      </div>
      <div className="now-goal">
        <div className="now-nums">
          <span><b>{c.results}</b> of {c.target} new buyers</span>
          <span>{fmtNear(budget, 3)} NEAR {c.price !== '0' ? 'winning offer' : 'budget'}</span>
        </div>
        <div className="now-bar" role="progressbar" aria-valuemin={0} aria-valuemax={c.target} aria-valuenow={Math.min(c.results, c.target)} aria-label="New buyers so far">
          <span style={{ width: `${pct}%` }} />
          {Array.from({ length: MILESTONES - 1 }, (_, k) => <i key={k} style={{ left: `${(threshold(c.target, k + 1) / c.target) * 100}%` }} title={`Payout ${k + 1} at ${threshold(c.target, k + 1)} new buyers`} />)}
        </div>
        <p className="muted small">The creator is paid in {MILESTONES} parts as new buyers arrive through their link.</p>
      </div>
      <button className="primary big wide" onClick={big.act}>{big.label}</button>
      <button className="link small" onClick={() => { go(`/s/${c.startup}?tab=treasury`); scrollWhenReady('[data-tour="campaigns"]'); }}>See the brief and every offer</button>
    </article>
  );
}
