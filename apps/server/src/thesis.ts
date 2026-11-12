import { accessKeys } from './chain.ts';
import { config } from './config.ts';
import { getAudit, getCampaigns, getProposal, getStartups, getWallet, type Campaign } from './hub.ts';
import { CREATORS, FAN_COUNT, HOLDERS, SCOUT, fanAccount } from './personas.ts';

// "Why agent-run marketing treasuries belong on NEAR": every number recomputed from the chain.
// - hub and DAO state through public RPC views (startups, campaigns, audit log, wallets, proposals, access keys)
// - what each agent action cost, from the transactions' own receipts (gas burnt), read from an archival RPC
// The transaction hashes come from the wire (the server's log of what the agents sent); each one is then read from
// the chain itself, so a wrong or made-up hash simply drops out of the sample.

const ARCHIVALS = (process.env.ARCHIVAL_RPC_URL ?? 'https://archival-rpc.testnet.fastnear.com,https://archival-rpc.testnet.near.org').split(',');

const near = (y: bigint, d = 5): string => (Number(y) / 1e24).toFixed(d);

export interface WireTx { who: string; what: string; tx?: string; kind: string }
export interface ActionCost { action: string; method: string; n: number; medianNear: string; maxNear: string }
export interface Thesis {
  at: number;
  network: string;
  hub: string;
  claim: string;
  costs: ActionCost[];
  loopCostNear: string | null;
  fees: { inNear: string; toCreatorsNear: string; reservedNear: string; freeNear: string; toFoundersNear: string; shareToCreatorsPct: number };
  startups: { id: string; name: string; feesInNear: string; paidNear: string; campaignsDone: number; newBuyers: number; costPerBuyerNear: string | null }[];
  bounds: {
    payoutAttempts: number; paid: number; held: number; admissionsRefused: number; flags: Record<string, number>;
    agents: number; agentsFcOnly: number; fullAccessKeys: number;
    walletsCapDayNear: string; walletsSpentNear: string; fanSpentMaxNear: string; fanCapDayNear: string;
  };
  latency: { campaigns: number; voteMedianS: number | null; briefToFundedMedianS: number | null; briefToPaidMedianS: number | null };
  limits: string[];
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** The account that signed a wire line's transaction (the agents' display names → their accounts). */
function signerOf(w: WireTx): string | null {
  const c = CREATORS.find((x) => x.name === w.who);
  if (c) return c.account;
  const h = HOLDERS.find((x) => x.name === w.who);
  if (h) return h.account;
  if (w.who === SCOUT.name) return SCOUT.account;
  if (w.who === 'Signalfire' || w.who.endsWith(' founder')) return config.operator;
  if (/^fan-\d{2}$/.test(w.who)) return `${w.who}.${config.hub}`;
  return null;
}

const ACTIONS: { kind: string; match: RegExp; action: string; method: string }[] = [
  { kind: 'brief', match: /posted brief/, action: 'Founder posts a brief', method: 'create_campaign' },
  { kind: 'pay', match: /paid .* audience brief/, action: 'Creator pays the scout (agent to agent)', method: 'agent_pay' },
  { kind: 'bid', match: /sealed a bid/, action: 'Creator seals a bid (bond from its wallet)', method: 'commit_bid' },
  { kind: 'reveal', match: /revealed/, action: 'Creator reveals its bid', method: 'reveal_bid' },
  { kind: 'settle', match: /settled the auction/, action: 'Settle + file the DAO proposal', method: 'settle_auction' },
  { kind: 'vote', match: /voted/, action: 'Holder votes in the DAO', method: 'act_proposal' },
  { kind: 'buy', match: /bought/, action: 'Fan buys through a referral link', method: 'buy_with_wallet' },
  { kind: 'payout', match: /claimed milestone/, action: 'Milestone payout through the spend policy', method: 'claim_milestone' },
];

async function burnt(hash: string, sender: string): Promise<bigint | null> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tx', params: { tx_hash: hash, sender_account_id: sender, wait_until: 'NONE' } });
  // archival endpoints rate-limit bursts: back off and alternate between two of them
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const r = await fetch(ARCHIVALS[attempt % ARCHIVALS.length], { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { result?: { transaction_outcome: { outcome: { tokens_burnt: string } }; receipts_outcome: { outcome: { tokens_burnt: string } }[] }; error?: unknown };
      if (!j.result) return null; // unknown hash or sender: drops out of the sample
      return BigInt(j.result.transaction_outcome.outcome.tokens_burnt) + j.result.receipts_outcome.reduce((a, x) => a + BigInt(x.outcome.tokens_burnt), 0n);
    } catch {
      await new Promise((res) => setTimeout(res, 800 * (attempt + 1)));
    }
  }
  return null;
}

/** Gas burnt per agent action, from up to `per` recent transactions of each kind. */
async function actionCosts(wire: WireTx[], per: number): Promise<ActionCost[]> {
  const out: ActionCost[] = [];
  for (const a of ACTIONS) {
    const sample = wire.filter((w) => w.kind === a.kind && w.tx && a.match.test(w.what) && !/refused/.test(w.what)).slice(0, per);
    const costs: bigint[] = [];
    for (const w of sample) {
      const s = signerOf(w);
      if (!s) continue;
      const b = await burnt(w.tx!, s);
      if (b !== null) costs.push(b);
    }
    if (!costs.length) continue;
    const sorted = [...costs].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    const mid = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2n;
    out.push({ action: a.action, method: a.method, n: costs.length, medianNear: near(mid, 6), maxNear: near(sorted[sorted.length - 1], 6) });
  }
  return out;
}

export async function computeThesis(wire: WireTx[], opts: { perAction?: number } = {}): Promise<Thesis> {
  const [startups, campaigns, audit] = await Promise.all([getStartups(), getCampaigns(), getAudit()]);
  const costs = await actionCosts(wire, opts.perAction ?? 6);

  // one whole campaign, as the agents run it: 1 brief, 3 scout payments, 3 bids, 3 reveals, 1 settle, 2 votes, 3 buys, 3 payouts
  const per: Record<string, number> = { create_campaign: 1, agent_pay: 3, commit_bid: 3, reveal_bid: 3, settle_auction: 1, act_proposal: 2, buy_with_wallet: 3, claim_milestone: 3 };
  const byMethod = Object.fromEntries(costs.map((c) => [c.method, Number(c.medianNear)]));
  const loopCost = Object.keys(per).every((m) => byMethod[m] !== undefined) ? Object.entries(per).reduce((a, [m, k]) => a + byMethod[m] * k, 0) : null;

  // where the trading fees went
  let feesIn = 0n, paid = 0n, reserved = 0n, free = 0n;
  for (const s of startups) {
    feesIn += BigInt(s.fees_in) + BigInt(s.forfeits_in);
    paid += BigInt(s.paid);
    reserved += BigInt(s.committed);
    free += BigInt(s.available);
  }

  const done = (c: Campaign): boolean => c.phase === 'done' || c.phase === 'expired';
  const perStartup = startups.map((s) => {
    const cs = campaigns.filter((c) => c.startup === s.id && done(c));
    const buyers = cs.reduce((a, c) => a + c.results, 0);
    const spend = cs.reduce((a, c) => a + BigInt(c.paid), 0n);
    return {
      id: s.id, name: s.name, feesInNear: near(BigInt(s.fees_in) + BigInt(s.forfeits_in), 4), paidNear: near(BigInt(s.paid), 4),
      campaignsDone: cs.length, newBuyers: buyers, costPerBuyerNear: buyers ? near(spend / BigInt(buyers), 4) : null,
    };
  });

  // what bounded the agents' spending
  const payouts = audit.filter((e) => e.action === 'payout');
  const flags: Record<string, number> = {};
  for (const e of audit) for (const f of e.flags) flags[f] = (flags[f] ?? 0) + 1;
  const fans = Array.from({ length: FAN_COUNT }, (_, i) => fanAccount(i + 1));
  const agents = [...CREATORS.map((c) => c.account), SCOUT.account, ...HOLDERS.map((h) => h.account), ...fans];
  let fcOnly = 0, full = 0, capDay = 0n, spent = 0n, fanSpentMax = 0n, fanCap = 0n, counted = 0;
  for (const a of agents) {
    const keys = await accessKeys(a).catch(() => null);
    if (keys && keys.length) {
      counted++;
      const fa = keys.filter((k) => k.access_key.permission === 'FullAccess').length;
      full += fa;
      if (fa === 0) fcOnly++;
    }
    const w = await getWallet(a).catch(() => null);
    if (w) {
      capDay += BigInt(w.cap_day);
      spent += BigInt(w.spent_total);
      if (a.startsWith('fan-')) {
        if (BigInt(w.spent_total) > fanSpentMax) fanSpentMax = BigInt(w.spent_total);
        fanCap = BigInt(w.cap_day);
      }
    }
  }

  // how long the humans-in-the-loop part takes: proposal filed → DAO executed fund_campaign
  const votes: number[] = [], toFunded: number[] = [], toPaid: number[] = [];
  for (const c of campaigns.filter((x) => x.funded_ms && x.proposal_id !== null)) {
    const s = startups.find((x) => x.id === c.startup);
    const p = s ? await getProposal(s.dao, c.proposal_id!) : null;
    if (p) votes.push((c.funded_ms! - Number(BigInt(p.submission_time) / 1_000_000n)) / 1000);
    toFunded.push((c.funded_ms! - c.created_ms) / 1000);
    const last = payouts.filter((e) => e.campaign === c.id && e.outcome === 'paid').reduce((m, e) => Math.max(m, e.ts_ms), 0);
    if (c.phase === 'done' && last) toPaid.push((last - c.created_ms) / 1000);
  }
  const round = (x: number | null): number | null => (x === null ? null : Math.round(x));

  return {
    at: Date.now(),
    network: config.network,
    hub: config.hub,
    claim:
      'Agent-run marketing treasuries need cheap, frequent, verifiable small actions and keys that can only do what they are for. ' +
      'On NEAR a whole campaign (brief, sealed bids, DAO vote, attributed buys, three payouts) costs about a thousandth of a NEAR of gas or less per action, ' +
      'function-call keys and a contract spend policy bound what every agent can move, and a DAO vote settles in seconds.',
    costs,
    loopCostNear: loopCost === null ? null : loopCost.toFixed(5),
    fees: {
      inNear: near(feesIn, 4), toCreatorsNear: near(paid, 4), reservedNear: near(reserved, 4), freeNear: near(free, 4), toFoundersNear: '0',
      shareToCreatorsPct: feesIn > 0n ? Math.round(Number((paid * 10_000n) / feesIn)) / 100 : 0,
    },
    startups: perStartup,
    bounds: {
      payoutAttempts: payouts.length, paid: payouts.filter((e) => e.outcome === 'paid').length,
      held: payouts.filter((e) => e.outcome !== 'paid').length,
      admissionsRefused: audit.filter((e) => e.action === 'vet' && e.outcome === 'rejected').length,
      flags, agents: counted, agentsFcOnly: fcOnly, fullAccessKeys: full,
      walletsCapDayNear: near(capDay, 2), walletsSpentNear: near(spent, 3), fanSpentMaxNear: near(fanSpentMax, 3), fanCapDayNear: near(fanCap, 2),
    },
    latency: { campaigns: toFunded.length, voteMedianS: round(median(votes)), briefToFundedMedianS: round(median(toFunded)), briefToPaidMedianS: round(median(toPaid)) },
    limits: [
      'Testnet: gas prices and RPC behaviour match mainnet, but the token prices, the audience (simulated fan accounts) and the creators (our agents) do not.',
      `A small sample: ${campaigns.filter(done).length} finished campaigns across ${startups.length} startups.`,
      'Gas costs are measured from our own transactions (the wire supplies the hashes; each is read back from an archival RPC). Fees in NEAR, not USD.',
      'Cost per new buyer is a mechanism test (fixed brief budgets, a first-time-buyer rule), not a market price for attention.',
      'Vote latency is agent holders voting by rule; people would take longer.',
    ],
  };
}

