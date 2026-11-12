import { useEffect, useMemo, useState } from 'react';
import {
  FEE_BPS, MILESTONES, SUPPLY, fmtNear, fmtTokens, fmtTusd, parseNear, parseTokens, priceAt, quoteBuy, quoteSell, threshold, withSlippage,
} from '@signalfire/core';
import { api, acctUrl, type AuditEntry, type Campaign, type Startup, type Trade } from './api.ts';
import { MyBid } from './Bid.tsx';
import { PriceChart } from './Chart.tsx';
import { FounderForms } from './Founder.tsx';
import { Wire } from './Wire.tsx';
import { Acct, Chip, Near, SignInHint, TeeBadge, Terms, ago, flagKind, fmtLeft, useApp, useNow } from './ui.tsx';
import { call } from './wallet.ts';

// A startup: its market (chart, trade, supply and fees) and its treasury (ledger, constraints, campaigns,
// DAO votes, milestones, the audit log).

const refFromUrl = (): number | null => {
  const m = /^c(\d{1,6})$/.exec(new URLSearchParams(location.search).get('ref') ?? '');
  return m ? Number(m[1]) : null;
};

export function StartupPage({ id }: { id: string }) {
  const { state } = useApp();
  const s = state!.startups.find((x) => x.id === id);
  const [tab, setTab] = useState<'market' | 'treasury'>(() => (new URLSearchParams(location.search).get('tab') === 'treasury' ? 'treasury' : 'market'));
  const [trades, setTrades] = useState<Trade[] | null>(null);
  useEffect(() => {
    let on = true;
    const load = (): void => { api<Trade[]>(`/startup/${id}/trades`).then((t) => on && setTrades(t)).catch(() => on && setTrades([])); };
    load();
    const t = setInterval(load, 5000);
    return () => { on = false; clearInterval(t); };
  }, [id]);
  if (!s) return <div className="error-box">There is no startup “{id}” on {state!.hub}.</div>;
  const sym = s.id.toUpperCase();
  return (
    <div className="startup">
      <section className="st-head">
        <div>
          <h1>{s.name} <span className="sym">{sym}</span></h1>
          <p className="lede">{s.pitch}</p>
          <p className="muted small">Founded by <Acct a={s.founder} full /> · token <Acct a={s.token} full /> · DAO <Acct a={s.dao} full /></p>
        </div>
        <div className="st-price">
          <span className="n">{fmtNear(s.price, 6)}<small> NEAR</small></span>
          <span className="l">per {sym}, spot price on the curve</span>
        </div>
      </section>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'market'} className={tab === 'market' ? 'on' : ''} onClick={() => setTab('market')}>Market</button>
        <button role="tab" aria-selected={tab === 'treasury'} className={tab === 'treasury' ? 'on' : ''} onClick={() => setTab('treasury')}>Treasury and campaigns</button>
      </div>
      {tab === 'market' ? <Market s={s} trades={trades} /> : <Treasury s={s} />}
    </div>
  );
}

// ---------- market ----------

function Market({ s, trades }: { s: Startup; trades: Trade[] | null }) {
  return (
    <div className="grid-market">
      <div className="col-main">
        <section className="panel">
          <h2>Price</h2>
          {trades === null ? <p className="muted">Loading trades…</p> : <PriceChart trades={trades} circulating={s.circulating} />}
          <TradeList trades={trades ?? []} sym={s.id.toUpperCase()} />
        </section>
        <Wire limit={10} />
      </div>
      <div className="col-side">
        <TradePanel s={s} />
        <SupplyPanel s={s} />
      </div>
    </div>
  );
}

function TradeList({ trades, sym }: { trades: Trade[]; sym: string }) {
  const now = useNow(10000);
  if (!trades.length) return <p className="muted">No trades yet. The first buy sets the price moving.</p>;
  return (
    <div className="tbl-wrap"><table className="tbl compact">
      <thead><tr><th>Trade</th><th>Account</th><th className="r">{sym}</th><th className="r">NEAR</th><th className="r">Fee to treasury</th><th className="r">When</th></tr></thead>
      <tbody>
        {trades.slice(0, 8).map((t) => (
          <tr key={t.n}>
            <td><Chip kind={t.side === 'buy' ? 'ok' : 'warn'}>{t.side}</Chip>{t.attributed !== null && <Chip kind="ember">campaign #{t.attributed}</Chip>}</td>
            <td><Acct a={t.account} /></td>
            <td className="r">{fmtTokens(t.tokens)}</td>
            <td className="r">{fmtNear(t.near)}</td>
            <td className="r">{fmtNear(t.fee, 5)}</td>
            <td className="r muted">{ago(t.ts_ms, now)}</td>
          </tr>
        ))}
      </tbody>
    </table></div>
  );
}

function TradePanel({ s }: { s: Startup }) {
  const { state, me, account, run, busy } = useApp();
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [amount, setAmount] = useState('0.1');
  const [slip, setSlip] = useState(100);
  const ref = refFromUrl();
  const refCampaign = ref !== null ? state!.campaigns.find((c) => c.id === ref && c.startup === s.id) : undefined;
  const sym = s.id.toUpperCase();
  const bal = BigInt(me?.tokens.find((t) => t.startup === s.id)?.balance ?? '0');
  const x0 = BigInt(s.circulating);
  const quote = useMemo(() => {
    try {
      if (side === 'buy') {
        const g = parseNear(amount);
        if (g <= 0n) return null;
        const q = quoteBuy(x0, g, bal === 0n);
        return { kind: 'buy' as const, q, min: withSlippage(q.tokens, BigInt(slip)) };
      }
      const t = parseTokens(amount);
      if (t <= 0n || t > x0) return null;
      const q = quoteSell(x0, t);
      return { kind: 'sell' as const, q, t, min: withSlippage(q.out, BigInt(slip)) };
    } catch { return null; }
  }, [side, amount, slip, x0, bal]);

  const submit = (): void => {
    if (!quote) return;
    if (quote.kind === 'buy') {
      void run(`Buy ${sym}`, () => call(state!.hub, 'buy', { startup: s.id, min_tokens_out: quote.min.toString(), ref_code: ref !== null ? `c${ref}` : null }, parseNear(amount)));
    } else {
      void run(`Sell ${sym}`, () => call(s.token, 'ft_transfer_call', { receiver_id: state!.hub, amount: quote.t.toString(), msg: JSON.stringify({ min_near_out: quote.min.toString() }) }, 1n));
    }
  };
  return (
    <section className="panel trade">
      <div className="seg-toggle" role="radiogroup" aria-label="Buy or sell">
        <button role="radio" aria-checked={side === 'buy'} className={side === 'buy' ? 'on' : ''} onClick={() => { setSide('buy'); setAmount('0.1'); }}>Buy</button>
        <button role="radio" aria-checked={side === 'sell'} className={side === 'sell' ? 'on' : ''} onClick={() => { setSide('sell'); setAmount(bal > 0n ? fmtTokens(bal, 6) : '100'); }}>Sell</button>
      </div>
      {ref !== null && side === 'buy' && (
        <p className="ref-note">You’re buying through campaign #{ref}’s link{refCampaign ? ` (“${refCampaign.title}”)` : ''}. A first buy of at least 0.05 NEAR counts toward that creator’s results{refCampaign && refCampaign.phase !== 'funded' ? ', but this campaign isn’t running right now' : ''}.</p>
      )}
      <label className="field">
        <span>{side === 'buy' ? 'You pay (NEAR)' : `You sell (${sym})`}</span>
        <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-describedby="quote" />
      </label>
      <div id="quote" className="quote">
        {!quote && <p className="muted">Enter an amount.</p>}
        {quote?.kind === 'buy' && (
          <dl>
            <div><dt>You get about</dt><dd>{fmtTokens(quote.q.tokens)} {sym}</dd></div>
            <div><dt>Fee to the marketing treasury</dt><dd>{fmtNear(quote.q.fee, 5)} NEAR</dd></div>
            {quote.q.storage > 0n && <div><dt>Token storage (first buy only)</dt><dd>{fmtNear(quote.q.storage, 5)} NEAR</dd></div>}
            <div><dt>Price after</dt><dd>{fmtNear(quote.q.priceAfter, 6)} NEAR</dd></div>
            <div><dt>Minimum accepted</dt><dd>{fmtTokens(quote.min)} {sym}</dd></div>
          </dl>
        )}
        {quote?.kind === 'sell' && (
          <dl>
            <div><dt>You get about</dt><dd>{fmtNear(quote.q.out)} NEAR</dd></div>
            <div><dt>Fee to the marketing treasury</dt><dd>{fmtNear(quote.q.fee, 5)} NEAR</dd></div>
            <div><dt>Price after</dt><dd>{fmtNear(quote.q.priceAfter, 6)} NEAR</dd></div>
            <div><dt>Minimum accepted</dt><dd>{fmtNear(quote.min)} NEAR</dd></div>
          </dl>
        )}
      </div>
      <label className="field inline">
        <span>Slippage limit</span>
        <select value={slip} onChange={(e) => setSlip(Number(e.target.value))}>
          <option value={50}>0.5%</option><option value={100}>1%</option><option value={300}>3%</option>
        </select>
      </label>
      {account ? (
        <>
          <button className="primary wide" disabled={!quote || !!busy || (side === 'sell' && bal === 0n)} onClick={submit}>{side === 'buy' ? `Buy ${sym}` : `Sell ${sym}`}</button>
          <p className="muted small">You hold {fmtTokens(bal)} {sym}.</p>
        </>
      ) : <SignInHint what={`buy or sell ${sym}`} />}
      <Terms compact />
    </section>
  );
}

function SupplyPanel({ s }: { s: Startup }) {
  const sym = s.id.toUpperCase();
  const circ = BigInt(s.circulating);
  const pct = Number((circ * 10000n) / SUPPLY) / 100;
  return (
    <section className="panel supply">
      <h2>Supply and fees</h2>
      <div className="supply-bar" aria-label={`${pct}% of the supply is circulating`}><span style={{ width: `${Math.max(pct, 0.6)}%` }} /></div>
      <dl className="facts">
        <div><dt>Total supply, fixed</dt><dd>1,000,000 {sym}</dd></div>
        <div><dt>Circulating</dt><dd>{fmtTokens(circ)} {sym} ({pct}%)</dd></div>
        <div><dt>On the curve, unsold</dt><dd>{fmtTokens(SUPPLY - circ)} {sym}</dd></div>
        <div><dt>Founder allocation</dt><dd>0 {sym}</dd></div>
        <div><dt>Curve reserve</dt><dd><Near y={s.reserve} /></dd></div>
        <div><dt>Spot price</dt><dd>{fmtNear(priceAt(circ), 6)} NEAR</dd></div>
        <div><dt>Trading fee</dt><dd>{Number(FEE_BPS) / 100}% of every trade, to the marketing treasury only</dd></div>
        <div><dt>Fees in so far</dt><dd><Near y={s.fees_in} /></dd></div>
        <div><dt>Buyers</dt><dd>{s.buyers}</dd></div>
        <div><dt>Volume</dt><dd><Near y={s.volume} d={2} /></dd></div>
      </dl>
      <p className="muted small">
        Price per token = 0.0001 NEAR + 0.01 NEAR × (circulating ÷ 1,000,000). The reserve always equals the area under that
        line, so every token can be sold back. Nobody can mint more: the token is the standard NEP-141 global contract
        with no mint method. <a href={acctUrl(s.token)} target="_blank" rel="noreferrer">Token account</a> · <a href={acctUrl(s.dao)} target="_blank" rel="noreferrer">DAO account</a>
      </p>
    </section>
  );
}

// ---------- treasury and campaigns ----------

function Treasury({ s }: { s: Startup }) {
  const { state, me, account, run, busy } = useApp();
  const sym = s.id.toUpperCase();
  const campaigns = state!.campaigns.filter((c) => c.startup === s.id).sort((a, b) => b.id - a.id);
  const bal = BigInt(me?.tokens.find((t) => t.startup === s.id)?.balance ?? '0');
  const isHolder = !!account && s.holders.includes(account);
  const min = BigInt(s.constraints.min_holder_tokens);
  const c = s.constraints;
  return (
    <div className="grid-treasury">
      <div className="col-side">
        <section className="panel ledger">
          <h2>Marketing treasury</h2>
          <dl className="facts">
            <div><dt>Free to fund campaigns</dt><dd><Near y={s.available} /></dd></div>
            <div><dt>Reserved for funded campaigns</dt><dd><Near y={s.committed} /></dd></div>
            <div><dt>Paid to creators</dt><dd><Near y={s.paid} /></dd></div>
            <div><dt>Trading fees in</dt><dd><Near y={s.fees_in} /></dd></div>
            <div><dt>Forfeited bid bonds in</dt><dd><Near y={s.forfeits_in} /></dd></div>
            <div className="strong"><dt>Paid to founders</dt><dd>0 NEAR, and no method can</dd></div>
          </dl>
        </section>
        <section className="panel">
          <h2>Founder’s constraints</h2>
          <p className="muted small">The founder’s only lever. The contract enforces hard limits on each.{account === s.founder && ' Edit them in the Founder’s desk.'}</p>
          <dl className="facts">
            <div><dt>Largest campaign budget</dt><dd><Near y={c.campaign_cap} d={2} /></dd></div>
            <div><dt>Largest single payout</dt><dd><Near y={c.max_payout} d={2} /></dd></div>
            <div><dt>Payouts per hour</dt><dd>{c.payouts_per_hour}</dd></div>
            <div><dt>Credible bid floor</dt><dd>{c.min_bid_bps / 100}% of the budget</dd></div>
            <div><dt>To join the holders</dt><dd>{fmtTokens(c.min_holder_tokens, 0)} {sym}</dd></div>
          </dl>
        </section>
        <section className="panel">
          <h2>Holders’ council</h2>
          <p className="muted small">Members of the <Acct a={s.dao} /> DAO’s holders role. One holder, one vote; a majority funds a campaign.</p>
          <ul className="plain">{s.holders.map((h) => <li key={h}><Acct a={h} />{h === account && <Chip kind="ember">you</Chip>}</li>)}</ul>
          {account && !isHolder && (bal >= min
            ? <button className="primary wide" disabled={!!busy} onClick={() => void run('Join the holders', () => call(state!.hub, 'join_holders', { startup: s.id }))}>Join the holders</button>
            : <p className="muted small">Hold at least {fmtTokens(min, 0)} {sym} to join (you hold {fmtTokens(bal)}).</p>)}
          {isHolder && <p className="ok-text small">You’re a holder: you can vote on funding proposals below.</p>}
          <SignInHint what="join the holders and vote" />
        </section>
      </div>
      <div className="col-main">
        <FounderForms s={s} />
        <section className="panel">
          <h2>Campaigns</h2>
          {campaigns.length === 0 && <p className="muted">No campaigns yet. When the treasury has fees in it, the founder posts a brief and creators start bidding.</p>}
          {campaigns.map((cm) => <CampaignCard key={cm.id} c={cm} s={s} isHolder={isHolder} />)}
        </section>
        <AuditLog s={s} />
      </div>
    </div>
  );
}

const PHASES = [
  { key: 'bidding', label: 'Sealed bids' },
  { key: 'reveal', label: 'Reveal' },
  { key: 'voting', label: 'Holders vote' },
  { key: 'funded', label: 'Running' },
  { key: 'done', label: 'Paid' },
];

function phaseIndex(c: Campaign, now: number): number {
  if (c.phase === 'bidding') return now < c.commit_ends_ms ? 0 : 1;
  if (c.phase === 'proposing' || c.phase === 'voting' || c.phase === 'propose_failed') return 2;
  if (c.phase === 'funded') return 3;
  if (c.phase === 'done') return 4;
  return -1;
}

function CampaignCard({ c, s, isHolder }: { c: Campaign; s: Startup; isHolder: boolean }) {
  const { state, account, run, busy } = useApp();
  const now = useNow(1000);
  const [open, setOpen] = useState(!['done', 'expired', 'no_bids'].includes(c.phase));
  const idx = phaseIndex(c, now);
  const sym = s.id.toUpperCase();
  const refLink = `${location.origin}/s/${s.id}?ref=c${c.id}`;
  let clock = '';
  if (c.phase === 'bidding') clock = now < c.commit_ends_ms ? `bids close in ${fmtLeft(c.commit_ends_ms - now)}` : now < c.reveal_ends_ms ? `reveals close in ${fmtLeft(c.reveal_ends_ms - now)}` : 'settling the auction';
  else if (c.phase === 'funded' && c.deadline_ms) clock = `ends in ${fmtLeft(c.deadline_ms - now)}`;
  else if (c.phase === 'voting') clock = 'waiting for a majority of holders';
  else if (c.phase === 'proposing') clock = 'filing the DAO proposal';
  const ended: Record<string, string> = { expired: 'Expired: the unpaid part went back to the treasury', no_bids: 'No credible bids', propose_failed: 'The DAO refused the proposal; it will be filed again' };
  const voted = account ? c.proposal?.votes[account] : undefined;
  const vote = (approve: boolean): void => {
    void run(approve ? 'Vote yes' : 'Vote no', () => call(s.dao, 'act_proposal', { id: c.proposal_id, action: approve ? 'VoteApprove' : 'VoteReject', proposal: c.proposal!.kind }));
  };
  return (
    <article className={`campaign ${c.phase}`}>
      <header onClick={() => setOpen(!open)} className="c-head">
        <div>
          <h3><span className="cid">#{c.id}</span> {c.title}</h3>
          <p className="muted small">Budget <Near y={c.budget} d={3} /> for {c.target} new {sym} holders{clock && <> · <strong className="clock">{clock}</strong></>}</p>
        </div>
        <button className="ghost small" aria-expanded={open}>{open ? 'Hide' : 'Details'}</button>
      </header>
      {idx >= 0 ? (
        <ol className="timeline" aria-label="Campaign phase">
          {PHASES.map((p, i) => <li key={p.key} className={i < idx ? 'past' : i === idx ? 'now' : ''}>{p.label}</li>)}
        </ol>
      ) : <p className="ended">{ended[c.phase] ?? c.phase}</p>}
      {open && (
        <div className="c-body">
          <p>{c.brief}</p>
          <h4>Bid book</h4>
          {c.bids.length === 0 && <p className="muted small">No bids yet. Admitted creators (people and agents) seal a price and a pitch with a 0.02 NEAR bond.</p>}
          <ul className="bids">
            {c.bids.map((b) => {
              const p = c.pitches[b.creator];
              const win = c.winner === b.creator;
              return (
                <li key={b.creator} className={win ? 'win' : ''}>
                  <div className="b-top">
                    <Acct a={b.creator} />
                    {win && <Chip kind="ember">winner</Chip>}
                    {b.revealed ? (
                      <>
                        <span className="amt">{fmtNear(b.price!, 4)} NEAR</span>
                        <Chip kind={b.credible ? 'ok' : 'bad'}>{b.credible ? 'credible' : 'outside the credible range'}</Chip>
                        <span className="muted small">reputation {b.rep >= 0 ? '+' : ''}{b.rep / 100}%</span>
                      </>
                    ) : (
                      <span className="sealed" title={b.hash}>sealed {b.hash.slice(0, 16)}…</span>
                    )}
                  </div>
                  {p && <blockquote>{p.pitch} <TeeBadge signed={p.signed} model={p.model} src={{ kind: 'pitch', campaign: c.id, creator: b.creator }} what="pitch" /></blockquote>}
                </li>
              );
            })}
          </ul>
          <MyBid c={c} s={s} />
          {c.proposal_id !== null && (
            <>
              <h4>DAO proposal {c.proposal_id} in <Acct a={s.dao} /></h4>
              <p className="small">Calls <code>fund_campaign({c.id})</code> on the hub, reserving <Near y={c.price} /> for {c.winner && <Acct a={c.winner} />}. Status: <Chip kind={c.proposal?.status === 'Approved' ? 'ok' : c.proposal?.status === 'Rejected' ? 'bad' : ''}>{c.proposal?.status ?? 'filing'}</Chip></p>
              {c.proposal && Object.keys(c.proposal.votes).length > 0 && (
                <ul className="plain votes">{Object.entries(c.proposal.votes).map(([a, v]) => <li key={a}><Acct a={a} /> <Chip kind={v === 'Approve' ? 'ok' : 'bad'}>{v}</Chip></li>)}</ul>
              )}
              {c.proposal?.status === 'InProgress' && isHolder && !voted && (
                <div className="row">
                  <button className="primary" disabled={!!busy} onClick={() => vote(true)}>Vote yes</button>
                  <button className="ghost" disabled={!!busy} onClick={() => vote(false)}>Vote no</button>
                </div>
              )}
              {c.proposal?.status === 'InProgress' && !isHolder && account && <p className="muted small">Only members of the holders’ council can vote.</p>}
            </>
          )}
          {['funded', 'done', 'expired'].includes(c.phase) && (
            <>
              <h4>Results and milestones</h4>
              <div className="ms">
                {Array.from({ length: MILESTONES }, (_, k) => {
                  const need = threshold(c.target, k + 1);
                  const paid = c.milestones_paid > k;
                  return (
                    <div key={k} className={`ms-step ${paid ? 'paid' : c.results >= need ? 'ready' : ''}`}>
                      <span className="ms-k">Milestone {k + 1}</span>
                      <span className="ms-need">{Math.min(c.results, need)}/{need} buyers</span>
                      <span className="ms-state">{paid ? 'paid' : c.results >= need ? 'unlocked' : 'waiting'}</span>
                    </div>
                  );
                })}
              </div>
              <p className="small">{c.results} of {c.target} first-time buyers came through the link. Paid so far: <Near y={c.paid} /> as <strong>{fmtTusd(c.paid_tusd)} tUSD</strong>.{c.receipt && <> Receipt NFT <code>{c.receipt}</code> minted to {c.winner && <Acct a={c.winner} />}.</>}</p>
              {c.phase === 'funded' && (
                <div className="reflink">
                  <span className="small">Referral link</span>
                  <code>{refLink}</code>
                  <button className="ghost small" onClick={() => void navigator.clipboard?.writeText(refLink)}>Copy</button>
                </div>
              )}
            </>
          )}
          <p className="small proof-row">
            <a href={`/api/campaign/${c.id}/proof`} target="_blank" rel="noreferrer">Proof (JSON)</a> · check it yourself without trusting this server: <code>pnpm verify {c.id} {location.origin}</code>
          </p>
          {state && c.phase === 'funded' && account && c.results > 0 && <p className="muted small">Anyone can crank the next milestone; the agents do it automatically.</p>}
        </div>
      )}
    </article>
  );
}

function AuditLog({ s }: { s: Startup }) {
  const [rows, setRows] = useState<AuditEntry[] | null>(null);
  const now = useNow(10000);
  useEffect(() => {
    let on = true;
    const load = (): void => { api<AuditEntry[]>('/audit').then((r) => on && setRows(r)).catch(() => on && setRows([])); };
    load();
    const t = setInterval(load, 8000);
    return () => { on = false; clearInterval(t); };
  }, []);
  const list = (rows ?? []).filter((e) => e.startup === s.id || e.startup === null).slice(0, 40);
  return (
    <section className="panel audit">
      <h2>Audit log</h2>
      <p className="muted small">Every spend attempt and every decision the spend policy makes, written onchain by the hub. Creator vetting is shared by all startups.</p>
      {rows === null && <p className="muted">Loading…</p>}
      {rows && list.length === 0 && <p className="muted">Nothing logged yet.</p>}
      {list.length > 0 && <div className="tbl-wrap">
        <table className="tbl">
          <thead><tr><th>#</th><th>Action</th><th>Account</th><th className="r">Amount</th><th>Outcome and flags</th><th>Note</th><th className="r">When</th></tr></thead>
          <tbody>
            {list.map((e) => (
              <tr key={e.n}>
                <td className="muted">{e.n}</td>
                <td>{e.action}{e.campaign !== null && <span className="muted"> #{e.campaign}</span>}</td>
                <td>{e.account ? <Acct a={e.account} /> : '—'}</td>
                <td className="r">{e.amount !== '0' ? fmtNear(e.amount) : '—'}</td>
                <td><Chip kind={flagKind(e.outcome)}>{e.outcome}</Chip>{e.flags.map((f) => <Chip key={f} kind={flagKind(f)}>{f}</Chip>)}</td>
                <td className="note">{e.note}</td>
                <td className="r muted">{ago(e.ts_ms, now)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>}
    </section>
  );
}

