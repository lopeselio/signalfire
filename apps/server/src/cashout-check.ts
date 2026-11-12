// The web app's "Cash out through NEAR Intents" flow, run from a terminal with a test account's own key, so it can be
// checked end to end without a browser wallet (the calls and the signed message are the same):
//   pnpm cashout-check <account> [tUSD raw, default: all]
// <account> holds tUSD and has its full-access key in ~/.near-credentials (for example a person-creator test account).
import { randomBytes } from 'node:crypto';
import { cashOutIntents, fmtNear, fmtTusd, intentsMessage, intentsNonce, nearForTusd, b64encode } from '@signalfire/core';
import { parseKey } from 'near-kit';
import { callOn, viewOn, balanceOf } from './chain.ts';
import { explorerTx, privateKey } from './config.ts';
import { cashOutInfo, settleCashOut, WNEAR } from './cashout.ts';
import { tusdId } from './hub.ts';

const [who, amountArg] = process.argv.slice(2);
if (!who) { console.error('usage: pnpm cashout-check <account> [tUSD raw]'); process.exit(2); }
const log = (s: string, tx?: string): void => console.log(tx ? `${s}\n    ${explorerTx(tx)}` : s);
const key = parseKey(privateKey(who));
const publicKey = key.publicKey.toString();
const info = await cashOutInfo(who, publicKey);
log(`Verifier ${info.verifier}, desk ${info.desk}, rate 1 NEAR = ${info.tusdPerNear} tUSD`);
const held = BigInt(await viewOn<string>(tusdId(), 'ft_balance_of', { account_id: who }));
const amount = amountArg ? BigInt(amountArg) : held + BigInt(info.deposited);
if (amount <= 0n) throw new Error(`${who} has no tUSD`);
log(`${who}: ${fmtTusd(held, 6)} tUSD in the wallet, ${fmtTusd(info.deposited, 6)} already in the Verifier; cashing out ${fmtTusd(amount, 6)} tUSD for ${fmtNear(nearForTusd(amount), 6)} NEAR`);

// 1. deposit (what the web app asks the wallet to sign first)
const need = amount - BigInt(info.deposited);
if (need > 0n) {
  const d = await callOn(who, tusdId(), 'ft_transfer_call', { receiver_id: info.verifier, amount: need.toString(), msg: who }, 100, 1n);
  log(`deposited ${fmtTusd(need, 6)} tUSD into the Verifier for ${who}`, d.tx);
}
// 2. register the key once
if (!info.keyRegistered) {
  const k = await callOn(who, info.verifier, 'add_public_key', { public_key: publicKey }, 30, 1n);
  log(`registered ${publicKey.slice(0, 18)}… with the Verifier`, k.tx);
}
// 3. sign the intent (the web app: wallet.signMessage with the same message, recipient and nonce)
const salt = await viewOn<string>(info.verifier, 'current_salt', {});
const deadline = Date.now() + 5 * 60_000;
const message = intentsMessage(who, deadline, cashOutIntents({ tusd: tusdId(), wnear: WNEAR, amount, receiver: who }));
const nonce = intentsNonce(salt, deadline, randomBytes(15));
const s = key.signNep413Message!(who, { message, recipient: info.verifier, nonce: Buffer.from(nonce) });
log(`signed the cash-out intent (NEP-413, salt ${salt})`);
// 4. the server's part
const before = (await balanceOf(who)) ?? 0n;
const r = await settleCashOut(who, { amount: amount.toString(), message, nonce: b64encode(nonce), recipient: info.verifier, publicKey: s.publicKey, signature: s.signature });
log(`the Verifier settled the cash-out: execute_intents`, r.tx);
const after = (await balanceOf(who)) ?? 0n;
log(`${who}'s NEAR: ${fmtNear(before, 6)} → ${fmtNear(after, 6)} (+${fmtNear(BigInt(r.near), 6)} NEAR from the desk, less gas)`);
process.exit(0);
