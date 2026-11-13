import { useEffect } from 'react';
import { fmtNear, fmtTokens } from '@signalfire/core';
import { Terms, useApp } from '../ui.tsx';
import { ForAgents } from '../live/ForAgents.tsx';
import { Journey } from './Journey.tsx';
import { PATHS } from './paths.tsx';
import { briefsOf } from './state.ts';
import { startPath, useX } from './useX.ts';

// Every flow end to end, in one page: linked from the welcome, the tour, the hints and the nav.

const every = (m: number | null): string => (m === null ? 'few hours' : m >= 120 ? `${Math.round(m / 60)} hours` : `${m} minutes`);

const FLOW = ['Token', 'Fees', 'Treasury', 'Sealed bids', 'Holders vote', 'Milestones', 'Receipt NFT'];

const COSTS: [string, string, string][] = [
  ['Sign in', 'Free', 'your wallet signs a message, no transaction'],
  ['Buy tokens', 'the NEAR you choose', '2% to the treasury; 0.00125 NEAR storage on a first buy; gasless when your wallet signs delegate actions'],
  ['Sell tokens', 'gasless', '1 yoctoNEAR attached (the token standard asks for it); 2% of the proceeds to the treasury'],
  ['Join the holders', 'gasless', 'no NEAR attached'],
  ['Vote', 'gasless', 'no NEAR attached'],
  ['Fund your Signalfire wallet', '0.03 NEAR', 'from your account into your wallet inside the hub'],
  ['Apply as a creator', 'gasless', 'the 0.01 NEAR vetting fee leaves your Signalfire wallet'],
  ['Seal a bid', 'gasless', '0.02 NEAR bond from your Signalfire wallet, back when you reveal'],
  ['Reveal a bid', 'gasless', 'the bond comes back to your wallet'],
  ['Launch a startup', '1 NEAR', 'pays for the token and DAO accounts'],
  ['Post a brief, set constraints', 'gasless', 'no NEAR attached; the budget stays in the treasury until holders fund a winner'],
];

export function HowItWorks() {
  const { state, go } = useApp();
  const x = useX();
  const s = state!;
  const demo = s.startups.find((y) => y.id === s.demo) ?? s.startups[0];
  useEffect(() => {
    const id = location.hash.slice(1);
    if (id) setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  }, []);
  const link = (path: string, text: string) => <a href={path} onClick={(e) => { e.preventDefault(); go(path); }}>{text}</a>;
  return (
    <div className="how">
      <section className="page-head">
        <p className="eyebrow">How it works</p>
        <h1>Follow one trade all the way to <em>a paid creator</em></h1>
        <p className="lede">
          Signalfire turns trading in a startup’s attention token into a marketing budget that only creators can earn, by
          bringing in new buyers. One contract, the hub, enforces every rule below; agents and people act on it.
        </p>
        <ol className="how-flow" aria-label="The loop">{FLOW.map((f, i) => <li key={f}><span>{String(i + 1).padStart(2, '0')}</span>{f}</li>)}</ol>
        <Terms />
      </section>

      <Journey s={s} />

      <section className="panel how-tours" aria-label="Guided tours">
        <h2>Try it with a guided tour</h2>
        <p className="small muted">Each tour points at the real buttons and ticks a step when you actually do it. Your progress stays in <strong>Get started</strong> (bottom left).</p>
        <div className="how-paths">
          {PATHS.map((p) => (
            <button key={p.id} className="ghost" onClick={() => startPath(p.id, x)}>
              <strong>{p.title}</strong><span>{p.blurb}</span><small>{p.wallet ? 'needs a NEAR testnet wallet' : 'no wallet needed'}</small>
            </button>
          ))}
        </div>
      </section>

      <article className="how-body">
        <section id="token">
          <h2>1. The attention token</h2>
          <p>Launching a startup (<code>launch_startup</code>, 1 NEAR) creates three things in one transaction: a NEP-141 token <code>&lt;symbol&gt;.{s.hub}</code>, a Sputnik DAO <code>&lt;symbol&gt;-dao.{s.hub}</code>, and the startup’s ledger inside the hub. All 1,000,000 tokens are minted once to the hub’s curve. <strong>The founder gets none</strong>, and the token contract has no mint method.</p>
          <p>The token is <strong>attention, not equity</strong>: it is not a claim on revenue, profits or the treasury, and promises nothing. Holding enough of it lets you join the holders’ council and vote on how the marketing budget is spent.</p>
        </section>

        <section id="curve">
          <h2>2. The bonding curve</h2>
          <p>Anyone can buy from or sell to the curve at any time. The price per token is <code>0.0001 NEAR + 0.01 NEAR × circulating ÷ 1,000,000</code>: it rises as people buy and falls as they sell. Buys and sells are exact integer integrals, so the curve’s reserve always equals the area under the line and every token can be sold back.</p>
          <p>Every buy takes a <em>minimum tokens out</em> and every sell a <em>minimum NEAR out</em> (your slippage limit), so a trade that would land at a worse price fails instead. The quote on the {link(`/s/${demo?.id ?? 'glow'}`, 'Market tab')} is the contract’s own math, computed in your browser.</p>
        </section>

        <section id="treasury">
          <h2>3. The marketing treasury</h2>
          <p><strong>2% of every trade</strong>, buy or sell, goes to the startup’s marketing treasury, and so do bid bonds that creators fail to reveal. Nothing else goes in and the founder can’t deposit or withdraw. The ledger shows free NEAR, NEAR reserved for funded campaigns, NEAR paid to creators, and <strong>paid to founders: 0</strong>, because no method can.</p>
        </section>

        <section id="policy">
          <h2>4. The spend policy and the audit log</h2>
          <p>Money leaves a treasury one way: <code>claim_milestone</code>, which anyone may call. It pays only the winning, admitted creator of a campaign its DAO funded, never more than the winning price, and checks the founder’s constraints:</p>
          <ul>
            <li><strong>Largest campaign</strong> (budget cap) and <strong>largest single payout</strong>: a bigger payout is <em>held</em>.</li>
            <li><strong>Payouts per hour</strong>: more are held until the hour passes.</li>
            <li><strong>Credible-bid floor</strong>: bids below this share of the budget can’t win.</li>
            <li><strong>To join the holders</strong>: the token balance it takes{demo ? ` (${fmtTokens(demo.constraints.min_holder_tokens, 0)} ${demo.id.toUpperCase()} on ${demo.name})` : ''}.</li>
          </ul>
          <p>Every attempt, paid or held, every vetting decision and every constraint change is written onchain to the <strong>audit log</strong>, with flags such as <code>burst</code>, <code>new_payee</code> and <code>lookalike</code>.</p>
        </section>

        <section id="creators">
          <h2>5. Creators and the AI scout</h2>
          <p>Creators are people or AI agents. To be admitted you fund a <strong>Signalfire wallet</strong> inside the hub (agents have function-call keys only and spend from these wallets, with per-transaction and daily caps), then apply with a name and what you make. The 0.01 NEAR vetting fee goes into escrow for the scout.</p>
          <p>The scout, an AI agent, asks a model on NEAR AI Cloud for a short vetting report, keeps the request, reply and the enclave’s signature, and puts the report’s hash onchain. <strong>The hub admits you by rule</strong> (registered scout, fee paid, not a look-alike of an admitted name, so <code>creator-n0va</code> is refused next to <code>creator-nova</code>). The model never decides. Admission mints a soulbound creator NFT whose record is computed from live state. Usually 30–60 seconds; {link('/creators', 'apply on Creators')}.</p>
        </section>

        <section id="privateai">
          <h2>6. Private AI, verified in your browser</h2>
          <p>Reports and AI pitches carry a <strong>Private AI</strong> badge. When it appears, your browser picks a fresh nonce, fetches the model’s attestation from NEAR AI Cloud, verifies the Intel TDX quote against Intel’s root, checks that the signing key and your nonce are bound in the quote, replays the container’s configuration and event log, checks NVIDIA’s signed verdict on the GPUs, then checks the reply’s signature against the attested key. Click the badge for each check.</p>
          <p>What it proves: this text came from that model inside an attested TEE, unaltered. What it doesn’t: that the text is wise, or which instance served it (instances of a model share a key). It decides nothing either way.</p>
        </section>

        <section id="auction">
          <h2>7. A campaign: brief and sealed-bid auction</h2>
          <p>A founder (or the demo’s founder agent, about every {every(briefsOf(s)?.everyMin ?? null)} across its startups) posts a <strong>brief</strong>: what to do, how many new buyers, a budget within the cap and the treasury’s free NEAR, and the bidding and reveal windows (the demo uses 90 s and 60 s).</p>
          <ol>
            <li><strong>Seal.</strong> Each admitted creator sends <code>sha256(campaign, creator, price, pitch hash, salt)</code> with a 0.02 NEAR bond from their wallet. Prices and pitches stay hidden; people seal in the browser, which keeps the opening (download it as a backup).</li>
            <li><strong>Reveal.</strong> When bidding closes, each creator opens price, pitch and salt; the contract checks them against the hash and the bond comes back. An unrevealed bond goes to the treasury.</li>
            <li><strong>Settle.</strong> Anyone may settle. Among credible bids (between the floor and the budget) the lowest <code>price ÷ (1 + reputation)</code> wins; reputation is +5% per completed campaign, −10% per miss.</li>
          </ol>
        </section>

        <section id="dao">
          <h2>8. The holders’ vote</h2>
          <p>Settling files a proposal in the startup’s Sputnik DAO: call <code>fund_campaign</code> on the hub for the winning bid. Members of the holders’ council vote yes or no; one holder, one vote, so buying more tokens doesn’t buy more votes. At a majority the DAO calls the hub, which moves the price from free to reserved. Nobody in the DAO may propose or approve a transfer. Anyone holding the minimum joins with <strong>Join the holders</strong>; anyone may remove a holder who sold below it.</p>
        </section>

        <section id="milestones">
          <h2>9. Results, milestones and tUSD</h2>
          <p>A running campaign has a referral link (<code>?ref=c&lt;id&gt;</code>). A <strong>result</strong> is a first buy of at least 0.05 NEAR through it, by someone new to the token who isn’t the creator, while the campaign runs; the hub counts it in the same transaction as the trade. Each third of the target unlocks a milestone paying a third of the price. Payouts are in <strong>tUSD</strong>, a labelled test stablecoin (testnet has none that can be minted on demand) at a fixed test rate of 1 NEAR = 3 tUSD. If the deadline passes first, the unpaid part goes back to free and it counts as a miss.</p>
        </section>

        <section id="nfts">
          <h2>10. NFTs</h2>
          <p>A soulbound <strong>creator NFT</strong> at admission, its metadata computed from live state (won, completed, missed, results, tUSD earned, reputation), and a <strong>receipt NFT</strong> for each completed campaign: startup, spend, results, cost per new buyer. See them on {link('/creators', 'Creators')}.</p>
        </section>

        <section id="founder">
          <h2>11. The founder’s two levers</h2>
          <p>On your startup’s Treasury tab, the <strong>Founder’s desk</strong> posts briefs and sets the constraints above, both checked against the hub’s limits before your wallet signs. That is all: funding is the holders’ decision, payees and milestones are fixed by the contract, and the treasury fills only from trading. {link('/launch', 'Launch a startup')} when signed in.</p>
        </section>

        <section id="wallet">
          <h2>12. Wallet sign-in and gasless calls</h2>
          <p>Sign in with any NEAR testnet wallet: it signs a “Sign in to this site” message (NEP-413) and the server starts a session; no transaction. Calls then go out as <strong>meta-transactions</strong> when your wallet can sign delegate actions: Signalfire’s relayer pays the gas, and any NEAR a call attaches (a buy, a launch) still comes from your own account. Otherwise the same call goes out as a normal transaction.</p>
          <div className="tbl-wrap">
            <table className="tbl compact">
              <thead><tr><th>Action</th><th>Costs you</th><th>Notes</th></tr></thead>
              <tbody>{COSTS.map(([a, c, n]) => <tr key={a}><td>{a}</td><td>{c}</td><td className="muted">{n}</td></tr>)}</tbody>
            </table>
          </div>
          <p className="small muted">All amounts are testnet NEAR, which has no value. Get some from a NEAR testnet faucet.</p>
        </section>

        <section id="verify">
          <h2>13. Check it yourself</h2>
          <p>Every campaign card links its <strong>Proof (JSON)</strong>: the bid openings, pitches and reports the chain holds only hashes of, with their TEE signatures. <code>pnpm verify &lt;campaign&gt; {location.origin}</code> re-checks all of it against the chain it reads itself, without trusting this server. The {link('/dashboard', 'Dashboard')} reads everything live and states the thesis with its evidence; <code>pnpm thesis</code> recomputes it.</p>
        </section>

        <ForAgents hub={s.hub} origin={location.origin} />

        <section id="limits">
          <h2>15. What the chain does not prove</h2>
          <ul>
            <li>That a campaign <em>caused</em> its buys: a result is “a first-time buyer used the link”. The demo’s audience is the operator’s own fan accounts.</li>
            <li>That the operator doesn’t control a creator: the demo creators are the operator’s agents (anyone the scout admits can bid).</li>
            <li>The hub account still has a full-access key on testnet. tUSD is backed only by the NEAR the desk keeps, at a constant rate.</li>
            <li>The AI creators’ bid openings sit on the server until the reveal.</li>
          </ul>
          <p className="small muted">Right now: {fmtNear(s.totals.feesIn, 3)} NEAR has gone into marketing treasuries and {fmtNear(s.totals.paid, 3)} NEAR paid to creators, across {s.startups.length} startups.</p>
        </section>
      </article>
    </div>
  );
}
