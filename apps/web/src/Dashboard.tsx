import { fmtNear, fmtTokens, fmtTusd } from '@signalfire/core';
import { Acct, Chip, Near, useApp } from './ui.tsx';

// Public data, read live from the chain through /api/state, and the written thesis.

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
        <h1>Dashboard</h1>
        <p className="lede">Every number here is read from <Acct a={s.hub} full /> and the startups’ DAOs on NEAR testnet, refreshed every five seconds.</p>
      </section>

      <section className="stats" aria-label="Totals">
        <div><span className="n">{fmtNear(t.volume, 2)}<small> NEAR</small></span><span className="l">traded</span></div>
        <div><span className="n">{fmtNear(t.feesIn, 3)}<small> NEAR</small></span><span className="l">fees and bonds in</span></div>
        <div><span className="n">{fmtNear(t.paid, 3)}<small> NEAR</small></span><span className="l">paid to creators ({fmtTusd(t.tusdPaid)} tUSD)</span></div>
        <div><span className="n">{t.done}/{t.funded}</span><span className="l">campaigns paid out / funded</span></div>
        <div><span className="n">{t.results}</span><span className="l">new buyers from completed campaigns</span></div>
        <div><span className="n">{t.costPerResult ? <>{fmtNear(t.costPerResult, 4)}<small> NEAR</small></> : 'none yet'}</span><span className="l">cost per new buyer</span></div>
      </section>

      <section className="panel">
        <h2>Startups</h2>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>Startup</th><th className="r">Price (NEAR)</th><th className="r">Circulating</th><th className="r">Fees in (NEAR)</th><th className="r">Treasury free (NEAR)</th><th className="r">Paid out (NEAR)</th><th className="r">Campaigns</th><th className="r">Buyers</th><th className="r">Holders</th></tr></thead>
            <tbody>
              {s.startups.map((st) => (
                <tr key={st.id} className="clickable" onClick={() => go(`/s/${st.id}`)}>
                  <td><strong>{st.id.toUpperCase()}</strong> <span className="muted">{st.name}</span>{st.status !== 'live' && <Chip kind="bad">{st.status}</Chip>}</td>
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
          <h2>Cost per result</h2>
          {done.length === 0 && <p className="muted">No campaign has finished yet.</p>}
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Campaign</th><th>Creator</th><th className="r">Spend (NEAR)</th><th className="r">Buyers</th><th className="r">Per buyer (NEAR)</th></tr></thead>
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
          <h2>Creators’ records</h2>
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
        <h2>Can the hub pay everyone?</h2>
        <p className="small">What the hub owes in NEAR (curve reserves, treasuries, agent wallets, the tUSD desk’s backing) next to what it holds.</p>
        <dl className="facts">
          <div><dt>Curve reserves</dt><dd><Near y={s.solvency.reserves ?? '0'} /></dd></div>
          <div><dt>Marketing treasuries</dt><dd><Near y={s.solvency.treasuries ?? '0'} /></dd></div>
          <div><dt>Agent and creator wallets</dt><dd><Near y={s.solvency.wallets ?? '0'} /></dd></div>
          <div><dt>tUSD desk backing</dt><dd><Near y={s.solvency.desk_reserve ?? '0'} /></dd></div>
          <div className="strong"><dt>Owed in total</dt><dd><Near y={owed} /></dd></div>
          <div className="strong"><dt>Hub balance</dt><dd><Near y={balance} /> <small className="muted">({fmtNear(storage, 2)} NEAR of it locked for contract storage)</small></dd></div>
        </dl>
        <p className={balance - storage >= owed ? 'ok-text small' : 'bad-text small'}>{balance - storage >= owed ? 'Covered: the hub’s free balance exceeds everything it owes.' : 'Not covered: the hub owes more than its free balance.'}</p>
      </section>

      <section className="thesis">
        <h2>Why attention markets need spend-restricted treasuries</h2>
        <p>
          Attention tokens work: people will trade a token because a project is interesting, and that trading is real demand
          for the project’s story. But on most launchpads the fees and the founders’ allocation go to the founders. The token
          becomes exit liquidity, the community that bought the story pays for it, and the next launch inherits the distrust.
        </p>
        <p>
          Signalfire changes one thing: where the money can go. Every trade pays 2% into a marketing treasury the founders cannot
          withdraw. The only way out is a campaign that vetted creators bid for, that holders approve, and that pays only as new
          buyers arrive. Trading volume turns into distribution, and the people who supply the volume decide how it is spent.
        </p>
        <p>
          On NEAR this is enforceable rather than promised. The treasury is a ledger inside one contract with no withdraw method;
          funding is a FunctionCall proposal in a Sputnik DAO whose policy gives nobody a transfer permission; agents act through
          function-call keys and capped wallets; every payout passes a spend policy and lands in an onchain audit log; the token
          has a fixed supply with no mint method.
        </p>
        <p>
          What the data here shows: fees in, treasury balances, campaigns funded, what each one cost per new buyer, and every
          creator’s record, all read from the chain and checkable with <code>pnpm verify</code>. What it does not show: this is
          testnet, the audience is simulated fan accounts and the demo creators are our own agents, so the cost per buyer is a
          mechanism test, not a market price. The thesis to test with real money is whether cost per holder falls as creators
          build reputation and holders learn which pitches deliver.
        </p>
      </section>
    </div>
  );
}
