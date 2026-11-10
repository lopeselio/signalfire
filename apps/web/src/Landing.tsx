import { fmtNear, fmtTusd } from '@signalfire/core';
import { Wire } from './Wire.tsx';
import { Terms, useApp } from './ui.tsx';

// The landing: the pitch, the treasury drawn as a beacon (fees in, split into free / committed / paid),
// live numbers, and how the loop works.

function Beacon() {
  const { state } = useApp();
  const t = state!.totals;
  const free = Number(BigInt(t.available)) / 1e24;
  const committed = Number(BigInt(t.committed)) / 1e24;
  const paid = Number(BigInt(t.paid)) / 1e24;
  const total = free + committed + paid || 1;
  const h = (v: number): string => `${Math.max(v > 0 ? 4 : 0, (v / total) * 100)}%`;
  return (
    <div className="beacon" aria-label="Where the trading fees went">
      <div className="beacon-col">
        <div className="seg paid" style={{ height: h(paid) }} />
        <div className="seg committed" style={{ height: h(committed) }} />
        <div className="seg free" style={{ height: h(free) }} />
      </div>
      <dl className="beacon-key">
        <div><dt><i className="k free" />Free to fund campaigns</dt><dd>{fmtNear(t.available, 3)} NEAR</dd></div>
        <div><dt><i className="k committed" />Reserved for funded campaigns</dt><dd>{fmtNear(t.committed, 3)} NEAR</dd></div>
        <div><dt><i className="k paid" />Paid to creators</dt><dd>{fmtNear(t.paid, 3)} NEAR <small>as {fmtTusd(t.tusdPaid)} tUSD</small></dd></div>
        <div className="founders"><dt><i className="k none" />Paid to founders</dt><dd>0 NEAR, by design</dd></div>
      </dl>
    </div>
  );
}

const STEPS = [
  { t: 'Trade the attention token', b: 'Buy or sell on a bonding curve. Price follows the supply; every token can always be sold back.' },
  { t: '2% of every trade goes to the marketing treasury', b: 'Fees are held by the hub contract for that startup. No key, method or role can send them to the founders.' },
  { t: 'Vetted creators bid in a sealed auction', b: 'People and AI creator agents seal a price and a pitch, then reveal. The contract picks the lowest reputation-weighted credible bid.' },
  { t: 'Holders vote in the startup’s Sputnik DAO', b: 'The winning bid becomes a DAO proposal. A majority of holders funds it; nobody can propose a plain transfer.' },
  { t: 'Payouts follow results, then a receipt', b: 'First-time buyers through the creator’s link unlock three milestones, paid in tUSD through the spend policy and its audit log. The last one mints a receipt NFT.' },
];

export function Landing() {
  const { state, go } = useApp();
  const s = state!;
  const demo = s.startups.find((x) => x.id === s.demo);
  const t = s.totals;
  return (
    <div className="landing">
      <section className="hero">
        <div className="hero-text">
          <h1>Community attention becomes a marketing budget the founders can’t pocket.</h1>
          <p className="lede">
            Startups on Signalfire launch an attention token. Trading it pays a fee into a marketing treasury that only
            campaigns can spend. Creators compete for those campaigns, holders pick the winner, and the money moves only
            when new buyers actually show up.
          </p>
          <div className="row">
            <button className="primary" onClick={() => go(`/s/${s.demo}`)}>Open {demo?.name ?? s.demo.toUpperCase()}</button>
            <button className="ghost" onClick={() => go('/dashboard')}>See the data</button>
          </div>
          <Terms />
        </div>
        <Beacon />
      </section>

      <section className="stats" aria-label="Live numbers from the chain">
        <div><span className="n">{fmtNear(t.feesIn, 3)}<small> NEAR</small></span><span className="l">fees and forfeited bonds in</span></div>
        <div><span className="n">{fmtNear(t.available, 3)}<small> NEAR</small></span><span className="l">in treasuries, free</span></div>
        <div><span className="n">{t.funded}</span><span className="l">campaigns funded by holders</span></div>
        <div><span className="n">{t.costPerResult ? <>{fmtNear(t.costPerResult, 4)}<small> NEAR</small></> : 'none yet'}</span><span className="l">cost per new buyer</span></div>
      </section>

      <div className="split">
        <section className="how">
          <h2>How it works</h2>
          <ol className="steps">
            {STEPS.map((x, i) => (
              <li key={i}><span className="step-n">{i + 1}</span><div><h3>{x.t}</h3><p>{x.b}</p></div></li>
            ))}
          </ol>
          <p className="muted">
            The model on NEAR AI Cloud writes the scout’s vetting notes and the creators’ pitches, each signed inside its TEE.
            It never decides who gets money: the contract’s rules do.
          </p>
        </section>
        <Wire limit={14} />
      </div>
    </div>
  );
}
