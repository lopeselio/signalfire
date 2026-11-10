// One-time testnet setup. Idempotent: re-running skips what exists.
//   pnpm setup
// - tUSD (`tusd.<hub>`), the labelled test stablecoin, and the scout's registration.
// - The demo startup (GLOW), launched by the operator as founder, with the three holder agents as its council.
// - The agents, created by the hub with function-call keys only (keys saved to ~/.near-credentials/<network>):
//   three creators, the scout, three holders (a second FC key: act_proposal on the GLOW DAO), twelve fans.
// - The creators apply (vetting fee from their wallets); the holders buy their first GLOW.
// - Some trading volume from the operator, so the marketing treasury has fees in it.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { KeyPair } from 'near-api-js';
import { YOCTO, fmtNear, parseNear } from '@signalfire/core';
import { balanceOf, call, callOn, send, view } from './chain.ts';
import { config, explorerTx, hasKey } from './config.ts';
import { getConfig, getStartup, getWallet, ftBalance } from './hub.ts';
import { CREATORS, FAN_COUNT, HOLDERS, SCOUT, fanAccount } from './personas.ts';

const OWNER = config.hub;
const credDir = join(homedir(), '.near-credentials', config.network);
mkdirSync(credDir, { recursive: true });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const say = (s: string, tx?: string): void => console.log(tx ? `${s}  ${explorerTx(tx)}` : s);

function newKey(file: string, account: string): string {
  if (existsSync(file)) throw new Error(`${file} exists but ${account} doesn't; move the old key away first`);
  const kp = KeyPair.fromRandom('ed25519');
  writeFileSync(file, JSON.stringify({ account_id: account, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
  return kp.getPublicKey().toString();
}

/** Creates an agent through the hub (FC keys only) unless it exists. */
export async function ensureAgent(name: string, o: { balance: string; wallet: string; capTx: string; capDay: string; dao?: string }): Promise<string> {
  const acct = `${name}.${config.hub}`;
  const have = await balanceOf(acct);
  if (have !== null) {
    // gas is reserved at a pessimistic price, so an agent needs some native balance: top it up
    const want = parseNear(o.balance);
    if (have < want - want / 10n) {
      const tx = await send(config.operator, acct, want - have);
      say(`topped up ${acct} to ${o.balance} NEAR`, tx);
    }
    return acct;
  }
  const hubKey = newKey(join(credDir, `${acct}.json`), acct);
  const daoKey = o.dao ? newKey(join(credDir, `${acct}.dao.json`), acct) : null;
  const deposit = parseNear(o.balance) + parseNear(o.wallet);
  const r = await call(OWNER, 'create_agent', {
    name, hub_key: hubKey, dao: o.dao ?? null, dao_key: daoKey, account_balance: parseNear(o.balance).toString(),
    cap_tx: parseNear(o.capTx).toString(), cap_day: parseNear(o.capDay).toString(),
  }, 60, deposit);
  say(`created ${acct} (function-call keys only${o.dao ? ', +act_proposal on ' + o.dao : ''})`, r.tx);
  await sleep(1200);
  return acct;
}

async function main(): Promise<void> {
  console.log(`hub ${config.hub}, owner balance ${fmtNear((await balanceOf(OWNER)) ?? 0n)} NEAR, operator ${fmtNear((await balanceOf(config.operator)) ?? 0n)} NEAR`);

  // tUSD
  let hc = await getConfig();
  const tusd = `tusd.${config.hub}`;
  if ((await balanceOf(tusd)) === null) {
    const r = await call(OWNER, 'create_tusd', {}, 100, parseNear('0.05'));
    say(`created ${tusd} (test stablecoin, supply to the hub's payout desk)`, r.tx);
  } else say(`${tusd} exists`);
  if (!hc.scouts.includes(SCOUT.account)) {
    const r = await call(OWNER, 'add_scout', { scout: SCOUT.account }, 30);
    say(`registered scout ${SCOUT.account}`, r.tx);
  }

  // the demo startup
  let s = await getStartup(config.demo);
  if (!s) {
    const r = await call(config.operator, 'launch_startup', {
      symbol: config.demo, name: 'Glowpath',
      pitch: 'Glowpath maps quiet late-night study spots for students. Its attention token funds campaigns that bring new students in.',
      council: HOLDERS.map((h) => h.account),
    }, 300, YOCTO);
    say(`launched ${config.demo}`, r.tx);
    s = await getStartup(config.demo);
  } else say(`startup ${config.demo} exists (${s.status})`);
  if (!s || s.status !== 'live') throw new Error('the demo startup is not live');

  // agents
  for (const c of CREATORS) await ensureAgent(c.account.split('.')[0], { balance: '0.25', wallet: '0.25', capTx: '0.05', capDay: '0.2' });
  await ensureAgent(SCOUT.account.split('.')[0], { balance: '0.25', wallet: '0.01', capTx: '0.02', capDay: '0.05' });
  for (const h of HOLDERS) await ensureAgent(h.account.split('.')[0], { balance: '0.3', wallet: '0.4', capTx: '0.2', capDay: '0.5', dao: s.dao });
  for (let i = 1; i <= FAN_COUNT; i++) await ensureAgent(fanAccount(i).split('.')[0], { balance: '0.09', wallet: '0.08', capTx: '0.07', capDay: '0.08' });

  // creators apply (the scout vets them in the agent loop)
  for (const c of CREATORS) {
    const admitted = await view('get_creator', { account: c.account });
    const applied = await view('get_application', { account: c.account });
    if (admitted || applied) continue;
    if (!hasKey(c.account)) { say(`no key for ${c.account}; skipped`); continue; }
    const r = await call(c.account, 'apply_creator', { name: c.name, profile: c.profile }, 20);
    say(`${c.name} applied as a creator (0.01 NEAR vetting fee in escrow)`, r.tx);
  }

  // holders buy their first GLOW
  for (const h of HOLDERS) {
    const bal = BigInt(await ftBalance(s.token, h.account));
    if (bal >= BigInt(s.constraints.min_holder_tokens)) continue;
    const r = await call(h.account, 'buy_with_wallet', { startup: s.id, amount: parseNear('0.15').toString(), min_tokens_out: '0', ref_code: null }, 60);
    say(`${h.name} bought GLOW from its wallet`, r.tx);
  }

  // trading volume: the operator buys and sells back, and the 2% fees fill the marketing treasury
  s = (await getStartup(config.demo))!;
  const want = parseNear(process.env.SEED_TREASURY ?? '0.3');
  for (let round = 0; BigInt(s.available) < want && round < 6; round++) {
    const r = await call(config.operator, 'buy', { startup: s.id, min_tokens_out: '0', ref_code: null }, 100, parseNear('3'));
    say(`operator bought GLOW with 3 NEAR`, r.tx);
    await sleep(1500);
    const bal = await ftBalance(s.token, config.operator);
    const r2 = await callOn(config.operator, s.token, 'ft_transfer_call', { receiver_id: config.hub, amount: bal, msg: JSON.stringify({ min_near_out: '0' }) }, 100, 1n);
    say(`operator sold it back`, r2.tx);
    await sleep(1500);
    s = (await getStartup(config.demo))!;
  }
  hc = await getConfig();
  console.log(`\n${s.name}: treasury ${fmtNear(s.available)} NEAR free, fees in ${fmtNear(s.fees_in)} NEAR; ${hc.creators} creators admitted`);
  for (const c of CREATORS) {
    const w = await getWallet(c.account);
    console.log(`  ${c.name}: wallet ${w ? fmtNear(w.balance) : '-'} NEAR`);
  }
  console.log('done');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
