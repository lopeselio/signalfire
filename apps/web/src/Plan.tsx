import { useState } from 'react';
import {
  BID_BOND, FEE_BPS, MILESTONES, YOCTO, fmtNear, fmtTusd, milestoneAmount, repBps, score, threshold, tusdFor,
} from '@signalfire/core';
import { NextAction } from './NextAction.tsx';
import { Info, useApp } from './ui.tsx';
import './landing/landing.css';
import './plan.css';

// Plan a campaign: sliders for a brief's budget, target and offer window, and what the hub's rules make of them.
// Read-only: nothing here signs or sends a transaction. Every number comes from packages/core, which mirrors
// contracts/hub/src/rules.rs byte for byte (shared test vectors in both suites):
//   payout per milestone   milestoneAmount(price, k)       ← rules.rs milestone_amount
//   buyers per milestone   threshold(target, k) = ⌈t·k/3⌉  ← rules.rs threshold
//   lowest offer that wins budget·min_bid_bps/10⁴          ← rules.rs credible (lower bound)
//   offer bond             BID_BOND = 0.02 NEAR            ← rules.rs BID_BOND; lib.rs commit_bid / reveal_bid
//   track-record bonus     repBps(done, missed), score()   ← rules.rs rep_bps, score
//   trading to fill a fund budget·10⁴/FEE_BPS (2%)         ← curve.rs FEE_BPS (quoteBuy/quoteSell take 2% of each trade)
//   payout in test dollars tusdFor(yocto)                  ← rules.rs tusd_for

const MILLI = 10n ** 21n; // 0.001 NEAR, the budget slider's step
const near = (y: bigint, d = 3): string => fmtNear(y, d);

/** The track records shown in the bonus table: [delivered, missed]. */
const RECORDS: [number, number][] = [[0, 0], [1, 0], [2, 0], [4, 0], [6, 0], [0, 1]];

export function Plan() {
  const { state, account, go } = useApp();
  const s = state!;
  const live = s.startups.filter((x) => x.status === 'live');
  const mine = account ? live.find((x) => x.founder === account) : undefined;
  const [id, setId] = useState(mine?.id ?? s.demo);
  const st = live.find((x) => x.id === id) ?? live[0];
  const cap = BigInt(st?.constraints.campaign_cap ?? (2n * YOCTO).toString());
  const minBps = st?.constraints.min_bid_bps ?? 2000;
  const capMilli = Number(cap / MILLI) || 1;
  const [budgetMilli, setBudgetMilli] = useState(Math.min(capMilli, 60));
  const [target, setTarget] = useState(3);
  const [windowMin, setWindowMin] = useState(10);
  const [offerPct, setOfferPct] = useState(Math.max(60, Math.ceil(minBps / 100)));

  const bm = Math.min(budgetMilli, capMilli);
  const budget = BigInt(bm) * MILLI;
  const minOffer = (budget * BigInt(minBps)) / 10_000n; // rules.rs credible: price ≥ budget·min_bid_bps/10⁴
  const minPct = Math.max(1, Math.ceil(minBps / 100)); // a zero offer is never credible (price > 0)
  const pct = Math.max(offerPct, minPct);
  const offer = (budget * BigInt(pct)) / 100n; // an example winning offer, a share of the budget
  const fill = (budget * 10_000n) / FEE_BPS; // 2% of every trade goes to the fund
  const free = BigInt(st?.available ?? '0');
  const short = budget > free ? budget - free : 0n;
  const newcomer = score(offer, 0);
  const sym = st?.id.toUpperCase() ?? '';

  return (
    <div className="plan">
      <section className="page-head">
        <p className="eyebrow">Plan a campaign</p>
        <h1>See what your budget buys before you post</h1>
        <p className="lede">
          Drag the sliders. Every number below comes from the same rules Signalfire’s contract runs, so this is exactly
          how a brief with these settings would pay out. Nothing here sends a transaction.
        </p>
        <NextAction page="plan" />
      </section>

      <div className="plan-grid">
        <section className="panel plan-controls" aria-label="Your brief">
          <h2>Your brief</h2>
          <label className="field"><span>For which startup</span>
            <select value={st?.id} onChange={(e) => setId(e.target.value)}>
              {live.map((x) => <option key={x.id} value={x.id}>{x.name} ({x.id.toUpperCase()}){x.id === mine?.id ? ', yours' : ''}</option>)}
            </select>
          </label>
          <Slider label="Budget" value={`${near(budget)} NEAR`} min={1} max={capMilli} step={1} v={bm} set={setBudgetMilli}
            hint={`Up to ${near(cap, 2)} NEAR, ${st?.name ?? 'this startup'}’s largest campaign.`} />
          <Slider label="New buyers wanted" value={String(target)} min={1} max={60} step={1} v={target} set={setTarget}
            hint="People buying the token for the first time through the creator’s link." />
          <Slider label="Time to send offers" value={`${windowMin} min`} min={1} max={120} step={1} v={windowMin} set={setWindowMin}
            hint="Creators seal their offers in this window; then there’s a short window to open them." />
          <Slider label="Example winning offer" value={`${pct}% · ${near(offer)} NEAR`} min={minPct} max={100} step={1} v={pct} set={setOfferPct}
            hint="Creators name their own price, up to the budget. Try a few." />
        </section>

        <div className="plan-out">
          <section className="panel plan-card plan-lead" aria-label="What the creator earns">
            <h2>The creator earns {near(offer)} NEAR, in {MILESTONES} parts</h2>
            <ol className="plan-ms step-path vertical">
              {Array.from({ length: MILESTONES }, (_, i) => {
                const k = i + 1;
                const amt = milestoneAmount(offer, k);
                return (
                  <li key={k}>
                    <span className="sp-node" aria-hidden="true">{k}</span>
                    <span className="pm-when">at <b>{threshold(target, k)}</b> new buyer{threshold(target, k) === 1 ? '' : 's'}</span>
                    <span className="pm-amt"><b>{near(amt, 4)}</b> NEAR <small>paid as {fmtTusd(tusdFor(amt))} tUSD</small></span>
                  </li>
                );
              })}
            </ol>
            <p className="muted small">That’s about <b>{near(offer / BigInt(Math.max(1, target)), 4)} NEAR per new buyer</b>. Whatever isn’t earned by the deadline goes back to the marketing fund.<Info text="threshold(target, k) = ⌈target·k/3⌉ and milestone_amount(price, k): a third of the winning price, the last part takes the remainder (contracts/hub/src/rules.rs). Paid in tUSD at the test rate 1 NEAR = 3 tUSD (tusd_for)." /></p>
          </section>

          <section className="panel plan-card" aria-label="Lowest offer that can win">
            <h3>Offers must be at least {near(minOffer)} NEAR</h3>
            <p className="small">{sym}’s floor is {minBps / 100}% of the budget, so lowball offers can’t win. Offers above the budget don’t count either.<Info text={`credible(price, budget, min_bid_bps): budget·${minBps}/10,000 ≤ price ≤ budget (rules.rs credible)`} /></p>
          </section>

          <section className="panel plan-card" aria-label="Offer bond">
            <h3>Each offer holds a {near(BID_BOND, 2)} NEAR bond</h3>
            <p className="small">A creator puts it down when sealing an offer and gets it back when they open it on time. If they never open it, it goes to {sym}’s marketing fund.<Info text="BID_BOND = 0.02 NEAR, locked in commit_bid, returned in reveal_bid, forfeited to the treasury at settle_auction (contracts/hub/src/lib.rs)" /></p>
          </section>

          <section className="panel plan-card" aria-label="Track-record bonus">
            <h3>A good track record lets a creator ask more</h3>
            <p className="small">Offers are compared after a bonus for campaigns delivered (and a penalty for misses). Against a newcomer offering {near(offer)} NEAR:</p>
            <table className="tbl plan-rep">
              <thead><tr><th>Creator’s record</th><th>Bonus</th><th>Still wins up to</th></tr></thead>
              <tbody>
                {RECORDS.map(([d, m]) => {
                  const rep = repBps(d, m);
                  // the highest price whose score still beats the newcomer's: score(q, rep) < score(offer, 0)
                  let q = (offer * BigInt(10_000 + rep)) / 10_000n;
                  while (q > 0n && score(q, rep) >= newcomer && !(d === 0 && m === 0)) q -= 1n;
                  const capped = q > budget ? budget : q;
                  return (
                    <tr key={`${d}-${m}`}>
                      <td>{m ? `${m} missed` : d === 0 ? 'New creator' : `${d} delivered`}</td>
                      <td>{rep === 0 ? '0%' : `${rep > 0 ? '+' : ''}${rep / 100}%`}</td>
                      <td>{d === 0 && m === 0 ? `${near(offer)} NEAR (a tie: the earlier offer wins)` : `${near(capped)} NEAR${q > budget ? ' (the budget)' : ''}`}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="muted small">+5% per campaign delivered, −10% per miss, between −20% and +30%.<Info text="rep_bps = clamp(500·completed − 1000·missed, −2000, 3000); score = price·10⁴/(10⁴ + rep_bps), lowest score wins (rules.rs rep_bps, score)" /></p>
          </section>

          <section className="panel plan-card" aria-label="Trading needed">
            <h3>{near(fill, 2)} NEAR of trading fills this budget</h3>
            <p className="small">
              2% of every buy and sell of {sym} goes to its marketing fund. {st?.name} has {near(free)} NEAR free right now
              {short > 0n ? <>, so it needs about <b>{near((short * 10_000n) / FEE_BPS, 2)} NEAR</b> more trading first.</> : <>, enough for this budget today.</>}
              <Info text="FEE_BPS = 200: fee = trade·200/10,000 on every buy and sell (curve.rs, core quoteBuy/quoteSell). Budget·10,000/200 = budget × 50." />
            </p>
          </section>

          <section className="panel plan-card" aria-label="Timeline">
            <h3>How it plays out</h3>
            <ol className="plan-time">
              <li><b>{windowMin} min</b> for creators to seal offers</li>
              <li>Offers opened and the winner picked by the contract’s rule</li>
              <li>{sym}’s holders vote to fund it</li>
              <li>Paid at {Array.from({ length: MILESTONES }, (_, i) => threshold(target, i + 1)).join(', ')} new buyers</li>
            </ol>
          </section>

          <div className="row">
            {mine
              ? <button className="primary ld-big" onClick={() => go(`/s/${mine.id}?tab=treasury`)}>Post a brief for {mine.name}</button>
              : <button className="primary ld-big" onClick={() => go('/launch')}>Launch your startup</button>}
            <button className="ghost" onClick={() => go('/how')}>How campaigns work</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Slider({ label, value, hint, min, max, step, v, set }: { label: string; value: string; hint: string; min: number; max: number; step: number; v: number; set: (n: number) => void }) {
  return (
    <label className="plan-slider">
      <span className="ps-top"><span>{label}</span><b>{value}</b></span>
      <input type="range" min={min} max={max} step={step} value={v} onChange={(e) => set(Number(e.target.value))} />
      <span className="muted small">{hint}</span>
    </label>
  );
}
