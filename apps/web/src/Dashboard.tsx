import { useEffect, useState } from 'react';
import { fmtNear, fmtTokens, fmtTusd } from '@signalfire/core';
import { api } from './api.ts';
import { StartupLogo } from './Discover.tsx';
import { Count } from './motion.tsx';
import { Acct, Chip, Info, Near, useApp } from './ui.tsx';
import { NextAction } from './NextAction.tsx';

// Public data, read live from the chain through /api/state, and the thesis with its evidence (/api/thesis, the same
// computation as `pnpm thesis`, which anyone can re-run against public RPC).

export function Dashboard() {
  const { state, go } = useApp();
  const s = state!;
  const t = s.totals;
  const done = s.campaigns.filter((c) => c.phase === 'done' || c.phase === 'expired');
  const owed = BigInt(s.solvency.owed ?? '0');
  const balance = BigInt(s.solvency.balance ?? '0');
  const storage = BigInt(s.solvency.locked_for_storage ?? '0');
  return (
    <div className="dashboard">
      <section className="page-head">
        <p className="eyebrow">Dashboard</p>
        <h1>Follow every fee to where it went</h1>
        <p className="lede">Every number here is read live from Signalfire’s contract<Info text={`The hub contract, ${s.hub}, and each startup’s Sputnik DAO`} /> and the holders’ councils on NEAR’s test network, refreshed every five seconds.</p>
        <NextAction page="dashboard" />
      </section>

      <section className="stats" aria-label="Totals">
        <div><span className="n"><Count value={fmtNear(t.volume, 2)} /><small> NEAR</small></span><span className="l">traded</span></div>
        <div><span className="n"><Count value={fmtNear(t.feesIn, 3)} /><small> NEAR</small></span><span className="l">into marketing funds (fees and kept deposits)</span></div>
        <div><span className="n"><Count value={fmtNear(t.paid, 3)} /><small> NEAR</small></span><span className="l">paid to creators ({fmtTusd(t.tusdPaid)} tUSD)</span></div>
        <div><span className="n">{t.done}/{t.funded}</span><span className="l">campaigns paid out / funded</span></div>
        <div><span className="n"><Count value={String(t.results)} /></span><span className="l">new buyers from completed campaigns</span></div>
        <div><span className="n">{t.costPerResult ? <>{fmtNear(t.costPerResult, 4)}<small> NEAR</small></> : 'none yet'}</span><span className="l">cost per new buyer</span></div>
      </section>

      <section className="panel">
        <h2>Startups</h2>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>Startup</th><th className="r">Price (NEAR)</th><th className="r">Tokens held</th><th className="r">Fees collected (NEAR)</th><th className="r">Available in fund (NEAR)</th><th className="r">Paid out (NEAR)</th><th className="r">Campaigns</th><th className="r">Buyers</th><th className="r">Holders</th></tr></thead>
            <tbody>
              {s.startups.map((st) => (
                <tr key={st.id} className="clickable" onClick={() => go(`/s/${st.id}`)}>
                  <td><span className="t-name"><StartupLogo id={st.id} size={26} /><span><strong>{st.name}</strong> <span className="muted">{st.id.toUpperCase()}</span>{st.status !== 'live' && <Chip kind="bad">{st.status}</Chip>}</span></span></td>
                  <td className="r">{fmtNear(st.price, 6)}</td>
                  <td className="r">{fmtTokens(st.circulating, 0)}</td>
                  <td className="r">{fmtNear(st.fees_in, 4)}</td>
                  <td className="r">{fmtNear(st.available, 4)}</td>
                  <td className="r">{fmtNear(st.paid, 4)}</td>
                  <td className="r">{st.campaigns.length}</td>
                  <td className="r">{st.buyers}</td>
                  <td className="r">{st.holders.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="split even">
        <section className="panel">
          <h2>What each new buyer cost</h2>
          {done.length === 0 && <p className="muted">No campaign has finished yet.</p>}
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Campaign</th><th>Creator</th><th className="r">Spent (NEAR)</th><th className="r">Buyers</th><th className="r">Per buyer (NEAR)</th></tr></thead>
              <tbody>
                {done.map((c) => (
                  <tr key={c.id}>
                    <td>#{c.id} {c.title} {c.phase === 'expired' && <Chip kind="bad">expired</Chip>}</td>
                    <td>{c.winner && <Acct a={c.winner} />}</td>
                    <td className="r">{fmtNear(c.paid, 4)}</td>
                    <td className="r">{c.results}/{c.target}</td>
                    <td className="r">{c.results ? fmtNear(BigInt(c.paid) / BigInt(c.results), 4) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section className="panel">
          <h2>How each creator has done</h2>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Creator</th><th className="r">Won</th><th className="r">Done</th><th className="r">Missed</th><th className="r">Buyers</th><th className="r">tUSD</th><th className="r">Rep.</th></tr></thead>
              <tbody>
                {s.creators.map((c) => (
                  <tr key={c.creator.account}>
                    <td><Acct a={c.creator.account} /></td>
                    <td className="r">{c.creator.won}</td>
                    <td className="r">{c.creator.completed}</td>
                    <td className="r">{c.creator.missed}</td>
                    <td className="r">{c.creator.results}</td>
                    <td className="r">{fmtTusd(c.creator.paid_tusd)}</td>
                    <td className="r">{c.rep_bps / 100}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <section className="panel solvency">
        <h2>Can Signalfire pay everyone?</h2>
        <p className="small">What Signalfire’s contract owes in NEAR (buy-back pools, marketing funds, Signalfire balances, the NEAR behind tUSD) next to what it holds.</p>
        <dl className="facts">
          <div><dt>Buy-back pools</dt><dd><Near y={s.solvency.reserves ?? '0'} /></dd></div>
          <div><dt>Marketing funds</dt><dd><Near y={s.solvency.treasuries ?? '0'} /></dd></div>
          <div><dt>Signalfire balances (agents and creators)</dt><dd><Near y={s.solvency.wallets ?? '0'} /></dd></div>
          <div><dt>NEAR behind tUSD</dt><dd><Near y={s.solvency.desk_reserve ?? '0'} /></dd></div>
          <div className="strong"><dt>Owed in total</dt><dd><Near y={owed} /></dd></div>
          <div className="strong"><dt>Contract balance</dt><dd><Near y={balance} /> <small className="muted">({fmtNear(storage, 2)} NEAR of it reserved by NEAR for data storage)</small></dd></div>
        </dl>
        <p className={balance - storage >= owed ? 'ok-text small' : 'bad-text small'}>{balance - storage >= owed ? 'Covered: Signalfire holds more than everything it owes.' : 'Not covered: Signalfire owes more than it holds right now.'}</p>
      </section>

      <Thesis />
    </div>
  );
}

interface ThesisData {
  at: number; claim: string;
  costs: { action: string; method: string; n: number; medianNear: string; maxNear: string }[];
  loopCostNear: string | null;
  fees: { inNear: string; toCreatorsNear: string; reservedNear: string; freeNear: string; toFoundersNear: string; shareToCreatorsPct: number };
  startups: { id: string; name: string; feesInNear: string; paidNear: string; campaignsDone: number; newBuyers: number; costPerBuyerNear: string | null }[];
  bounds: { payoutAttempts: number; paid: number; held: number; admissionsRefused: number; flags: Record<string, number>; agents: number; agentsFcOnly: number; fullAccessKeys: number; agentsUnread?: number; walletsCapDayNear: string; walletsSpentNear: string; fanSpentMaxNear: string; fanCapDayNear: string };
  latency: { campaigns: number; voteMedianS: number | null; briefToFundedMedianS: number | null; briefToPaidMedianS: number | null };
  runway?: { firstBuysLeft: number; perCampaign: number; campaignsLeft: number; hoursBetweenBriefs: number; lastsUntil: string; treasuriesFreeNear: string };
  limits: string[];
}

function Thesis() {
  const [t, setT] = useState<ThesisData | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => { api<ThesisData>('/thesis').then(setT).catch(() => setErr(true)); }, []);
  return (
    <section className="thesis" data-tour="thesis">
      <p className="eyebrow">Thesis</p>
      <h2>Why agent-run marketing treasuries belong on NEAR</h2>
      <p>
        Attention tokens work: people trade a token because a project is interesting. On most launchpads the fees and a share of the
        tokens go to the founders, so the community that bought the story pays for the founders’ exit. Signalfire changes
        where the money can go: fees can only buy reach, through campaigns creators bid for and holders approve, paid as new
        buyers arrive. That only works if many small actions (bids, votes, buys, payouts) are cheap, fast and checkable, and if
        the agents doing them can’t move money they shouldn’t. That is the claim; below is the evidence, recomputed from chain data.
      </p>
      {err && <p className="muted">The evidence couldn’t be loaded right now; run <code>pnpm thesis</code> to compute it yourself.</p>}
      {!t && !err && <p className="muted">Reading transactions from an archival RPC…</p>}
      {t && (
        <div className="evidence">
          <h3>1. An agent action costs a thousandth of a NEAR or less</h3>
          <p className="small muted">Gas burnt, read from each transaction’s receipts. One whole campaign is 19 transactions{t.loopCostNear && <>: about <strong>{t.loopCostNear} NEAR</strong> of gas</>}.</p>
          <div className="tbl-wrap"><table className="tbl compact">
            <thead><tr><th>Action</th><th>Method</th><th className="r">Median (NEAR)</th><th className="r">Max</th><th className="r">n</th></tr></thead>
            <tbody>{t.costs.map((c) => <tr key={c.method}><td>{c.action}</td><td><code>{c.method}</code></td><td className="r">{c.medianNear}</td><td className="r">{c.maxNear}</td><td className="r">{c.n}</td></tr>)}</tbody>
          </table></div>

          <h3>2. Fees reach creators, never founders</h3>
          <p className="small">{t.fees.inNear} NEAR came into marketing treasuries: <strong>{t.fees.toCreatorsNear} NEAR ({t.fees.shareToCreatorsPct}%) paid to creators</strong>, {t.fees.reservedNear} reserved for running campaigns, {t.fees.freeNear} free for the next briefs, and {t.fees.toFoundersNear} to founders. The rest is not stuck: it waits for briefs, and no method can send it anywhere else.</p>
          <div className="tbl-wrap"><table className="tbl compact">
            <thead><tr><th>Startup</th><th className="r">Fees in</th><th className="r">Paid to creators</th><th className="r">Campaigns</th><th className="r">New buyers</th><th className="r">Per new buyer (NEAR)</th></tr></thead>
            <tbody>{t.startups.map((s) => <tr key={s.id}><td><span className="t-name"><StartupLogo id={s.id} size={22} />{s.name}</span></td><td className="r">{s.feesInNear}</td><td className="r">{s.paidNear}</td><td className="r">{s.campaignsDone}</td><td className="r">{s.newBuyers}</td><td className="r">{s.costPerBuyerNear ?? '—'}</td></tr>)}</tbody>
          </table></div>

          <h3>3. Keys and policy bound what agents can move</h3>
          <ul className="plain small">
            <li><strong>{t.bounds.agentsFcOnly} of {t.bounds.agents}</strong> agent accounts hold function-call keys only ({t.bounds.fullAccessKeys} full-access keys among them){t.bounds.agentsUnread ? `; ${t.bounds.agentsUnread} couldn’t be read this time` : ''}.</li>
            <li>Agents spent {t.bounds.walletsSpentNear} NEAR in total from capped hub wallets ({t.bounds.walletsCapDayNear} NEAR/day of caps across all of them); the busiest fan spent {t.bounds.fanSpentMaxNear} NEAR over its life, at most {t.bounds.fanCapDayNear} NEAR a day.</li>
            <li>{t.bounds.payoutAttempts} payout attempts went through the spend policy: {t.bounds.paid} paid, {t.bounds.held} held. {t.bounds.admissionsRefused} creator admission refused (a look-alike name). Flags raised: {Object.entries(t.bounds.flags).map(([k, v]) => `${k} ×${v}`).join(', ') || 'none'}.</li>
          </ul>

          <h3>4. Holders decide in minutes</h3>
          <p className="small">Across {t.latency.campaigns} funded campaigns: DAO proposal to funded, median <strong>{t.latency.voteMedianS ?? '—'} s</strong>; brief to funded {t.latency.briefToFundedMedianS ?? '—'} s; brief to the last milestone paid {t.latency.briefToPaidMedianS ?? '—'} s.</p>

          {t.runway && (
            <>
              <h3>5. The demo keeps running</h3>
              <p className="small">{t.runway.firstBuysLeft} first-time buys are left in the simulated audience: {t.runway.campaignsLeft} more campaigns of {t.runway.perCampaign} new buyers, one brief every {t.runway.hoursBetweenBriefs} hours, until about <strong>{t.runway.lastsUntil}</strong>. {t.runway.treasuriesFreeNear} NEAR is free in the treasuries to fund them.</p>
            </>
          )}

          <h3>Limits</h3>
          <ul className="small muted">{t.limits.map((l) => <li key={l}>{l}</li>)}</ul>
          <p className="small">Recompute all of it yourself, with no keys: <code>pnpm thesis</code> (reads hub and DAO state over public RPC, and every transaction from an archival RPC). Computed {new Date(t.at).toUTCString()}.</p>
        </div>
      )}
    </section>
  );
}
