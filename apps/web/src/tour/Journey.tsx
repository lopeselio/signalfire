import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { fmtNear, fmtTusd, milestoneAmount, threshold } from '@signalfire/core';
import { api, type Campaign, type State } from '../api.ts';
import { reducedMotion, useSeen } from '../motion.tsx';
import { shortAcct, useApp } from '../ui.tsx';
import './journey.css';

// The top of How it works: one finished campaign's journey as a step path, from a trade to the three payouts, with
// a small diagram per step. It plays once when it scrolls into view; then the reader clicks a step or uses ← →.
// The numbers are the most recent finished campaign's in /api/state; with none finished yet it says the numbers are
// made up. Under prefers-reduced-motion nothing plays and every diagram shows its final state.

interface Story {
  real: boolean; id: number | null; sym: string; name: string; trades: number; volume: string; fees: string;
  title: string; target: number; budget: string; offers: number; winner: string; price: string; yes: number; votes: number;
  results: number; payouts: { at: number; near: string }[]; tusd: string; startup: string | null;
}

const fromCampaign = (s: State, c: Campaign): Story => {
  const st = s.startups.find((x) => x.id === c.startup);
  const price = BigInt(c.price);
  const winner = s.creators.find((x) => x.creator.account === c.winner)?.creator.name ?? shortAcct(c.winner ?? 'a creator', s.hub);
  const votes = Object.values(c.proposal?.votes ?? {});
  return {
    real: true, id: c.id, sym: c.startup.toUpperCase(), name: st?.name ?? c.startup.toUpperCase(), trades: st?.trades ?? 0,
    volume: fmtNear(st?.volume ?? '0', 2), fees: fmtNear(st?.fees_in ?? '0', 3), title: c.title, target: c.target,
    budget: fmtNear(c.budget, 4), offers: c.bids.length, winner, price: fmtNear(price, 5), yes: votes.filter((v) => v === 'Approve').length,
    votes: votes.length, results: c.results, payouts: [1, 2, 3].map((k) => ({ at: threshold(c.target, k), near: fmtNear(milestoneAmount(price, k), 5) })),
    tusd: fmtTusd(c.paid_tusd, 4), startup: c.startup,
  };
};

const EXAMPLE: Story = {
  real: false, id: null, sym: 'GAME', name: 'an example game', trades: 40, volume: '12', fees: '0.24', title: 'Show the game to 3 new players',
  target: 3, budget: '0.02', offers: 3, winner: 'a creator', price: '0.012', yes: 2, votes: 2, results: 3,
  payouts: [{ at: 1, near: '0.004' }, { at: 2, near: '0.004' }, { at: 3, near: '0.004' }], tusd: '0.036', startup: null,
};

interface Step { key: string; short: string; title: string; more: string; text: ReactNode; scene: ReactNode }

const range = (n: number): number[] => Array.from({ length: Math.max(0, n) }, (_, i) => i);
const at = (i: number): CSSProperties => ({ '--i': i } as CSSProperties);

function steps(j: Story, privately: boolean | null): Step[] {
  const env = Math.min(j.offers, 5);
  const win = Math.min(1, env - 1);
  return [
    {
      key: 'trade', short: 'A trade', title: 'Someone trades the token', more: '#curve',
      text: <>Every buy or sell of {j.sym} goes through the hub’s price curve. {j.real ? <>{j.name} has had <strong>{j.trades} trades</strong>, {j.volume} NEAR in all.</> : <>Say {j.name} has had {j.trades} trades.</>}</>,
      scene: (
        <div className="jr-scene jr-trade">
          <svg viewBox="0 0 200 110" className="jr-curve">
            <path className="jr-axis" d="M14 98 H190 M14 98 V10" />
            <path className="jr-line" pathLength={1} d="M14 92 C 70 88, 120 64, 186 18" />
            {[[63, 83], [105, 67], [148, 43]].map(([x, y], k) => <circle key={k} className="jr-dot" r="7" cx={x} cy={y} style={at(k)} />)}
          </svg>
          <span className="jr-tag">buy {j.sym}</span>
        </div>
      ),
    },
    {
      key: 'fund', short: '2% to the fund', title: '2% goes into the marketing fund', more: '#treasury',
      text: <>2% of every trade goes into {j.real ? `${j.name}’s` : 'the startup’s'} marketing fund: <strong>{j.fees} NEAR</strong> so far. Nothing else goes in, and the founder can’t take any of it out.</>,
      scene: (
        <div className="jr-scene jr-fund">
          <div className="jr-jar"><span className="jr-fill" />{range(3).map((i) => <span key={i} className="jr-coin" style={at(i)} />)}</div>
          <span className="jr-tag">{j.fees} NEAR</span>
        </div>
      ),
    },
    {
      key: 'brief', short: 'A brief', title: 'The founder posts a brief', more: '#auction',
      text: <>“{j.title}”: bring <strong>{j.target} new buyers</strong>, with a budget of up to {j.budget} NEAR from the fund.</>,
      scene: (
        <div className="jr-scene jr-brief">
          <div className="jr-note">
            <b>{j.title}</b>
            <span className="jr-lines"><i /><i /><i /></span>
            <span className="jr-chips"><span className="chip ember">{j.target} new buyers</span><span className="chip sun">≤ {j.budget} NEAR</span></span>
          </div>
        </div>
      ),
    },
    {
      key: 'sealed', short: 'Sealed offers', title: 'Creators send sealed offers', more: '#auction',
      text: <><strong>{j.offers} sealed offer{j.offers === 1 ? '' : 's'}</strong> came in. Each price is sealed, so nobody can see it, other creators included.</>,
      scene: (
        <div className="jr-scene jr-envs">
          {range(env).map((i) => <span key={i} className="jr-env" style={at(i)}><span className="jr-lock" /></span>)}
        </div>
      ),
    },
    {
      key: 'score', short: privately === false ? 'A winner' : 'Private scoring', title: privately === false ? 'The rule picks the winner' : 'Private scoring picks the winner', more: '#auction',
      text: privately === false
        ? <>The offers were opened and the contract’s rule picked the best price once track records count: <strong>{j.winner}</strong> at {j.price} NEAR.</>
        : <>A scoring program in secure hardware read every offer, ranked them by price and track record, and opened only the winner’s: <strong>{j.winner}</strong> at {j.price} NEAR. The other prices were never seen.</>,
      scene: (
        <div className="jr-scene jr-envs jr-score">
          {range(env).map((i) => (
            <span key={i} className={`jr-env${i === win ? ' win' : ''}`} style={at(i)}>
              {i === win ? <span className="jr-price">{j.price} NEAR</span> : <span className="jr-lock" />}
            </span>
          ))}
        </div>
      ),
    },
    {
      key: 'vote', short: 'Holders vote', title: 'Holders vote to fund it', more: '#dao',
      text: <>The holders’ council voted: <strong>{j.yes} of {j.votes} said yes</strong>, so the DAO set the winning price aside from the fund. One holder, one vote.</>,
      scene: (
        <div className="jr-scene jr-vote">
          <div className="jr-ballots">{range(Math.min(j.votes, 6)).map((i) => <span key={i} className={`jr-ballot${i < j.yes ? ' yes' : ''}`} style={at(i)}>{i < j.yes ? '✓' : '✕'}</span>)}</div>
          <div className="jr-tally"><span style={{ '--jr-w': j.votes ? j.yes / j.votes : 0 } as CSSProperties} /></div>
          <span className="jr-tag">{j.yes} of {j.votes} yes</span>
        </div>
      ),
    },
    {
      key: 'buyers', short: 'New buyers', title: 'New buyers arrive through the creator’s link', more: '#milestones',
      text: <><strong>{j.results} of {j.target} new buyers</strong> made a first buy through the creator’s link{j.id !== null ? <> (<code>?ref=c{j.id}</code>)</> : ''}. The hub counts each one in the same transaction as the buy.</>,
      scene: (
        <div className="jr-scene jr-buyers">
          <span className="jr-link">?ref=c{j.id ?? 7}</span>
          <span className="jr-people">{range(Math.min(j.results, 8)).map((i) => <span key={i} className="jr-person" style={at(i)} />)}</span>
          <span className="jr-token">{j.sym}</span>
          <span className="jr-tag">{j.results} / {j.target}</span>
        </div>
      ),
    },
    {
      key: 'paid', short: 'Three payouts', title: 'Three payouts to the creator', more: '#milestones',
      text: <>Each third of the target released a third of the price: {j.payouts.map((p) => p.near).join(', ')} NEAR, paid as <strong>{j.tusd} tUSD</strong> (test dollars). Paid to the founder: 0.</>,
      scene: (
        <div className="jr-scene jr-paid">
          {j.payouts.map((p, i) => (
            <span key={i} className="jr-payout" style={at(i)}>
              <span className="jr-tick">✓</span><span>after {p.at} new buyer{p.at === 1 ? '' : 's'}</span><b>{p.near} NEAR</b>
            </span>
          ))}
        </div>
      ),
    },
  ];
}

const EVERY = 3200;

export function Journey({ s }: { s: State }) {
  const { go } = useApp();
  const done = useMemo(() => s.campaigns.filter((c) => c.phase === 'done' && c.winner).sort((a, b) => (b.funded_ms ?? b.created_ms) - (a.funded_ms ?? a.created_ms))[0] ?? null, [s.campaigns]);
  const j = useMemo(() => (done ? fromCampaign(s, done) : EXAMPLE), [s, done]);
  const [privately, setPrivately] = useState<boolean | null>(null);
  useEffect(() => {
    if (!done) return;
    let on = true;
    void api<{ book: unknown }>(`/campaign/${done.id}/sealed`).then((x) => on && setPrivately(!!x.book)).catch(() => undefined);
    return () => { on = false; };
  }, [done?.id]);
  const list = steps(j, privately);
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [still] = useState(reducedMotion);
  const [ref, seen] = useSeen<HTMLElement>('0px 0px -25% 0px');
  const played = useRef(false);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);

  // play once, the first time it is in view
  useEffect(() => { if (seen && !still && !played.current) { played.current = true; setPlaying(true); } }, [seen, still]);
  useEffect(() => {
    if (!playing) return;
    const t = setTimeout(() => { setI(i + 1); if (i + 1 >= list.length - 1) setPlaying(false); }, EVERY);
    return () => clearTimeout(t);
  }, [playing, i, list.length]);

  const pick = (k: number, focus = false): void => {
    const n = Math.max(0, Math.min(list.length - 1, k));
    setPlaying(false);
    setI(n);
    if (focus) tabs.current[n]?.focus();
  };
  const onKey = (e: KeyboardEvent): void => {
    const to = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    pick(to, true);
  };
  const replay = (): void => { if (playing) { setPlaying(false); return; } setI(i >= list.length - 1 ? 0 : i); setPlaying(true); };

  return (
    <section ref={ref} className={`panel jr${playing ? ' playing' : ''}`} aria-labelledby="jr-h">
      <header className="jr-head">
        <div>
          <h2 id="jr-h">One campaign, start to finish</h2>
          <p className="small muted jr-src">
            {j.real
              ? <>Real numbers from campaign #{j.id} on <a href={`/s/${j.startup}?tab=treasury`} onClick={(e) => { e.preventDefault(); go(`/s/${j.startup}?tab=treasury`); }}>{j.name}</a>, which finished. Tiny amounts: it’s the test network.</>
              : <>Illustrative numbers: no campaign has finished yet.</>}
          </p>
        </div>
        {!still && <button className="ghost small jr-play" onClick={replay} aria-label={playing ? 'Pause the walkthrough' : 'Play the walkthrough'}>{playing ? '❚❚ Pause' : '▶ Play'}</button>}
      </header>

      <div className="jr-path-wrap">
        <span className="jr-track" aria-hidden="true"><span style={{ '--jr-p': i / (list.length - 1) } as CSSProperties} /></span>
        <ol className="step-path jr-path" role="tablist" aria-label="The steps of one campaign" onKeyDown={onKey}>
          {list.map((x, k) => (
            <li key={x.key} className={k < i ? 'past' : k === i ? 'on' : ''}>
              <button
                ref={(el) => { tabs.current[k] = el; }} role="tab" id={`jr-tab-${k}`} aria-selected={k === i} aria-controls="jr-panel"
                tabIndex={k === i ? 0 : -1} onClick={() => pick(k)}
              >
                <span className="sp-node">{k + 1}</span>
                <span className="jr-short">{x.short}</span>
              </button>
            </li>
          ))}
        </ol>
      </div>

      <div className="jr-stage" id="jr-panel" role="tabpanel" aria-labelledby={`jr-tab-${i}`}>
        <div className="jr-pic" aria-hidden="true" key={`${list[i].key}-${i}`}>{list[i].scene}</div>
        <div className="jr-words">
          {list.map((x, k) => (
            <div key={x.key} className={`jr-word${k === i ? ' on' : ''}`} aria-hidden={k !== i}>
              <p className="jr-count small">Step {k + 1} of {list.length}</p>
              <h3>{x.title}</h3>
              <p>{x.text}</p>
              <p className="small jr-nav">
                <a href={x.more} tabIndex={k === i ? 0 : -1}>Read the details</a>
                <span className="jr-arrows">
                  <button className="round ghost" tabIndex={k === i ? 0 : -1} disabled={k === 0} onClick={() => pick(k - 1)} aria-label="Previous step">←</button>
                  <button className="round ghost" tabIndex={k === i ? 0 : -1} disabled={k === list.length - 1} onClick={() => pick(k + 1)} aria-label="Next step">→</button>
                </span>
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
