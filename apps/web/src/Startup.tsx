import { useEffect, useMemo, useState } from 'react';
import {
  FEE_BPS, MILESTONES, SUPPLY, fmtNear, fmtTokens, fmtTusd, parseNear, parseTokens, priceAt, quoteBuy, quoteSell, threshold, withSlippage,
} from '@signalfire/core';
import { api, acctUrl, type AuditEntry, type Campaign, type Startup, type Trade } from './api.ts';
import { MyBid } from './Bid.tsx';
import { PriceChart } from './Chart.tsx';
import { EvidenceTab } from './Evidence.tsx';
import { KeylessAgent } from './KeylessAgent.tsx';
import { SealedPanel } from './Sealed.tsx';
import { FounderForms } from './Founder.tsx';
import { Wire } from './Wire.tsx';
import { FLAG, auditNote, auditResult, auditWhat } from './copy.ts';
import { founderOf } from './Discover.tsx';
import { Acct, Chip, Info, Near, SignInHint, TeeBadge, Terms, ago, flagKind, fmtLeft, useApp, useNow } from './ui.tsx';
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
  const [tab, setTab] = useState<'market' | 'treasury' | 'evidence'>(() => { const t = new URLSearchParams(location.search).get('tab'); return t === 'treasury' || t === 'evidence' ? t : 'market'; });
  const [trades, setTrades] = useState<Trade[] | null>(null);
  useEffect(() => {
    let on = true;
    const load = (): void => { api<Trade[]>(`/startup/${id}/trades`).then((t) => on && setTrades(t)).catch(() => on && setTrades([])); };
    load();
    const t = setInterval(load, 5000);
    return () => { on = false; clearInterval(t); };
  }, [id]);
  if (!s) return <div className="error-box">There’s no startup called “{id}” on Signalfire.</div>;
  const sym = s.id.toUpperCase();
  return (
    <div className="startup">
      <section className="st-head">
        <div>
          <h1>{s.name} <span className="sym">{sym}</span></h1>
          <p className="lede">{s.pitch}</p>
          <p className="muted small">Founded by {founderOf(s, state!.operator).name}</p>
          <details className="tech">
            <summary>On NEAR</summary>
            <p className="muted small">Founder <Acct a={s.founder} full /> · Token account <Acct a={s.token} full /> · Holders’ council account <Acct a={s.dao} full /></p>
          </details>
        </div>
        <div className="st-price">
          <span className="n">{fmtNear(s.price, 6)}<small> NEAR</small></span>
          <span className="l">per {sym}, current price<Info text="Set by the price curve (bonding curve): it rises as people buy and falls as they sell." /></span>
        </div>
      </section>
      <div className="tabs" role="tablist">
        <button role="tab" data-tour="tab-market" aria-selected={tab === 'market'} className={tab === 'market' ? 'on' : ''} onClick={() => setTab('market')}>Market</button>
        <button role="tab" data-tour="tab-treasury" aria-selected={tab === 'treasury'} className={tab === 'treasury' ? 'on' : ''} onClick={() => setTab('treasury')}>Marketing fund and campaigns</button>
        <button role="tab" aria-selected={tab === 'evidence'} className={tab === 'evidence' ? 'on' : ''} onClick={() => setTab('evidence')} data-tour="evidence-tab">Evidence</button>
      </div>
      {tab === 'market' ? <Market s={s} trades={trades} /> : tab === 'treasury' ? <Treasury s={s} /> : <EvidenceTab s={s} />}
    </div>
  );
}

// ---------- market ----------

function Market({ s, trades }: { s: Startup; trades: Trade[] | null }) {
  return (
    <div className="grid-market">
      <div className="col-main">
        <section className="panel" data-tour="price">
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
      <thead><tr><th>Trade</th><th>Account</th><th className="r">{sym}</th><th className="r">NEAR</th><th className="r">Fee to marketing fund</th><th className="r">When</th></tr></thead>
      <tbody>
        {trades.slice(0, 8).map((t) => (
          <tr key={t.n}>
            <td><Chip kind={t.side === 'buy' ? 'ok' : 'warn'}>{t.side}</Chip>{t.attributed !== null && <span title="Bought through a creator’s link: counts as a new buyer"><Chip kind="ember">via campaign #{t.attributed}</Chip></span>}</td>
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
      void run(`Buy ${sym}`, () => call(state!.hub, 'buy', { startup: s.id, min_tokens_out: quote.min.toString(), ref_code: ref !== null ? `c${ref}` : null }, parseNear(amount)),
        { pending: `Buying your ${sym}…`, done: `You bought ${sym}. It’s in your account.`, action: 'buy' });
    } else {
      void run(`Sell ${sym}`, () => call(s.token, 'ft_transfer_call', { receiver_id: state!.hub, amount: quote.t.toString(), msg: JSON.stringify({ min_near_out: quote.min.toString() }) }, 1n),
        { pending: `Selling your ${sym}…`, done: 'Sold. The NEAR is in your account.', action: 'ft_transfer_call' });
    }
  };
  return (
    <section className="panel trade" data-tour="trade">
      <div className="seg-toggle" role="radiogroup" aria-label="Buy or sell">
        <button role="radio" aria-checked={side === 'buy'} className={side === 'buy' ? 'on' : ''} onClick={() => { setSide('buy'); setAmount('0.1'); }}>Buy</button>
        <button role="radio" aria-checked={side === 'sell'} className={side === 'sell' ? 'on' : ''} onClick={() => { setSide('sell'); setAmount(bal > 0n ? fmtTokens(bal, 6) : '100'); }}>Sell</button>
      </div>
      {ref !== null && side === 'buy' && (
        <p className="ref-note">You’re buying through campaign #{ref}’s creator link{refCampaign ? ` (“${refCampaign.title}”)` : ''}. If this is your first buy of {sym} and it’s at least 0.05 NEAR, it counts as a new buyer for that creator{refCampaign && refCampaign.phase !== 'funded' ? ', but this campaign isn’t running right now, so it won’t count' : ''}.</p>
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
            <div><dt>Fee to the marketing fund (2%)</dt><dd>{fmtNear(quote.q.fee, 5)} NEAR</dd></div>
            {quote.q.storage > 0n && <div><dt>One-time token account setup (first buy only)<Info text="A NEAR storage deposit the token contract requires (0.00125 NEAR). See How it works §12." /></dt><dd>{fmtNear(quote.q.storage, 5)} NEAR</dd></div>}
            <div><dt>Price after</dt><dd>{fmtNear(quote.q.priceAfter, 6)} NEAR</dd></div>
            <div><dt>You get at least<Info text="If the price moves past this before your trade lands, nothing happens and you keep your NEAR (min_tokens_out)." /></dt><dd>{fmtTokens(quote.min)} {sym}</dd></div>
          </dl>
        )}
        {quote?.kind === 'sell' && (
          <dl>
            <div><dt>You get about</dt><dd>{fmtNear(quote.q.out)} NEAR</dd></div>
            <div><dt>Fee to the marketing fund (2%)</dt><dd>{fmtNear(quote.q.fee, 5)} NEAR</dd></div>
            <div><dt>Price after</dt><dd>{fmtNear(quote.q.priceAfter, 6)} NEAR</dd></div>
            <div><dt>You get at least<Info text="If the price moves past this before your trade lands, nothing happens and you keep your tokens (min_near_out)." /></dt><dd>{fmtNear(quote.min)} NEAR</dd></div>
          </dl>
        )}
      </div>
      <label className="field inline">
        <span>Price protection<Info text="How far the price may move before your trade is cancelled (slippage limit)." /></span>
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
    <section className="panel supply" data-tour="supply">
      <h2>Supply and fees</h2>
      <div className="supply-bar" aria-label={`${pct}% of all tokens are in people’s hands`}><span style={{ width: `${Math.max(pct, 0.6)}%` }} /></div>
      <dl className="facts">
        <div><dt>Total supply, fixed</dt><dd>1,000,000 {sym}</dd></div>
        <div><dt>In people’s hands<Info text="Circulating supply" /></dt><dd>{fmtTokens(circ)} {sym} ({pct}%)</dd></div>
        <div><dt>Not sold yet</dt><dd>{fmtTokens(SUPPLY - circ)} {sym}</dd></div>
        <div><dt>Tokens for the founder</dt><dd>0 {sym}</dd></div>
        <div><dt>Buy-back pool<Info text="NEAR kept so every token can always be sold back (the curve reserve)." /></dt><dd><Near y={s.reserve} /></dd></div>
        <div><dt>Current price</dt><dd>{fmtNear(priceAt(circ), 6)} NEAR</dd></div>
        <div><dt>Trading fee</dt><dd>{Number(FEE_BPS) / 100}% of every trade, to the marketing fund only</dd></div>
        <div><dt>Fees collected so far</dt><dd><Near y={s.fees_in} /></dd></div>
        <div><dt>Buyers</dt><dd>{s.buyers}</dd></div>
        <div><dt>Volume</dt><dd><Near y={s.volume} d={2} /></dd></div>
      </dl>
      <p className="muted small">
        The price starts at 0.0001 NEAR and rises in a straight line as tokens are bought. The buy-back pool always holds
        enough to buy every token back, and no one can ever create more tokens.
      </p>
      <details className="tech">
        <summary>The exact formula and contracts</summary>
        <p className="muted small">
          Price per token = 0.0001 NEAR + 0.01 NEAR × (circulating ÷ 1,000,000). The reserve always equals the area under that
          line, so every token can be sold back. Nobody can mint more: the token is the standard NEP-141 global contract
          with no mint method. <a href={acctUrl(s.token)} target="_blank" rel="noreferrer">Token account</a> · <a href={acctUrl(s.dao)} target="_blank" rel="noreferrer">DAO account</a>
        </p>
      </details>
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
        <section className="panel ledger" data-tour="ledger">
          <h2>Marketing fund</h2>
          <dl className="facts">
            <div><dt>Available for campaigns</dt><dd><Near y={s.available} /></dd></div>
            <div><dt>Set aside for approved campaigns</dt><dd><Near y={s.committed} /></dd></div>
            <div><dt>Paid to creators</dt><dd><Near y={s.paid} /></dd></div>
            <div><dt>Trading fees collected</dt><dd><Near y={s.fees_in} /></dd></div>
            <div><dt>Deposits kept from unopened offers<Info text="A creator who seals an offer but never opens it loses the 0.02 NEAR deposit (bid bond) to this fund." /></dt><dd><Near y={s.forfeits_in} /></dd></div>
            <div className="strong"><dt>Paid to founders</dt><dd>0 NEAR. The contract has no way to pay them.</dd></div>
          </dl>
        </section>
        <section className="panel" data-tour="constraints">
          <h2>Founder’s spend limits</h2>
          <p className="muted small">The only control the founder has over the money, and the contract keeps each limit within a safe range.{account === s.founder && ' Change them in the Founder’s desk.'}</p>
          <dl className="facts">
            <div><dt>Largest campaign budget</dt><dd><Near y={c.campaign_cap} d={2} /></dd></div>
            <div><dt>Largest single payment</dt><dd><Near y={c.max_payout} d={2} /></dd></div>
            <div><dt>Payments per hour</dt><dd>{c.payouts_per_hour}</dd></div>
            <div><dt>Minimum offer<Info text="Offers below this share of the budget can’t win (credible-bid floor, min_bid_bps)." /></dt><dd>{c.min_bid_bps / 100}% of the budget</dd></div>
            <div><dt>Tokens needed to join the holders</dt><dd>{fmtTokens(c.min_holder_tokens, 0)} {sym}</dd></div>
          </dl>
        </section>
        <section className="panel" data-tour="holders">
          <h2>Holders’ council<Info text={`The holders role in this startup’s Sputnik DAO, ${s.dao}`} /></h2>
          <p className="muted small">One holder, one vote: buying more tokens doesn’t buy more votes. A majority approves each campaign’s funding.</p>
          <ul className="plain">{s.holders.map((h) => <li key={h}><Acct a={h} />{h === account && <Chip kind="ember">you</Chip>}</li>)}</ul>
          {account && !isHolder && (bal >= min
            ? <button className="primary wide" disabled={!!busy} onClick={() => void run('Join the holders', () => call(state!.hub, 'join_holders', { startup: s.id }), { pending: 'Adding you to the holders…', done: 'You’re on the holders’ council. You can vote on campaigns now.', action: 'join_holders' })}>Join the holders</button>
            : <p className="muted small">Hold at least {fmtTokens(min, 0)} {sym} to join (you hold {fmtTokens(bal)}).</p>)}
          {isHolder && <p className="ok-text small">You’re on the holders’ council: you can vote on campaign funding below.</p>}
          <SignInHint what="join the holders and vote" />
        </section>
        <KeylessAgent startup={s.id} />
      </div>
      <div className="col-main">
        <FounderForms s={s} />
        <section className="panel" data-tour="campaigns">
          <h2>Campaigns</h2>
          {campaigns.length === 0 && <p className="muted">No campaigns yet. Once the marketing fund has fees in it, the founder posts a brief and creators send sealed offers.</p>}
          {campaigns.map((cm) => <CampaignCard key={cm.id} c={cm} s={s} isHolder={isHolder} />)}
        </section>
        <AuditLog s={s} />
      </div>
    </div>
  );
}

const VOTE_STATUS: Record<string, string> = { InProgress: 'voting', Approved: 'approved', Rejected: 'turned down', Expired: 'closed', '': 'opening' };

const PHASES = [
  { key: 'bidding', label: 'Sealed offers' },
  { key: 'reveal', label: 'Offers opened' },
  { key: 'voting', label: 'Holders vote' },
  { key: 'funded', label: 'Creator at work' },
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
  if (c.phase === 'bidding') clock = now < c.commit_ends_ms ? `Creators are sealing their offers: ${fmtLeft(c.commit_ends_ms - now)} left` : now < c.reveal_ends_ms ? `Offers are being opened: ${fmtLeft(c.reveal_ends_ms - now)} left` : 'Picking the winning offer…';
  else if (c.phase === 'funded' && c.deadline_ms) clock = `Your creator is on it: ${fmtLeft(c.deadline_ms - now)} to the deadline`;
  else if (c.phase === 'voting') clock = 'Holders are voting on the winner…';
  else if (c.phase === 'proposing') clock = 'Opening the holders’ funding vote…';
  const ended: Record<string, string> = { expired: 'Deadline passed: the unpaid budget went back to the marketing fund', no_bids: 'No offers in range', propose_failed: 'The holders’ funding vote couldn’t open; Signalfire is trying again' };
  const voted = account ? c.proposal?.votes[account] : undefined;
  const vote = (approve: boolean): void => {
    void run(approve ? 'Vote yes' : 'Vote no', () => call(s.dao, 'act_proposal', { id: c.proposal_id, action: approve ? 'VoteApprove' : 'VoteReject', proposal: c.proposal!.kind }),
      { pending: 'Casting your vote…', done: `Vote recorded: ${approve ? 'yes' : 'no'}.`, action: `act_proposal ${approve ? 'VoteApprove' : 'VoteReject'}` });
  };
  return (
    <article className={`campaign ${c.phase}`}>
      <header onClick={() => setOpen(!open)} className="c-head">
        <div>
          <h3><span className="cid">#{c.id}</span> {c.title}</h3>
          <p className="muted small">Budget <Near y={c.budget} d={3} /> to find {c.target} new {sym} buyers{clock && <> · <strong className="clock">{clock}</strong></>}</p>
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
          <h4 data-tour="bid-book">Offers</h4>
          {c.bids.length === 0 && <p className="muted small">No offers yet. Approved creators (people and AI agents) seal a price and a pitch, with a 0.02 NEAR deposit.</p>}
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
                        <span title="In range: at least the minimum offer and no more than the budget."><Chip kind={b.credible ? 'ok' : 'bad'}>{b.credible ? 'in range' : 'out of range'}</Chip></span>
                        <span className="muted small" title="+5% per completed campaign, −10% per miss; better track records win ties on price.">track record {b.rep >= 0 ? '+' : ''}{b.rep / 100}%</span>
                      </>
                    ) : (
                      <span className="sealed" title={`Fingerprint ${b.hash}`}>Sealed offer</span>
                    )}
                  </div>
                  {p && <blockquote>{p.pitch} <TeeBadge signed={p.signed} model={p.model} src={{ kind: 'pitch', campaign: c.id, creator: b.creator }} what="pitch" /></blockquote>}
                </li>
              );
            })}
          </ul>
          <SealedPanel c={c} />
          <MyBid c={c} s={s} />
          {c.proposal_id !== null && (
            <>
              <h4 data-tour="dao-vote">Holders’ funding vote<Info text={`Proposal ${c.proposal_id} in ${s.dao}`} /></h4>
              <p className="small">If the holders approve, <Near y={c.price} /> is set aside for {c.winner && <Acct a={c.winner} />}. Status: <Chip kind={c.proposal?.status === 'Approved' ? 'ok' : c.proposal?.status === 'Rejected' ? 'bad' : ''}>{VOTE_STATUS[c.proposal?.status ?? ''] ?? c.proposal?.status}</Chip></p>
              <details className="tech">
                <summary>What the vote does on NEAR</summary>
                <p className="muted small">Calls <code>fund_campaign({c.id})</code> on {state!.hub} through proposal {c.proposal_id} in <Acct a={s.dao} />. The vote itself can’t move money.</p>
              </details>
              {c.proposal && Object.keys(c.proposal.votes).length > 0 && (
                <ul className="plain votes">{Object.entries(c.proposal.votes).map(([a, v]) => <li key={a}><Acct a={a} /> <span title={v}><Chip kind={v === 'Approve' ? 'ok' : 'bad'}>{v === 'Approve' ? 'voted yes' : v === 'Reject' ? 'voted no' : v}</Chip></span></li>)}</ul>
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
              <h4>New buyers and payouts</h4>
              <div className="ms" data-tour="milestones">
                {Array.from({ length: MILESTONES }, (_, k) => {
                  const need = threshold(c.target, k + 1);
                  const paid = c.milestones_paid > k;
                  return (
                    <div key={k} className={`ms-step ${paid ? 'paid' : c.results >= need ? 'ready' : ''}`}>
                      <span className="ms-k">Payout {k + 1} of 3</span>
                      <span className="ms-need">{Math.min(c.results, need)}/{need} new buyers</span>
                      <span className="ms-state">{paid ? 'paid' : c.results >= need ? 'ready to pay' : 'waiting for buyers'}</span>
                    </div>
                  );
                })}
              </div>
              <p className="small">{c.results} of {c.target} new buyers came through the creator’s link. Paid so far: <Near y={c.paid} />, as <strong>{fmtTusd(c.paid_tusd)} tUSD</strong> (test dollars).{c.receipt && <> {c.winner && <Acct a={c.winner} />} received a completion certificate (NFT)<Info text={`Receipt NFT ${c.receipt}`} />.</>}</p>
              {c.phase === 'funded' && (
                <div className="reflink">
                  <span className="small">Creator’s link</span>
                  <code>{refLink}</code>
                  <button className="ghost small" onClick={() => void navigator.clipboard?.writeText(refLink)}>Copy</button>
                </div>
              )}
            </>
          )}
          <p className="small proof-row">
            <a href={`/api/campaign/${c.id}/proof`} target="_blank" rel="noreferrer">Proof (JSON)</a> · <a href="/how#verify">Check this campaign yourself</a>
          </p>
          <details className="tech">
            <summary>Command line</summary>
            <p className="muted small"><code>pnpm verify {c.id} {location.origin}</code> re-checks everything against NEAR itself, without trusting this server.</p>
          </details>
          {state && c.phase === 'funded' && account && c.results > 0 && <p className="muted small">The next payout is released automatically once enough new buyers arrive.</p>}
        </div>
      )}
    </article>
  );
}

function AuditLog({ s }: { s: Startup }) {
  const [rows, setRows] = useState<AuditEntry[] | null>(null);
  const [raw, setRaw] = useState(false);
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
    <section className="panel audit" data-tour="audit">
      <h2>Audit log <button type="button" className="ghost small raw-toggle" aria-pressed={raw} onClick={() => setRaw(!raw)}>{raw ? 'Plain view' : 'Raw view'}</button></h2>
      <p className="muted small">Every payment attempt and every spend-limit decision, written to NEAR’s public record by Signalfire’s contract. Creator reviews are shared by all startups.</p>
      {rows === null && <p className="muted">Loading…</p>}
      {rows && list.length === 0 && <p className="muted">Nothing logged yet.</p>}
      {list.length > 0 && <div className="tbl-wrap">
        <table className="tbl">
          <thead>{raw
            ? <tr><th>#</th><th>Action</th><th>Account</th><th className="r">Amount</th><th>Outcome and flags</th><th>Note</th><th className="r">When</th></tr>
            : <tr><th>#</th><th>What happened</th><th>Who</th><th className="r">Amount (NEAR)</th><th>Result</th><th>Details</th><th className="r">When</th></tr>}</thead>
          <tbody>
            {list.map((e) => (
              <tr key={e.n}>
                <td className="muted">{e.n}</td>
                <td>{raw ? e.action : auditWhat(e.action, e.outcome)}{e.campaign !== null && <span className="muted"> #{e.campaign}</span>}</td>
                <td>{e.account ? <Acct a={e.account} /> : '—'}</td>
                <td className="r">{e.amount !== '0' ? fmtNear(e.amount) : '—'}</td>
                <td>{raw ? <Chip kind={flagKind(e.outcome)}>{e.outcome}</Chip> : <span title={e.outcome}><Chip kind={flagKind(e.outcome)}>{auditResult(e.outcome)}</Chip></span>}{e.flags.map((f) => <span key={f} title={f}><Chip kind={flagKind(f)}>{raw ? f : FLAG[f] ?? f}</Chip></span>)}</td>
                <td className="note">{raw ? e.note : auditNote(e.action, e.note)}</td>
                <td className="r muted">{ago(e.ts_ms, now)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>}
    </section>
  );
}

