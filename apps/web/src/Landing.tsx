import { MILESTONES, fmtNear, fmtTusd, threshold } from '@signalfire/core';
import { StartupCard, StartupLogo } from './Discover.tsx';
import { Wire } from './Wire.tsx';
import { Terms, useApp } from './ui.tsx';

// The landing: the pitch, where trading fees go, a few startups, the totals, the loop told as three small
// product cards (token terms, the treasury's spend policy, a campaign), and the live wire.

function Beacon() {
  const { state } = useApp();
  const t = state!.totals;
  const free = Number(BigInt(t.available)) / 1e24;
  const committed = Number(BigInt(t.committed)) / 1e24;
  const paid = Number(BigInt(t.paid)) / 1e24;
  const total = free + committed + paid || 1;
  const w = (v: number): string => `${Math.max(v > 0 ? 3 : 0, (v / total) * 100)}%`;
  return (
    <div className="beacon-card" aria-label="Where the trading fees went">
      <div className="bc-head">
        <span className="bc-title">Marketing treasuries</span>
        <span className="chip ok">live from testnet</span>
      </div>
      <span className="bc-big">{fmtNear(t.feesIn, 3)}<small> NEAR in from trading fees</small></span>
      <div className="bc-bar" aria-hidden="true">
        <span className="seg paid" style={{ width: w(paid) }} />
        <span className="seg committed" style={{ width: w(committed) }} />
        <span className="seg free" style={{ width: w(free) }} />
      </div>
      <dl className="bc-key">
        <div><dt><i className="k free" />Free to fund campaigns</dt><dd>{fmtNear(t.available, 3)} NEAR</dd></div>
        <div><dt><i className="k committed" />Reserved for funded campaigns</dt><dd>{fmtNear(t.committed, 3)} NEAR</dd></div>
        <div><dt><i className="k paid" />Paid to creators</dt><dd>{fmtNear(t.paid, 3)} NEAR <small>as {fmtTusd(t.tusdPaid)} tUSD</small></dd></div>
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
        <div><dt>Trading fee</dt><dd>2% to marketing</dd></div>
        <div><dt>To the founders</dt><dd>0</dd></div>
        <div><dt>Supply</dt><dd>1,000,000, fixed</dd></div>
      </dl>
      <p className="pc-foot">Terms set by the hub contract at launch</p>
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
      <div className="pc-head"><strong>Spend policy</strong><span className="chip ok">enforced</span></div>
      <ul className="pc-rules">
        <li><span>Largest campaign</span><b>{fmtNear(c.campaign_cap, 2)} NEAR</b></li>
        <li><span>Largest payout</span><b>{fmtNear(c.max_payout, 2)} NEAR</b></li>
        <li><span>Payouts per hour</span><b>{c.payouts_per_hour}</b></li>
        <li><span>Payees</span><b>winning creator only</b></li>
      </ul>
      <p className="pc-foot">Every attempt goes into the onchain audit log</p>
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
  const label: Record<string, string> = { bidding: 'Sealed bids', voting: 'Holders vote', funded: 'Running', done: 'Paid out' };
  return (
    <div className="pc">
      <div className="pc-head"><strong>Campaign #{c.id}</strong><span className={`chip ${c.phase === 'done' ? 'ok' : 'ember'}`}>{label[c.phase]}</span></div>
      <p className="pc-title">{st && <StartupLogo id={st.id} size={18} />}<span>{c.title}</span></p>
      <div className="pc-progress">
        <div className="pc-nums"><span>{c.results}/{c.target} new buyers</span><span>{fmtNear(c.paid, 3)} / {fmtNear(c.price !== '0' ? c.price : c.budget, 3)} NEAR</span></div>
        <div className="pc-bar"><span style={{ width: `${pct}%` }} /></div>
        <div className="pc-ms">{Array.from({ length: MILESTONES }, (_, k) => <i key={k} className={c.milestones_paid > k ? 'on' : ''} title={`milestone ${k + 1} at ${threshold(c.target, k + 1)} buyers`} />)}</div>
      </div>
      <p className="pc-foot">Sealed bids, a holders’ vote, then paid per milestone</p>
    </div>
  );
}

const STORY = [
  { n: '01', t: 'Token', b: 'A startup launches an attention token on a bonding curve. It is not equity and not a claim on anything: the founders get no tokens and no fees.' },
  { n: '02', t: 'Treasury', b: '2% of every trade lands in a marketing treasury inside the hub contract. A spend policy with caps, a payee allowlist and an audit log is the only way out.' },
  { n: '03', t: 'Campaign', b: 'Vetted creators seal bids for a brief, holders vote in the startup’s DAO, and the winner is paid in three milestones as new buyers arrive through their link.' },
];

export function Landing() {
  const { state, go } = useApp();
  const s = state!;
  const t = s.totals;
  const live = s.startups.filter((x) => x.status === 'live');
  const held = (x: (typeof live)[number]): bigint => BigInt(x.available) + BigInt(x.committed);
  const featured = [...live].sort((a, b) => (held(b) > held(a) ? 1 : held(b) < held(a) ? -1 : 0)).slice(0, 4);
  const reached = s.campaigns.filter((c) => c.phase === 'done' || c.phase === 'expired').reduce((a, c) => a + c.results, 0);
  return (
    <div className="landing">
      <section className="hero">
        <div className="hero-text">
          <p className="eyebrow">Attention tokens on NEAR</p>
          <h1>Community attention becomes a marketing budget <em>the founders can’t pocket.</em></h1>
          <p className="lede">
            Trading a startup’s attention token pays a fee into a marketing treasury. Vetted creators compete to run its
            campaigns, holders pick the winner, and the money moves only when new buyers show up.
          </p>
          <div className="row">
            <button className="primary" onClick={() => go('/discover')}>Discover startups</button>
            <button className="ghost" onClick={() => go(`/s/${s.demo}`)}>Open {s.startups.find((x) => x.id === s.demo)?.name ?? s.demo.toUpperCase()}</button>
          </div>
          <Terms />
        </div>
        <div className="hero-art">
          <Beacon />
        </div>
      </section>

      <section className="featured" aria-label="Startups">
        <div className="sec-head">
          <h2>Startups</h2>
          <button className="ghost small" onClick={() => go('/discover')}>View all {live.length}</button>
        </div>
        <div className="s-grid">{featured.map((x) => <StartupCard key={x.id} s={x} />)}</div>
      </section>

      <section className="mission" aria-label="Totals across all startups">
        <p className="eyebrow">The rule</p>
        <h2>Trading pays for reaching customers, <em>not founders.</em></h2>
        <p className="lede">Totals across every startup on the hub, read live from NEAR testnet.</p>
        <div className="mission-nums">
          <div><span className="n">{fmtNear(t.feesIn, 3)}</span><span className="l">NEAR into marketing treasuries</span></div>
          <div><span className="n">{fmtNear(t.paid, 3)}</span><span className="l">NEAR paid to creators</span></div>
          <div><span className="n">{reached}</span><span className="l">new buyers reached</span></div>
          <div><span className="n">{t.costPerResult ? fmtNear(t.costPerResult, 4) : '—'}</span><span className="l">NEAR per new buyer</span></div>
        </div>
      </section>

      <section className="story" aria-label="How it works">
        <h2>How it works</h2>
        <p className="lede">Three pieces, one contract: the token, the treasury it feeds, and the campaigns that spend it.</p>
        <div className="story-panel">
          <TokenCard />
          <TreasuryCard />
          <CampaignCard />
        </div>
        <ol className="story-steps">
          {STORY.map((x) => <li key={x.n}><span className="st-n">{x.n}</span><h3>{x.t}</h3><p>{x.b}</p></li>)}
        </ol>
        <p className="muted small story-ai">
          A model on NEAR AI Cloud writes the scout’s vetting notes and the creators’ pitches, each signed inside its TEE.
          It never decides who gets money: the contract’s rules do.
        </p>
      </section>

      <Wire limit={12} />
    </div>
  );
}
