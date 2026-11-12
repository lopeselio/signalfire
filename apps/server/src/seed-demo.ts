// Seeds the demo with a few more startups, run by the operator for fictional founders. Idempotent.
//   pnpm seed-demo            # dry run: prints what it would do and what it would cost
//   pnpm seed-demo --go       # does it
// For each startup in personas.ts DEMO_STARTUPS:
// - three holder agents (function-call keys only, +act_proposal on that startup's DAO), paid for by the operator;
// - the launch (`launch_startup`, 1 NEAR from the operator) with those holders as the council;
// - the holders' first tokens, and some trading volume from the operator so the marketing treasury has fees.
// Then the fans' hub wallets get enough NEAR (and a 24-hour cap) for one first buy of each startup.
// Campaigns are not created here: the founder agent in the server's loop posts them, and the creators, holders and
// fans run them like any other.
import { YOCTO, fmtNear, parseNear } from '@signalfire/core';
import { balanceOf, call, callOn, send, view } from './chain.ts';
import { config, explorerTx, hasKey } from './config.ts';
import { ftBalance, getStartup, getWallet } from './hub.ts';
import { DEMO_STARTUPS, FAN_COUNT, fanAccount, holdersOf } from './personas.ts';
import { ensureAgent } from './setup.ts';

const GO = process.argv.includes('--go');
const KEEP = parseNear(process.env.KEEP_SPARE ?? '5');
const FEES_WANTED = parseNear(process.env.SEED_FEES ?? '0.2');
// gas is reserved at a pessimistic price: a 150 Tgas vote needs ~0.15 NEAR on the account
const HOLDER = { balance: '0.2', wallet: '0.06', capTx: '0.05', capDay: '0.06' };
const FAN_BUY = parseNear('0.06');
const FAN_STORAGE = parseNear('0.0015');
const FAN_CAP_DAY = parseNear('0.2');
/** a new fan: a little NEAR on its account for gas, the rest in its capped hub wallet */
const FAN_ACCOUNT = '0.05';
/** pays for the fans (account and wallet top-ups); FUNDER=signalfire-desk.testnet keeps the operator's NEAR for gas */
const FUNDER = process.env.FUNDER ?? config.operator;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const say = (s: string, tx?: string): void => console.log(tx ? `${s}  ${explorerTx(tx)}` : s);

async function main(): Promise<void> {
  const op = config.operator;
  if (!hasKey(op) || !hasKey(config.hub) || !hasKey(FUNDER)) throw new Error(`needs the keys of ${op} (the founder), ${config.hub} (creates agents) and ${FUNDER} (pays for fans)`);
  const start = (await balanceOf(op)) ?? 0n;
  const todo = [];
  for (const d of DEMO_STARTUPS) if (!(await getStartup(d.id))) todo.push(d);
  // a rough upper bound: launch, holders, fees, gas
  const perStartup = YOCTO + 3n * (parseNear(HOLDER.balance) + parseNear(HOLDER.wallet)) + FEES_WANTED + parseNear('0.15');
  const startups = BigInt(DEMO_STARTUPS.length + 1);
  let missing = 0n;
  for (let i = 1; i <= FAN_COUNT; i++) if ((await balanceOf(fanAccount(i))) === null) missing++;
  // new fans in full, plus a top-up allowance for the existing ones
  const fanTopUp = missing * ((FAN_BUY + FAN_STORAGE) * startups + parseNear(FAN_ACCOUNT)) + parseNear('0.3');
  const need = perStartup * BigInt(todo.length) + (FUNDER === op ? fanTopUp : 0n);
  console.log(`operator ${op}: ${fmtNear(start, 3)} NEAR; ${todo.length} startups to launch (${todo.map((d) => d.id).join(', ') || 'none'}); at most ${fmtNear(need, 2)} NEAR; keeps ${fmtNear(KEEP, 0)} spare`);
  if (start - need < KEEP) throw new Error('not enough NEAR on the operator to keep the spare');
  if (FUNDER !== op) {
    const f = (await balanceOf(FUNDER)) ?? 0n;
    console.log(`fans paid by ${FUNDER}: ${fmtNear(f, 3)} NEAR; at most ${fmtNear(fanTopUp, 2)} NEAR`);
    if (f < fanTopUp) throw new Error(`${FUNDER} can't cover the fans`);
  }
  if (!GO) { console.log('dry run: pass --go to do it'); return; }

  for (const d of DEMO_STARTUPS) {
    const dao = `${d.id}-dao.${config.hub}`;
    const holders = holdersOf(d.id);
    // the operator pays for the holder agents: it sends the hub what create_agent attaches
    for (const h of holders) {
      if ((await balanceOf(h.account)) === null) {
        const tx = await send(op, config.hub, parseNear(HOLDER.balance) + parseNear(HOLDER.wallet));
        say(`operator paid the hub for ${h.name}'s account and wallet`, tx);
      }
      await ensureAgent(h.account.split('.')[0], { ...HOLDER, dao });
    }
    let s = await getStartup(d.id);
    if (!s) {
      const r = await call(op, 'launch_startup', { symbol: d.id, name: d.name, pitch: d.pitch, council: holders.map((h) => h.account) }, 300, YOCTO);
      say(`launched ${d.name} (${d.id.toUpperCase()})`, r.tx);
      await sleep(3000);
      s = await getStartup(d.id);
    }
    if (!s || s.status !== 'live') { console.warn(`${d.id} is not live (${s?.status}); skipped`); continue; }
    for (const h of holders) {
      if (BigInt(await ftBalance(s.token, h.account)) >= BigInt(s.constraints.min_holder_tokens)) continue;
      const r = await call(h.account, 'buy_with_wallet', { startup: s.id, amount: parseNear('0.045').toString(), min_tokens_out: '0', ref_code: null }, 60);
      say(`${h.name} bought ${d.id.toUpperCase()} from its wallet`, r.tx);
      await sleep(1200);
    }
    // trading volume in steps: a few buys up the curve, then sells back down; the 2% fees fill the treasury
    for (let round = 0; BigInt(s.fees_in) < FEES_WANTED && round < 6; round++) {
      for (const amt of ['0.35', '0.6', '0.25', '0.5']) {
        const r = await call(op, 'buy', { startup: s.id, min_tokens_out: '0', ref_code: null }, 100, parseNear(amt));
        say(`operator bought ${amt} NEAR of ${d.id.toUpperCase()}`, r.tx);
        await sleep(1200);
      }
      const bal = BigInt(await ftBalance(s.token, op));
      const parts = [bal / 3n, bal / 4n, bal - bal / 3n - bal / 4n];
      for (const part of parts) {
        if (part <= 0n) continue;
        const r = await callOn(op, s.token, 'ft_transfer_call', { receiver_id: config.hub, amount: part.toString(), msg: JSON.stringify({ min_near_out: '0' }) }, 100, 1n);
        say(`operator sold ${d.id.toUpperCase()} back`, r.tx);
        await sleep(1200);
      }
      s = (await getStartup(d.id))!;
    }
    console.log(`${d.name}: fees in ${fmtNear(s.fees_in, 4)} NEAR, treasury free ${fmtNear(s.available, 4)} NEAR`);
  }

  // the fans: open the missing ones, then enough in each hub wallet for one first buy of every startup it hasn't
  // bought yet, under a 24-hour cap that allows a few buys a day
  const ids = ['glow', ...DEMO_STARTUPS.map((d) => d.id)];
  for (let i = 1; i <= FAN_COUNT; i++) {
    const f = fanAccount(i);
    if ((await balanceOf(f)) === null) {
      const wallet = (FAN_BUY + FAN_STORAGE) * BigInt(ids.length);
      const tx = await send(FUNDER, config.hub, parseNear(FAN_ACCOUNT) + wallet);
      say(`${FUNDER} paid the hub for ${f.split('.')[0]}'s account and wallet`, tx);
      await ensureAgent(f.split('.')[0], { balance: FAN_ACCOUNT, wallet: fmtNear(wallet, 6), capTx: '0.07', capDay: fmtNear(FAN_CAP_DAY, 2) });
    }
    const w = await getWallet(f);
    if (!w) continue;
    let firsts = 0n;
    for (const id of ids) if (!(await view<boolean>('is_buyer', { startup: id, account: f }).catch(() => false))) firsts++;
    const want = firsts * (FAN_BUY + FAN_STORAGE);
    const have = BigInt(w.balance);
    if (have < want) {
      const r = await call(FUNDER, 'fund_wallet', { account: f }, 30, want - have);
      say(`${FUNDER} added ${fmtNear(want - have, 3)} NEAR to ${f.split('.')[0]}'s wallet`, r.tx);
    }
    if (BigInt(w.cap_day) < FAN_CAP_DAY) {
      const r = await call(config.hub, 'set_wallet_caps', { account: f, cap_tx: w.cap_tx, cap_day: FAN_CAP_DAY.toString() }, 30);
      say(`${f.split('.')[0]}: 24-hour cap ${fmtNear(FAN_CAP_DAY, 2)} NEAR`, r.tx);
    }
  }
  const end = (await balanceOf(op)) ?? 0n;
  console.log(`done. operator ${fmtNear(end, 3)} NEAR (spent ${fmtNear(start - end, 3)})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
