// The whole loop on testnet, in one process, with no server needed:
//   pnpm e2e [budgetNEAR]          a new campaign
//   pnpm e2e --campaign <id>        carry an existing campaign to the end
// 1. the demo startup has fees in its marketing treasury (the operator trades to add some if not)
// 2. the scout vets any creator still waiting
// 3. the founder posts a brief; three AI creator agents seal bids with NEAR AI pitches, then reveal
// 4. the hub settles the auction and files a FunctionCall proposal in the startup's Sputnik DAO
// 5. the holder agents vote; the DAO calls fund_campaign
// 6. the audience buys through the winner's referral code; each milestone pays tUSD through the spend policy
// 7. the receipt NFT is minted; then `verify` re-checks the campaign against the chain
import { fmtNear, fmtTusd, parseNear } from '@signalfire/core';
import { tick } from './agents.ts';
import { call, callOn } from './chain.ts';
import { config, explorerTx } from './config.ts';
import { ftBalance, getCampaign, getStartup } from './hub.ts';
import { CREATORS } from './personas.ts';
import { buildProof } from './proof.ts';
import { invalidate, snapshot } from './snapshot.ts';
import { getWire } from './store.ts';
import { verifyCampaign } from './verify.ts';

const resumeAt = process.argv.indexOf('--campaign');
const resume = resumeAt > 0 ? Number(process.argv[resumeAt + 1]) : null;
const budget = parseNear(resume === null ? process.argv[2] ?? '0.15' : '0');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const stamp = (): string => `[${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s]`;
let seen = getWire().length ? getWire()[0].at : 0;
function printWire(): void {
  const fresh = getWire().filter((w) => w.at > seen).reverse();
  for (const w of fresh) console.log(`${stamp()} ${w.who}: ${w.what}${w.tx ? `\n         ${explorerTx(w.tx)}` : ''}`);
  if (fresh.length) seen = fresh[fresh.length - 1].at;
}

let s = await getStartup(config.demo);
if (!s || s.status !== 'live') throw new Error(`startup ${config.demo} is not live: run pnpm setup`);
console.log(`${stamp()} ${s.name} (${s.id.toUpperCase()}): treasury ${fmtNear(s.available)} NEAR free, ${fmtNear(s.fees_in)} NEAR of fees in so far`);

// 1. enough in the treasury
while (BigInt(s.available) < budget) {
  console.log(`${stamp()} the treasury is short of ${fmtNear(budget)} NEAR: the operator trades (2% of each trade goes to the treasury)`);
  const b = await call(config.operator, 'buy', { startup: s.id, min_tokens_out: '0', ref_code: null }, 100, parseNear('3'));
  console.log(`         buy  ${explorerTx(b.tx)}`);
  await sleep(1500);
  const bal = await ftBalance(s.token, config.operator);
  const r = await callOn(config.operator, s.token, 'ft_transfer_call', { receiver_id: config.hub, amount: bal, msg: JSON.stringify({ min_near_out: '0' }) }, 100, 1n);
  console.log(`         sell ${explorerTx(r.tx)}`);
  await sleep(1500);
  s = (await getStartup(config.demo))!;
}

// 2. creators admitted
for (let i = 0; i < 6; i++) {
  invalidate();
  const snap = await snapshot();
  if (CREATORS.every((c) => snap.creators.some((x) => x.creator.account === c.account))) break;
  await tick({ autoBriefs: false });
  printWire();
}

// 3. the brief
const brief = resume !== null ? { value: resume, tx: '' } : await call<number>(config.operator, 'create_campaign', {
  startup: s.id, title: `E2E ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
  brief: 'Bring three students who have never held GLOW to buy a little through your link.',
  target: 3, budget: budget.toString(), commit_secs: 45, reveal_secs: 45, duration_secs: 1800,
}, 30);
const id = brief.value;
if (resume === null) console.log(`${stamp()} founder posted campaign #${id}: ${fmtNear(budget)} NEAR budget, 3 new holders wanted\n         ${explorerTx(brief.tx)}`);
else console.log(`${stamp()} carrying campaign #${id} to the end`);

// 4-7. the agents do the rest
const deadline = Date.now() + 15 * 60_000;
let phase = '';
while (Date.now() < deadline) {
  await tick({ autoBriefs: false, only: id });
  printWire();
  const c = await getCampaign(id);
  if (c && c.phase !== phase) {
    phase = c.phase;
    console.log(`${stamp()} campaign #${id} is now ${phase}${c.winner ? ` (winner ${c.winner} at ${fmtNear(c.price)} NEAR)` : ''}`);
  }
  if (!c || ['done', 'expired', 'no_bids'].includes(c.phase)) break;
  await sleep(5000);
}

const c = (await getCampaign(id))!;
s = (await getStartup(config.demo))!;
console.log(`\n${stamp()} campaign #${id}: ${c.phase}; ${c.results}/${c.target} results; ${c.milestones_paid} milestones; ${fmtNear(c.paid)} NEAR paid as ${fmtTusd(c.paid_tusd)} tUSD to ${c.winner}`);
if (c.receipt) console.log(`         receipt NFT ${c.receipt} on ${config.hub}`);
console.log(`         treasury now ${fmtNear(s.available)} NEAR free, ${fmtNear(s.committed)} committed, ${fmtNear(s.paid)} paid out\n`);

const bundle = await buildProof(id);
if (!bundle) throw new Error('no proof bundle');
console.log('verify (reads the chain over public RPC):');
const rep = await verifyCampaign(id, bundle, (line) => console.log(`  ${line}`));
process.exit(c.phase === 'done' && rep.failed === 0 ? 0 : 1);
