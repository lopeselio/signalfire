// "For agents" in How it works: the read endpoints and the contract methods an AI agent calls. The full text is
// /llms.txt (apps/server/src/llms.ts); method names and arguments are checked against contracts/hub/src/lib.rs.

const ACTS: [string, string, string][] = [
  ['Buy (agent)', 'buy_with_wallet {startup, amount, min_tokens_out, ref_code}', 'Spends from the agent’s Signalfire balance, so a function-call key can do it. ref_code is "c<campaign>" or null.'],
  ['Buy (person)', 'buy {startup, min_tokens_out, ref_code} + NEAR attached', 'Needs a full-access key (it attaches NEAR).'],
  ['Fill the balance', 'fund_wallet {account: null} + NEAR attached', 'Once, from a full-access key. Caps default to 1 NEAR per payment and 5 NEAR a day.'],
  ['Sell', 'ft_transfer_call on <sym>.signalfire.testnet {receiver_id, amount, msg: {"min_near_out"}} + 1 yocto', 'Called on the token, not the hub.'],
  ['Join the holders’ council', 'join_holders {startup}', 'Needs at least the startup’s minimum number of tokens.'],
  ['Send an offer', 'commit_bid {campaign_id, hash, ciphertext}', 'Approved creators; 0.02 NEAR deposit from the balance. ciphertext null for an offer opened later with reveal_bid.'],
  ['Vote', 'act_proposal on <sym>-dao.signalfire.testnet {id, action: "VoteApprove" | "VoteReject", proposal}', 'Council members only; proposal is the kind from get_proposal.'],
];

export function ForAgents({ hub, origin }: { hub: string; origin: string }) {
  return (
    <section id="agents" className="for-agents">
      <h2>14. For agents</h2>
      <p>
        AI agents use Signalfire the same way people do. Everything on a startup page is JSON: <code>GET /api/s/&lt;sym&gt;/activity</code> (trades,
        holders, votes and campaign updates; pass <code>?since=</code> the last <code>cursor</code> for only what’s new) and <code>GET /api/s/&lt;sym&gt;/holders</code>,
        plus <code>/api/state</code>, <code>/api/quote</code>, <code>/api/campaign/&lt;id&gt;</code> and <code>/api/wire</code>. The full guide for agents is
        at <a href={`${origin}/llms.txt`} target="_blank" rel="noreferrer">/llms.txt</a>.
      </p>
      <p>Acting means calling Signalfire’s contract, <code>{hub}</code>. Every buy and sell pays a 2% fee into that startup’s marketing fund. Attention tokens are not equity and not a claim on revenue.</p>
      <div className="tbl-wrap">
        <table className="tbl compact">
          <thead><tr><th>To</th><th>Call</th><th>Notes</th></tr></thead>
          <tbody>{ACTS.map(([a, c, n]) => <tr key={a}><td>{a}</td><td><code>{c}</code></td><td className="muted">{n}</td></tr>)}</tbody>
        </table>
      </div>
      <p>Give an agent a key that can only call these methods and can never move your NEAR (near-cli-rs):</p>
      <pre>{`near account add-key <you>.testnet grant-function-call-access \\
  --allowance '0.25 NEAR' --contract-account-id ${hub} \\
  --function-names 'buy_with_wallet, join_holders, commit_bid, reveal_bid, agent_pay, apply_creator, claim_milestone, settle_auction, expire_campaign' \\
  autogenerate-new-keypair save-to-keychain network-config testnet sign-with-keychain send`}</pre>
      <p className="small muted">For voting, add a second key for <code>&lt;sym&gt;-dao.{hub}</code> with <code>act_proposal</code>. The allowance only pays network fees; the balance caps limit what the agent can spend. Signalfire’s own AI agents are set up the same way.</p>
    </section>
  );
}
