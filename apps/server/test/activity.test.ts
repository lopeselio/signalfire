import { describe, expect, it } from 'vitest';
import { buildActivity, createActivity, group, nameOf, sinceFilter, type ActivityDeps } from '../src/activity.ts';
import type { Campaign, Proposal, Startup, Trade } from '../src/hub.ts';
import type { WireItem } from '../src/store.ts';
import { readFileSync } from 'node:fs';
import { llmsTxt } from '../src/llms.ts';

const HUB = 'hub.testnet';
const NEAR = (n: number): string => (BigInt(Math.round(n * 1000)) * 10n ** 21n).toString();
const startup: Startup = {
  id: 'sushi', name: 'Sushi', pitch: '', founder: 'eliocodes.testnet', token: `sushi.${HUB}`, dao: `sushi-dao.${HUB}`, status: 'live',
  circulating: '2962636511', reserve: '0', available: '0', committed: '0', paid: '0', fees_in: '0', forfeits_in: '0',
  trades: 4, volume: '0', buyers: 3, constraints: { campaign_cap: '0', max_payout: '0', payouts_per_hour: 6, min_bid_bps: 2000, min_holder_tokens: '100000000' },
  recent_payouts: [], last_payout_ms: null, campaigns: [12], created_ms: 0,
};
const trade = (n: number, ts: number, account: string, side: 'buy' | 'sell', ref: string | null, attributed: number | null): Trade => ({
  n, ts_ms: ts, account, side, near: NEAR(0.1), tokens: '1234000000', fee: '0', circulating_after: '1000', ref_code: ref, attributed,
});
const trades: Trade[] = [
  trade(3, 4_000, 'sushiman1.testnet', 'sell', null, null),
  trade(2, 3_000, 'sushiman1.testnet', 'buy', 'c12', null),
  trade(1, 2_000, `fan-05.${HUB}`, 'buy', 'c12', 12),
  trade(0, 1_000, 'eliocodes.testnet', 'buy', null, null),
];
const quill = `creator-quill.${HUB}`;
const campaign: Campaign = {
  id: 12, startup: 'sushi', title: 'Bring 3 new chefs', brief: '', target: 3, budget: '0', created_ms: 100, commit_ends_ms: 300, reveal_ends_ms: 400,
  duration_ms: 0, phase: 'funded', winner: quill, price: '0', proposal_id: 0, funded_ms: 900, deadline_ms: 99_000, results: 1,
  attributed: [`fan-05.${HUB}`], milestones_paid: 1, paid: '0', paid_tusd: '0', receipt: null,
  bids: [
    { creator: `creator-nova.${HUB}`, hash: 'a', committed_ms: 200, revealed: false, price: null, pitch_hash: null, credible: false, rep: 0, bond_settled: true },
    { creator: quill, hash: 'b', committed_ms: 210, revealed: true, price: '1', pitch_hash: null, credible: true, rep: 0, bond_settled: true },
  ],
};
const proposal: Proposal = { id: 0, proposer: HUB, description: '', kind: {}, status: 'Approved', vote_counts: {}, votes: { 'eliocodes.testnet': 'Approve' }, submission_time: '500000000' };
const wire: WireItem[] = [
  { at: 2_500, who: 'fan-05', what: "bought 0.06 NEAR of SUSHI through Quill's link (c12)", tx: 'FANTX', kind: 'buy', campaign: 12 },
  { at: 2_600, who: 'Signalfire', what: 'claimed milestone 1 of #12 for Quill', tx: 'CLAIMTX', kind: 'payout', campaign: 12 },
  { at: 2_700, who: 'keyless agent', what: 'paid 0.00 tUSD for milestone 1 of #12 to creator-quill', tx: 'PAYTX', kind: 'payout', campaign: 12 },
  { at: 205, who: 'Nova', what: 'sealed a bid on #12', tx: 'NOVATX', kind: 'bid', campaign: 12 },
];
const personas = { creators: [{ name: 'Nova', account: `creator-nova.${HUB}` }, { name: 'Quill', account: quill }], holderAgents: [{ name: 'Ada', account: `holder-ada.${HUB}` }] };

function build() {
  return buildActivity({
    hub: HUB, now: 10_000, startup, trades, campaigns: [campaign], council: ['eliocodes.testnet', 'sushiman1.testnet'],
    balances: { 'eliocodes.testnet': '924971395', 'sushiman1.testnet': '556992637', [`fan-05.${HUB}`]: '473125282' },
    proposals: { 12: proposal },
    audit: [{ n: 52, ts_ms: 2_550, startup: 'sushi', campaign: 12, action: 'payout', account: quill, amount: '1', outcome: 'paid', flags: [], note: 'milestone 1: 0.00 tUSD' }],
    wire, relays: [{ tx: 'HUMANBUY', sender: 'sushiman1.testnet', receiver: HUB, at: 3_400 }, { tx: 'HUMANSELL', sender: 'sushiman1.testnet', receiver: `sushi.${HUB}`, at: 4_300 }, { tx: 'VOTETX', sender: 'eliocodes.testnet', receiver: `sushi-dao.${HUB}`, at: 800 }],
    ...personas, seenAt: () => null,
  });
}

describe('activity', () => {
  it('names people, personas and the simulated buyers', () => {
    const x = { hub: HUB, founder: 'eliocodes.testnet', creators: personas.creators, holders: personas.holderAgents };
    expect(nameOf(`fan-05.${HUB}`, x)).toEqual({ name: 'fan-05', tag: 'AI fan' });
    expect(nameOf(quill, x)).toEqual({ name: 'Quill', tag: 'AI creator' });
    expect(nameOf('eliocodes.testnet', x)).toEqual({ name: 'eliocodes', tag: 'founder' });
    expect(nameOf('sushiman1.testnet', x)).toEqual({ name: 'sushiman1', tag: null });
    expect(group('1234567.5')).toBe('1,234,567.5');
  });

  it('tapes trades in plain words with referral, AI tag and transaction links', () => {
    const a = build();
    expect(a.trades.map((t) => t.id)).toEqual(['t3', 't2', 't1', 't0']);
    const [sell, buy, fan, first] = a.trades;
    expect(buy.text).toBe('sushiman1 bought 1,234 SUSHI for 0.1 NEAR');
    expect(buy).toMatchObject({ ref: 12, via: 'Quill', tx: 'HUMANBUY', url: 'https://testnet.nearblocks.io/txns/HUMANBUY' });
    expect(sell).toMatchObject({ side: 'sell', tx: 'HUMANSELL', text: 'sushiman1 sold 1,234 SUSHI for 0.1 NEAR' });
    expect(fan).toMatchObject({ tag: 'AI fan', tx: 'FANTX', attributed: 12 });
    // no known transaction: the link goes to the account
    expect(first).toMatchObject({ tx: null, url: 'https://testnet.nearblocks.io/address/eliocodes.testnet', tag: 'founder' });
  });

  it('lists holders by balance with their share of the supply and the council', () => {
    const h = build().holders;
    expect(h.list.map((r) => [r.name, r.pct, r.council])).toEqual([['eliocodes', 0.0924, true], ['sushiman1', 0.0556, true], ['fan-05', 0.0473, false]]);
    expect(h.minToJoin).toBe('100000000');
  });

  it("tells a campaign's story", () => {
    const a = build();
    const texts = a.events.filter((e) => e.campaign === 12).map((e) => e.text);
    expect(texts).toEqual([
      'Quill was paid for milestone 1 of 3',
      'New buyer via Quill’s link (1/3): fan-05',
      'The holders approved it: Quill starts work',
      'eliocodes voted yes',
      'Quill won',
      'Quill sealed an offer',
      'Nova sealed an offer',
      'eliocodes posted a brief: “Bring 3 new chefs”',
    ]);
    expect(a.events.find((e) => e.kind === 'paid')?.tx).toBe('PAYTX');
    expect(a.events.find((e) => e.id.includes('offer:creator-nova'))?.tx).toBe('NOVATX');
    expect(a.votes).toMatchObject([{ text: 'eliocodes voted yes on #12', tx: 'VOTETX', at: 800 }]);
  });

  it('since= returns only newer items, with overlap', () => {
    const a = sinceFilter(build(), 63_500);
    expect(a.trades.map((t) => t.id)).toEqual(['t3']);
    expect(a.holders.list.length).toBe(3);
  });
});

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('activity service', () => {
  function deps(over: Partial<ActivityDeps> = {}) {
    const reads: Record<string, number> = {};
    const count = (k: string): void => { reads[k] = (reads[k] ?? 0) + 1; };
    let t = 0;
    const d: ActivityDeps = {
      hub: HUB,
      startup: async (id) => { count('startup'); return id === 'sushi' ? startup : null; },
      trades: async () => { count('trades'); return trades; },
      campaigns: async () => { count('campaigns'); return [campaign]; },
      council: async () => { count('council'); return ['eliocodes.testnet']; },
      balance: async () => { count('balance'); return '1000000'; },
      proposal: async () => { count('proposal'); return proposal; },
      snapshotProposal: () => undefined,
      audit: () => [],
      wire: () => wire,
      relays: async () => [],
      ...personas,
      now: () => t,
      ttl: 1500,
      ...over,
    };
    return { d, reads, tick: (ms: number) => { t += ms; } };
  }

  it('many viewers within the ttl cost one set of reads', async () => {
    const { d, reads, tick } = deps();
    const svc = createActivity(d);
    await Promise.all(Array.from({ length: 50 }, () => svc.get('sushi')));
    expect(reads.startup).toBe(1);
    expect(reads.trades).toBe(1);
    const balances = reads.balance;
    tick(2000);
    // past the ttl: the last build at once, one rebuild in the background
    await Promise.all(Array.from({ length: 50 }, () => svc.get('sushi')));
    await flush();
    expect(reads.startup).toBe(2);
    // the council is kept 5 s, balances until trades change, a settled proposal for good
    expect(reads.council).toBe(1);
    expect(reads.balance).toBe(balances);
    expect(reads.proposal).toBe(1);
  });

  it('serves the last good build (stale) when a read fails', async () => {
    let fail = false;
    const { d, tick } = deps({ trades: async () => { if (fail) throw new Error('rate limited'); return trades; } });
    const svc = createActivity(d);
    expect((await svc.get('sushi'))?.stale).toBe(false);
    fail = true;
    tick(2000);
    await svc.get('sushi');
    await flush();
    const a = await svc.get('sushi');
    expect(a?.stale).toBe(true);
    expect(a?.trades.length).toBe(4);
    expect(await svc.get('nope')).toBe(null);
  });

  it('dates a vote that appears later by when it was first seen', async () => {
    let votes: Record<string, string> = { 'eliocodes.testnet': 'Approve' };
    const { d, tick } = deps({ proposal: async () => ({ ...proposal, status: 'InProgress', votes }) });
    const svc = createActivity({ ...d, campaigns: async () => [{ ...campaign, phase: 'voting' }] });
    await svc.get('sushi');
    votes = { ...votes, 'sushiman1.testnet': 'Reject' };
    tick(5000);
    await svc.get('sushi');
    await flush();
    const a = await svc.get('sushi');
    expect(a?.votes.find((v) => v.account === 'sushiman1.testnet')).toMatchObject({ vote: 'no', at: 5000 });
    expect(a?.votes.find((v) => v.account === 'eliocodes.testnet')?.at).toBe(500);
  });
});

describe('llms.txt', () => {
  it('names the hub methods agents call, the fee and the not-equity terms', () => {
    const t = llmsTxt('signalfire.testnet', 'https://example.org');
    for (const m of ['buy_with_wallet', 'join_holders', 'commit_bid', 'reveal_bid', 'act_proposal', 'ft_transfer_call', 'fund_wallet', 'grant-function-call-access', '/api/s/<sym>/activity', '/api/s/<sym>/holders']) expect(t).toContain(m);
    expect(t).toContain('2%');
    expect(t).toContain('not equity');
  });
  it('every hub method it names exists in the contract', () => {
    const src = readFileSync(new URL('../../../contracts/hub/src/lib.rs', import.meta.url), 'utf8');
    const t = llmsTxt('signalfire.testnet', 'https://example.org');
    const named = [...t.matchAll(/^- ([a-z_]+) \{/gm), ...t.matchAll(/(?:, |: )([a-z_]+) \{/g)].map((m) => m[1]).filter((m) => !['act_proposal', 'ft_transfer_call', 'get_proposal'].includes(m));
    expect(named.length).toBeGreaterThan(20);
    for (const m of new Set(named)) expect(src, m).toMatch(new RegExp(`pub fn ${m}\\(`));
  });
});
