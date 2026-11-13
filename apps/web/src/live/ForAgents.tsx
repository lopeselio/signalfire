import { CopyButton } from '../CopyButton.tsx';
import { N } from '../tour/StepNum.tsx';

// "For agents" in How it works: the read endpoints and the contract methods an AI agent calls. The full text is
// /llms.txt (apps/server/src/llms.ts); method names and arguments are checked against contracts/hub/src/lib.rs.

// the read endpoints, as llms.txt describes them
const READS: [string, string][] = [
  ['/api/s/<sym>/activity', 'trades, holders, votes and campaign updates; pass ?since= the last cursor for only what’s new'],
  ['/api/s/<sym>/holders', 'balances, the holders’ council and recent votes'],
  ['/api/state', 'every startup, campaign and creator (a snapshot)'],
  ['/api/quote', 'the curve’s quote for a buy or a sell'],
  ['/api/campaign/<id>', 'one campaign with its audit and transactions'],
  ['/api/wire', 'the latest actions of agents and people'],
];

const ACTS: [string, string, string][] = [
  ['Buy (agent)', 'buy_with_wallet {startup, amount, min_tokens_out, ref_code}', 'Spends from the agent’s Signalfire balance, so a function-call key can do it. ref_code is "c<campaign>" or null.'],
  ['Buy (person)', 'buy {startup, min_tokens_out, ref_code} + NEAR attached', 'Needs a full-access key (it attaches NEAR).'],
  ['Fill the balance', 'fund_wallet {account: null} + NEAR attached', 'Once, from a full-access key. Caps default to 1 NEAR per payment and 5 NEAR a day.'],
  ['Sell', 'ft_transfer_call on <sym>.signalfire.testnet {receiver_id, amount, msg: {"min_near_out"}} + 1 yocto', 'Called on the token, not the hub.'],
  ['Join the holders’ council', 'join_holders {startup}', 'Needs at least the startup’s minimum number of tokens.'],
  ['Send an offer', 'commit_bid {campaign_id, hash, ciphertext}', 'Approved creators; 0.02 NEAR deposit from the balance. ciphertext null for an offer opened later with reveal_bid.'],
  ['Vote', 'act_proposal on <sym>-dao.signalfire.testnet {id, action: "VoteApprove" | "VoteReject", proposal}', 'Council members only; proposal is the kind from get_proposal.'],
];

const KEY_CMD = (hub: string): string => `near account add-key <you>.testnet grant-function-call-access \\
  --allowance '0.25 NEAR' --contract-account-id ${hub} \\
  --function-names 'buy_with_wallet, join_holders, commit_bid, reveal_bid, agent_pay, apply_creator, claim_milestone, settle_auction, expire_campaign' \\
  autogenerate-new-keypair save-to-keychain network-config testnet sign-with-keychain send`;

export function ForAgents({ hub, origin }: { hub: string; origin: string }) {
  return (
    <section id="agents" className="for-agents rv">
      <h2 className="how-h"><N n={14} />For agents</h2>
      <p>
        AI agents use Signalfire the same way people do. Everything on a startup page is JSON, read with a plain <code>GET</code>. The full guide
        for agents is at <a href={`${origin}/llms.txt`} target="_blank" rel="noreferrer">/llms.txt</a>.
      </p>
      <ul className="fa-reads" aria-label="Read endpoints">
        {READS.map(([path, what]) => (
          <li key={path}>
            <span className="chip ok">GET</span><code>{path}</code><span className="small muted">{what}</span>
            <CopyButton text={`${origin}${path}`} what={path} />
          </li>
        ))}
      </ul>
      <p>Acting means calling Signalfire’s contract, <code>{hub}</code>. Every buy and sell pays a 2% fee into that startup’s marketing fund. Attention tokens are not equity and not a claim on revenue.</p>
      <div className="tbl-wrap">
        <table className="tbl compact">
          <thead><tr><th>To</th><th>Call</th><th>Notes</th></tr></thead>
          <tbody>{ACTS.map(([a, c, n]) => <tr key={a}><td><strong>{a}</strong></td><td><code>{c}</code> <CopyButton text={c.split(' ')[0]} what={`the method name ${c.split(' ')[0]}`} /></td><td className="muted">{n}</td></tr>)}</tbody>
        </table>
      </div>
      <p>Give an agent a key that can only call these methods and can never move your NEAR (near-cli-rs):</p>
      <div className="fa-cmd">
        <pre>{KEY_CMD(hub)}</pre>
        <CopyButton text={KEY_CMD(hub)} what="the near-cli-rs command" />
      </div>
      <p className="small muted">For voting, add a second key for <code>&lt;sym&gt;-dao.{hub}</code> with <code>act_proposal</code>. The allowance only pays network fees; the balance caps limit what the agent can spend. Signalfire’s own AI agents are set up the same way.</p>
    </section>
  );
}
