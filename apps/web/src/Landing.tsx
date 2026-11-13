import { MILESTONES, fmtNear, fmtTusd, threshold } from '@signalfire/core';
import { StartupCard, StartupLogo } from './Discover.tsx';
import { useEvidenceSummaries } from './EvidenceChips.tsx';
import { Featured } from './landing/Featured.tsx';
import { useTrades24h } from './landing/stage.ts';
import './landing/landing.css';
import { Count, useReveal } from './motion.tsx';
import { SignalFire } from './SignalFire.tsx';
import { Wire } from './Wire.tsx';
import { Terms, useApp } from './ui.tsx';
import { NextAction } from './NextAction.tsx';

// The landing: one big line, two buttons and three live numbers; the campaign you can act on right now next to where
// the trading fees went; how it works in three steps (the exact terms one click away); startups; the live wire.

function Beacon() {
  const { state } = useApp();
  const t = state!.totals;
  const free = Number(BigInt(t.available)) / 1e24;
  const committed = Number(BigInt(t.committed)) / 1e24;
  const paid = Number(BigInt(t.paid)) / 1e24;
  const total = free + committed + paid || 1;
  const w = (v: number): string => `${Math.max(v > 0 ? 3 : 0, (v / total) * 100)}%`;
  return (
    <div className="beacon-card" data-tour="beacon" aria-label="Where the trading fees went">
      <div className="bc-head">
        <span className="bc-title">Marketing funds</span>
        <span className="chip ok">live from NEAR</span>
      </div>
      <span className="bc-big"><Count value={fmtNear(t.feesIn, 3)} /><small> NEAR collected from trading fees</small></span>
      <div className="bc-bar" aria-hidden="true">
        <span className="seg paid" style={{ width: w(paid) }} />
        <span className="seg committed" style={{ width: w(committed) }} />
        <span className="seg free" style={{ width: w(free) }} />
      </div>
      <dl className="bc-key">
        <div><dt><i className="k free" />Available for campaigns</dt><dd>{fmtNear(t.available, 3)} NEAR</dd></div>
        <div><dt><i className="k committed" />Set aside for approved campaigns</dt><dd>{fmtNear(t.committed, 3)} NEAR</dd></div>
        <div><dt><i className="k paid" />Paid to creators</dt><dd>{fmtNear(t.paid, 3)} NEAR <small>as {fmtTusd(t.tusdPaid)} tUSD (test dollars)</small></dd></div>
        <div className="founders"><dt><i className="k none" />Paid to founders</dt><dd>0 NEAR, by design</dd></div>
      </dl>
    </div>
  );
}

function TokenCard() {
  const { state } = useApp();
  const s = state!.startups.find((x) => x.id === state!.demo) ?? state!.startups[0];
  if (!s) return null;
  return (
    <div className="pc">
      <div className="pc-head"><StartupLogo id={s.id} size={26} /><strong>{s.name}</strong><span className="chip">{s.id.toUpperCase()}</span></div>
      <dl className="pc-terms">
        <div><dt>What it is</dt><dd>Attention, not equity</dd></div>
        <div><dt>Trading fee</dt><dd>2% to the marketing fund</dd></div>
        <div><dt>To the founders</dt><dd>0</dd></div>
        <div><dt>Supply</dt><dd>1,000,000, fixed</dd></div>
      </dl>
      <p className="pc-foot">Terms fixed by Signalfire’s contract at launch. No one can change them.</p>
    </div>
  );
}

function TreasuryCard() {
  const { state } = useApp();
  const s = state!.startups.find((x) => x.id === state!.demo) ?? state!.startups[0];
  if (!s) return null;
  const c = s.constraints;
  return (
    <div className="pc">
      <div className="pc-head"><strong>Spend limits</strong><span className="chip ok">enforced by code</span></div>
      <ul className="pc-rules">
        <li><span>Largest campaign</span><b>{fmtNear(c.campaign_cap, 2)} NEAR</b></li>
        <li><span>Largest single payment</span><b>{fmtNear(c.max_payout, 2)} NEAR</b></li>
        <li><span>Payments per hour</span><b>{c.payouts_per_hour}</b></li>
        <li><span>Who can be paid</span><b>the winning creator only</b></li>
      </ul>
      <p className="pc-foot">Every payment attempt is written to a public audit log</p>
    </div>
  );
}

function CampaignCard() {
  const { state } = useApp();
  const s = state!;
  const order = ['funded', 'voting', 'bidding', 'done'];
  const c = [...s.campaigns].sort((a, b) => order.indexOf(a.phase) - order.indexOf(b.phase) || b.id - a.id).find((x) => order.includes(x.phase));
  if (!c) return null;
  const st = s.startups.find((x) => x.id === c.startup);
  const pct = Math.round((Math.min(c.results, c.target) / c.target) * 100);
  const label: Record<string, string> = { bidding: 'Sealed offers', voting: 'Holders vote', funded: 'Creator at work', done: 'Paid out' };
  return (
    <div className="pc">
      <div className="pc-head"><strong>Campaign #{c.id}</strong><span className={`chip ${c.phase === 'done' ? 'ok' : 'ember'}`}>{label[c.phase]}</span></div>
      <p className="pc-title">{st && <StartupLogo id={st.id} size={18} />}<span>{c.title}</span></p>
      <div className="pc-progress">
        <div className="pc-nums"><span>{c.results}/{c.target} new buyers</span><span>{fmtNear(c.paid, 3)} / {fmtNear(c.price !== '0' ? c.price : c.budget, 3)} NEAR</span></div>
        <div className="pc-bar"><span style={{ width: `${pct}%` }} /></div>
        <div className="pc-ms">{Array.from({ length: MILESTONES }, (_, k) => <i key={k} className={c.milestones_paid > k ? 'on' : ''} title={`Payout ${k + 1} of 3 at ${threshold(c.target, k + 1)} new buyers`} />)}</div>
      </div>
      <p className="pc-foot">Sealed offers, a holders’ vote, then paid as new buyers arrive</p>
    </div>
  );
}

/** The three steps, told as things people do. The exact rules are one click away, under "The fine print". */
const STEPS = [
  { t: 'Back a startup you believe in', b: 'Buy its attention token. 2% of every trade drops into the startup’s marketing fund, and the founders can’t take it out.' },
  { t: 'Creators pitch, holders pick', b: 'Reviewed creators seal their offers for a brief. The fairest offer wins, and the holders vote to fund it.' },
  { t: 'Paid per new customer', b: 'The winner is paid in three parts, each one only after more new buyers arrive through their link.' },
];

// The project's tagline leads (the user's choice over "Turn buzz into real customers.").
const SUBLINE = 'Back a startup by buying its attention token. Every trade fills its marketing fund, and creators earn from it only by bringing in new buyers.';

export function Landing() {
  const { state, go } = useApp();
  const s = state!;
  const t = s.totals;
  const now = Date.now();
  const live = s.startups.filter((x) => x.status === 'live');
  const held = (x: (typeof live)[number]): bigint => BigInt(x.available) + BigInt(x.committed);
  const featured = [...live].sort((a, b) => (held(b) > held(a) ? 1 : held(b) < held(a) ? -1 : 0)).slice(0, 6);
  const rv = useReveal<HTMLDivElement>();
  const reached = s.campaigns.filter((c) => c.phase === 'done' || c.phase === 'expired').reduce((a, c) => a + c.results, 0);
  const ev = useEvidenceSummaries();
  const trades = useTrades24h(featured.map((x) => x.id));
  return (
    <div className="landing" ref={rv}>
      <section className="hero">
        <div className="hero-text">
          <p className="eyebrow">Attention tokens on NEAR · not equity</p>
          <h1>Community attention becomes a marketing budget <em>the founders can’t pocket.</em></h1>
          <p className="lede">{SUBLINE}</p>
          <div className="row ld-cta">
            <button className="primary ld-big" onClick={() => go('/discover')}>Explore startups</button>
            <button className="ghost ld-big" onClick={() => go('/launch')}>Launch yours</button>
          </div>
          <dl className="ld-nums" aria-label="Live totals from NEAR">
            <div><dt>NEAR into marketing funds</dt><dd><Count value={fmtNear(t.feesIn, 3)} /></dd></div>
            <div><dt>new buyers brought in</dt><dd><Count value={String(reached)} /></dd></div>
            <div><dt>NEAR paid to creators</dt><dd><Count value={fmtNear(t.paid, 3)} /></dd></div>
          </dl>
          <NextAction page="home" />
        </div>
        <div className="hero-art">
          <SignalFire />
        </div>
      </section>

      <section className="ld-now rv" aria-label="Happening now">
        <div className="sec-head"><h2>Happening now</h2><button className="ghost small" onClick={() => go('/discover')}>Every campaign</button></div>
        <div className="ld-now-grid">
          <Featured />
          <Beacon />
        </div>
        <Terms />
      </section>

      <section className="ld-steps rv" aria-label="How it works in 3 steps">
        <h2>How it works, in 3 steps</h2>
        <ol>
          {STEPS.map((x, i) => <li key={x.t}><span className="ld-step-n" aria-hidden="true">{i + 1}</span><h3>{x.t}</h3><p>{x.b}</p></li>)}
        </ol>
        <details className="tech ld-fine">
          <summary>The fine print: token terms, spend limits and a real campaign</summary>
          <div className="story-panel">
            <TokenCard />
            <TreasuryCard />
            <CampaignCard />
          </div>
          <p className="muted small story-ai">
            An AI on NEAR AI Cloud writes the scout’s review notes and the AI creators’ pitches, each signed inside secure
            hardware you can check from your browser. The AI never decides who gets money: the contract’s rules do.
            Full walkthrough: <a href="/how" onClick={(e) => { e.preventDefault(); go('/how'); }}>How it works</a>. Try the numbers
            yourself: <a href="/plan" onClick={(e) => { e.preventDefault(); go('/plan'); }}>Plan a campaign</a>.
          </p>
        </details>
      </section>

      <section className="featured rv" aria-label="Startups">
        <div className="sec-head">
          <h2>Find a startup to back</h2>
          <button className="ghost small" onClick={() => go('/discover')}>See all {live.length}</button>
        </div>
        <div className="s-grid">{featured.map((x) => <StartupCard key={x.id} s={x} ev={ev} trades={trades?.[x.id]} now={now} />)}</div>
      </section>

      <Wire limit={12} />
    </div>
  );
}
