// A creator cashes out tUSD earnings for NEAR through NEAR Intents:
//   pnpm intents-swap <account> [tUSD raw units, default: all of it]
// <account> holds tUSD (milestone payouts) and has its full-access key in ~/.near-credentials. The desk
// (signalfire-desk.testnet) is the counterparty and quotes the hub's fixed test rate (1 NEAR = 3 tUSD, packages/core nearForTusd).
// 1. both sides deposit into the Verifier, each to its own identity (the implicit account of its key):
//    the creator its tUSD, the desk wrapped NEAR (wrap.testnet)
// 2. each signs one token_diff (creator: −tUSD +wNEAR; desk: +tUSD −wNEAR) and an ft_withdraw of what it gets
// 3. the desk sends both signed intents in one execute_intents: the Verifier checks the signatures and that the
//    diffs cancel, swaps, and pays each side out; then the creator unwraps the wNEAR.
// No Signalfire treasury money is involved: this is the creator's own tUSD and the desk's own NEAR.
import { randomBytes } from 'node:crypto';
import { fmtNear, fmtTusd, nearForTusd } from '@signalfire/core';
import { callOn, viewOn } from './chain.ts';
import { config, explorerTx, privateKey } from './config.ts';
import { tusdId } from './hub.ts';
import { VERIFIER, balanced, ft, implicitOf, signIntents, swapSide, type SignedIntent } from './intents.ts';
import { parseKey } from 'near-kit';

const WRAP = process.env.WRAP_ID ?? 'wrap.testnet';
const STORAGE = 1_250_000_000_000_000_000_000n;
const [who, amountArg] = process.argv.slice(2);
if (!who) { console.error('usage: pnpm intents-swap <account> [tUSD raw]'); process.exit(2); }
const desk = config.desk;
const TUSD = tusdId();
const t0 = Date.now();
const log = (s: string, tx?: string): void => console.log(`[${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s] ${s}${tx ? `\n        ${explorerTx(tx)}` : ''}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const identity = (signer: string): string => implicitOf(parseKey(privateKey(signer)).publicKey.toString());
const inVerifier = (id: string, token: string): Promise<bigint> => viewOn<string>(VERIFIER, 'mt_balance_of', { account_id: id, token_id: ft(token) }).then(BigInt).catch(() => 0n);

async function register(token: string, account: string, payer: string): Promise<void> {
  const s = await viewOn<unknown>(token, 'storage_balance_of', { account_id: account }).catch(() => null);
  if (s) return;
  const r = await callOn(payer, token, 'storage_deposit', { account_id: account, registration_only: true }, 30, STORAGE);
  log(`registered ${account} on ${token}`, r.tx);
}

const balance = BigInt(await viewOn<string>(TUSD, 'ft_balance_of', { account_id: who }));
const amount = amountArg ? BigInt(amountArg) : balance;
if (amount <= 0n || amount > balance) throw new Error(`${who} holds ${fmtTusd(balance)} tUSD; can't swap ${amountArg ?? 'that'}`);
const yocto = nearForTusd(amount);
const idWho = identity(who);
const idDesk = identity(desk);
log(`${who} swaps ${fmtTusd(amount, 6)} tUSD for ${fmtNear(yocto, 6)} NEAR with the desk (${desk}) through ${VERIFIER}`);
log(`identities in the Verifier: creator ${idWho.slice(0, 12)}…, desk ${idDesk.slice(0, 12)}…`);

// 0. storage: the Verifier on both tokens, each side on the token it receives
await register(TUSD, VERIFIER, desk);
await register(WRAP, VERIFIER, desk);
await register(TUSD, desk, desk);
await register(WRAP, desk, desk);
await register(WRAP, who, who);

// 1. deposits, each to its own identity (msg = the receiver inside the Verifier)
if ((await inVerifier(idDesk, WRAP)) < yocto) {
  const w = await callOn(desk, WRAP, 'near_deposit', {}, 30, yocto);
  log(`desk wrapped ${fmtNear(yocto, 6)} NEAR`, w.tx);
  const d = await callOn(desk, WRAP, 'ft_transfer_call', { receiver_id: VERIFIER, amount: yocto.toString(), msg: idDesk }, 100, 1n);
  log('desk deposited the wNEAR into the Verifier', d.tx);
}
if ((await inVerifier(idWho, TUSD)) < amount) {
  const d = await callOn(who, TUSD, 'ft_transfer_call', { receiver_id: VERIFIER, amount: amount.toString(), msg: idWho }, 100, 1n);
  log(`${who} deposited ${fmtTusd(amount, 6)} tUSD into the Verifier`, d.tx);
}
for (let k = 0; k < 10 && ((await inVerifier(idWho, TUSD)) < amount || (await inVerifier(idDesk, WRAP)) < yocto); k++) await sleep(2000);
log(`in the Verifier: creator ${await inVerifier(idWho, TUSD)} raw tUSD, desk ${fmtNear(await inVerifier(idDesk, WRAP), 6)} wNEAR`);

// 2. the two signed intents
const creatorSide = swapSide({ token: TUSD, amount }, { token: WRAP, amount: yocto }, who, 'Signalfire: tUSD earnings to NEAR');
const deskSide = swapSide({ token: WRAP, amount: yocto }, { token: TUSD, amount }, desk, 'Signalfire desk: buys tUSD at 1 NEAR = 3 tUSD');
if (!balanced([creatorSide, deskSide])) throw new Error('the two sides do not cancel');
const salt = await viewOn<string>(VERIFIER, 'current_salt', {});
const signed: SignedIntent[] = [
  signIntents({ privateKey: privateKey(who), saltHex: salt, intents: creatorSide, nowMs: Date.now(), random: randomBytes(15) }),
  signIntents({ privateKey: privateKey(desk), saltHex: salt, intents: deskSide, nowMs: Date.now(), random: randomBytes(15) }),
];
log(`both sides signed (NEP-413, salt ${salt}); simulating`);
await viewOn(VERIFIER, 'simulate_intents', { signed });

// 3. settle
const x = await callOn(desk, VERIFIER, 'execute_intents', { signed }, 300);
log('the Verifier settled the swap: execute_intents', x.tx);
let wnear = 0n;
for (let k = 0; k < 10; k++) { wnear = BigInt(await viewOn<string>(WRAP, 'ft_balance_of', { account_id: who })); if (wnear >= yocto) break; await sleep(2000); }
log(`${who} now holds ${fmtNear(wnear, 6)} wNEAR; unwrapping`);
const u = await callOn(who, WRAP, 'near_withdraw', { amount: yocto.toString() }, 30, 1n);
log(`${who} unwrapped ${fmtNear(yocto, 6)} NEAR`, u.tx);
log(`desk now holds ${await viewOn<string>(TUSD, 'ft_balance_of', { account_id: desk })} raw tUSD`);
process.exit(0);
