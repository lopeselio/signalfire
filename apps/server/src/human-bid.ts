// A person's sealed bid, end to end on testnet, with the same calls the web app's "Your sealed bid" panel makes:
//   pnpm human-bid <account> [baseUrl]        e.g. pnpm human-bid sf-bidder.signalfire-ref.testnet https://signalfire.lopeselio.online
// <account> is an ordinary account with a full-access key in ~/.near-credentials (not a hub-made agent).
// 1. it funds its Signalfire wallet and applies; the scout (its key, run here) vets it if needed
// 2. the founder (operator) posts a brief; the person seals price + pitch with sealBid() and a random salt,
//    keeps the opening, and sends only the hash (commit_bid)
// 3. in the reveal window it reveals (reveal_bid) and posts the opening to <baseUrl>/api/opening
// 4. it waits for the settle (the server's agent loop, or it cranks settle_auction itself) and prints the result.
// Then: pnpm verify <campaign> <baseUrl>.
import { randomBytes } from 'node:crypto';
import { BID_BOND, VET_FEE, fmtNear, parseNear, sealBid } from '@signalfire/core';
import { vet } from './agents.ts';
import { call, view } from './chain.ts';
import { config, explorerTx, hasKey } from './config.ts';
import { getCampaign, getStartup, getWallet } from './hub.ts';
import { invalidate, snapshot } from './snapshot.ts';
import { SCOUT } from './personas.ts';
import { pendingApplicants, setPendingApplicants } from './store.ts';

const [who, base = 'http://localhost:8861'] = process.argv.slice(2);
if (!who) { console.error('usage: pnpm human-bid <account> [baseUrl]'); process.exit(2); }
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (s: string, tx?: string): void => console.log(`[${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s] ${s}${tx ? `\n        ${explorerTx(tx)}` : ''}`);
const budget = parseNear(process.env.BUDGET ?? '0.06');

// 1. a wallet and admission
const isCreator = async (): Promise<boolean> => !!(await view<unknown>('get_creator', { account: who }).catch(() => null));
if (!(await isCreator())) {
  const w = await getWallet(who);
  const app = await view<unknown>('get_application', { account: who }).catch(() => null);
  if (!app) {
    if (!w || BigInt(w.balance) < VET_FEE + BID_BOND) {
      const r = await call(who, 'fund_wallet', { account: who }, 30, VET_FEE + BID_BOND);
      log(`${who}: funded the Signalfire wallet with ${fmtNear(VET_FEE + BID_BOND)} NEAR`, r.tx);
    }
    const r = await call(who, 'apply_creator', { name: 'Pat (a person)', profile: 'Posts study-spot reviews on campus boards and a small Discord; writes every pitch by hand.' }, 30);
    log(`${who}: applied as a creator (0.01 NEAR vetting fee in escrow)`, r.tx);
  }
  if (!hasKey(SCOUT.account)) throw new Error('waiting for the scout: no scout key here');
  setPendingApplicants([...pendingApplicants(), who]); // the scout's queue, as /api/applied does for a signed-in person
  invalidate();
  await vet(await snapshot(), who);
  if (!(await isCreator())) throw new Error(`${who} was not admitted`);
  log(`${who}: admitted by rule after the scout's report`);
}
const w = await getWallet(who);
if (!w || BigInt(w.balance) < BID_BOND) {
  const r = await call(who, 'fund_wallet', { account: who }, 30, BID_BOND);
  log(`${who}: topped the wallet up for the bond`, r.tx);
}

// 2. a brief from the founder, then the sealed bid
const st = (await getStartup(config.demo))!;
const brief = await call<number>(config.operator, 'create_campaign', {
  startup: st.id, title: 'A person bids', brief: 'Bring one student who has never held GLOW to buy a little through your link.',
  target: 1, budget: budget.toString(), commit_secs: 120, reveal_secs: 90, duration_secs: 1800,
}, 30);
const id = brief.value;
log(`founder posted campaign #${id}: ${fmtNear(budget)} NEAR for 1 new holder`, brief.tx);
const price = (budget * BigInt(st.constraints.min_bid_bps + 500)) / 10_000n;
const opening = sealBid(id, who, price, 'Pat will post a hand-written review of the best late-night study spot on three campus boards, with the link.', randomBytes(32).toString('hex'));
const commit = await call(who, 'commit_bid', { campaign_id: id, hash: opening.hash }, 30);
log(`${who}: sealed a bid (hash ${opening.hash.slice(0, 16)}…; price and pitch kept locally)`, commit.tx);

// 3. the reveal
let c = (await getCampaign(id))!;
while (Date.now() < c.commit_ends_ms + 4000) await sleep(2000);
const rev = await call(who, 'reveal_bid', { campaign_id: id, price: opening.price, pitch_hash: opening.pitchHash, salt: opening.salt }, 30);
log(`${who}: revealed ${fmtNear(price)} NEAR`, rev.tx);
for (let k = 0; k < 6; k++) {
  const res = await fetch(`${base}/api/opening`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ campaign: id, creator: who, price: opening.price, pitch: opening.pitch, salt: opening.salt }) });
  if (res.ok) { log(`published the opening to ${base}: ${JSON.stringify(await res.json())}`); break; }
  log(`opening not accepted yet (${res.status}: ${(await res.json() as { error?: string }).error}); retrying`);
  await sleep(3000);
}

// 4. the settle and the result
c = (await getCampaign(id))!;
while (Date.now() < c.reveal_ends_ms + 60_000 && (await getCampaign(id))!.phase === 'bidding') await sleep(5000);
if ((await getCampaign(id))!.phase === 'bidding') {
  const r = await call(who, 'settle_auction', { campaign_id: id }, 100);
  log(`${who}: settled the auction (anyone may)`, r.tx);
}
for (let k = 0; k < 60; k++) {
  c = (await getCampaign(id))!;
  if (['done', 'expired', 'no_bids'].includes(c.phase) || (c.winner !== who && c.phase !== 'bidding' && c.phase !== 'proposing')) break;
  await sleep(10_000);
}
log(`campaign #${id}: ${c.phase}; bids ${c.bids.map((b) => `${b.creator.split('.')[0]} ${b.revealed ? fmtNear(b.price!) : 'unrevealed'}`).join(', ')}`);
log(c.winner === who ? `${who} WON at ${fmtNear(c.price)} NEAR; paid ${fmtNear(c.paid)} NEAR as ${c.paid_tusd} raw tUSD so far` : `${who} lost to ${c.winner ?? 'nobody'} at ${fmtNear(c.price)} NEAR; the bond is back in the wallet`);
console.log(`\nnow: pnpm verify ${id} ${base}`);
process.exit(0);
