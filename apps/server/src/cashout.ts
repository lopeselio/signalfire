import { randomBytes } from 'node:crypto';
import { b58encode, b64decode, checkCashOut, deskIntents, diffsBalance, fmtNear, ftId, nearForTusd, cashOutIntents } from '@signalfire/core';
import { parseKey } from 'near-kit';
import { callOn, viewOn } from './chain.ts';
import { config, hasKey, privateKey } from './config.ts';
import { tusdId } from './hub.ts';
import { VERIFIER, implicitOf, signIntents, type SignedIntent } from './intents.ts';
import { addWire } from './store.ts';

// A signed-in creator cashes tUSD out for NEAR through the Intents Verifier, from the web app:
//   1. (wallet) deposit tUSD into the Verifier for their own account (ft_transfer_call, msg = their account)
//   2. (wallet) register the wallet's key with the Verifier once (add_public_key)
//   3. (wallet) sign the cash-out intent (NEP-413): −tUSD +wNEAR, then native_withdraw the NEAR to themselves
//   4. (here) the desk checks the signed message is exactly that, signs its side, and the Verifier settles both
// The desk only ever signs "+tUSD −wNEAR" for an amount the creator already deposited; nothing here can move the
// creator's tokens: only the creator's own signature can.

export const WNEAR = process.env.WRAP_ID ?? 'wrap.testnet';
const STORAGE = 1_250_000_000_000_000_000_000n;
const DESK_FLOAT = 500_000_000_000_000_000_000_000n; // keep at least 0.5 wNEAR in the Verifier for the next cash-outs

export const deskIdentity = (): string => implicitOf(parseKey(privateKey(config.desk)).publicKey.toString());
const inVerifier = (id: string, token: string): Promise<bigint> =>
  viewOn<string>(VERIFIER, 'mt_balance_of', { account_id: id, token_id: ftId(token) }).then(BigInt).catch(() => 0n);

export interface CashOutInfo { enabled: boolean; verifier: string; tusd: string; wnear: string; desk: string; tusdPerNear: number; salt: string | null; deposited: string; keyRegistered: boolean | null }

let ready = false;
/** The Verifier holds storage on tUSD and wNEAR, so deposits of either can land (paid once, by the desk). */
async function verifierReady(): Promise<void> {
  if (ready || !hasKey(config.desk)) return;
  await registered(tusdId(), VERIFIER);
  await registered(WNEAR, VERIFIER);
  ready = true;
}

export async function cashOutInfo(account: string | null, publicKey: string | null): Promise<CashOutInfo> {
  const enabled = hasKey(config.desk);
  await verifierReady().catch((e: Error) => console.warn(`intents: storage registration failed: ${e.message}`));
  const salt = await viewOn<string>(VERIFIER, 'current_salt', {}).catch(() => null);
  const deposited = account ? (await inVerifier(account, tusdId())).toString() : '0';
  const keyRegistered = account && publicKey ? await viewOn<boolean>(VERIFIER, 'has_public_key', { account_id: account, public_key: publicKey }).catch(() => null) : null;
  return { enabled, verifier: VERIFIER, tusd: tusdId(), wnear: WNEAR, desk: config.desk, tusdPerNear: 3, salt, deposited, keyRegistered };
}

async function registered(token: string, account: string): Promise<void> {
  const s = await viewOn<unknown>(token, 'storage_balance_of', { account_id: account }).catch(() => null);
  if (!s) await callOn(config.desk, token, 'storage_deposit', { account_id: account, registration_only: true }, 30, STORAGE);
}

/** The desk's wNEAR in the Verifier covers `need`, topping up (wrap + deposit) when it doesn't. */
async function deskFloat(need: bigint): Promise<void> {
  const id = deskIdentity();
  const have = await inVerifier(id, WNEAR);
  if (have >= need) return;
  const add = need - have + DESK_FLOAT;
  await registered(WNEAR, config.desk);
  await registered(WNEAR, VERIFIER);
  await registered(tusdId(), VERIFIER);
  await callOn(config.desk, WNEAR, 'near_deposit', {}, 30, add);
  await callOn(config.desk, WNEAR, 'ft_transfer_call', { receiver_id: VERIFIER, amount: add.toString(), msg: id }, 100, 1n);
}

export interface CashOutRequest { amount: string; message: string; nonce: string; recipient: string; publicKey: string; signature: string }

let busy = false;

/** Settles a creator's signed cash-out. Throws with a plain reason when it can't. */
export async function settleCashOut(account: string, r: CashOutRequest): Promise<{ tx: string; near: string }> {
  if (!hasKey(config.desk)) throw new Error('the desk is not configured on this server');
  if (busy) throw new Error('another cash-out is settling; try again in a few seconds');
  busy = true;
  try {
    const amount = BigInt(r.amount);
    const bad = checkCashOut({ message: r.message, recipient: r.recipient, verifier: VERIFIER, account, tusd: tusdId(), wnear: WNEAR, amount, nowMs: Date.now() });
    if (bad) throw new Error(`the signed intent was refused: ${bad}`);
    if (b64decode(r.nonce).length !== 32) throw new Error('the nonce must be 32 bytes');
    if ((await inVerifier(account, tusdId())) < amount) throw new Error('deposit the tUSD into the Verifier first');
    if (!(await viewOn<boolean>(VERIFIER, 'has_public_key', { account_id: account, public_key: r.publicKey }).catch(() => false))) throw new Error('register your wallet key with the Verifier first');
    const near = nearForTusd(amount);
    await deskFloat(near);
    const sig = r.signature.startsWith('ed25519:') ? r.signature : `ed25519:${b58encode(b64decode(r.signature))}`;
    const creator: SignedIntent = { standard: 'nep413', payload: { recipient: r.recipient, nonce: r.nonce, message: r.message }, public_key: r.publicKey, signature: sig };
    const deskSide = deskIntents({ tusd: tusdId(), wnear: WNEAR, amount });
    if (!diffsBalance([cashOutIntents({ tusd: tusdId(), wnear: WNEAR, amount, receiver: account }), deskSide])) throw new Error('the two sides do not cancel');
    const salt = await viewOn<string>(VERIFIER, 'current_salt', {});
    const desk = signIntents({ privateKey: privateKey(config.desk), saltHex: salt, intents: deskSide as never, nowMs: Date.now(), random: randomBytes(15) });
    await viewOn(VERIFIER, 'simulate_intents', { signed: [creator, desk] }).catch((e: Error) => { throw new Error(`the Verifier would refuse it: ${e.message.slice(0, 200)}`); });
    const x = await callOn(config.desk, VERIFIER, 'execute_intents', { signed: [creator, desk] }, 300);
    addWire({ who: account.replace(/\.testnet$/, ''), what: `cashed out ${(Number(amount) / 1e6).toFixed(2)} tUSD for ${fmtNear(near, 4)} NEAR (through NEAR Intents)`, tx: x.tx, kind: 'payout' });
    return { tx: x.tx, near: near.toString() };
  } finally {
    busy = false;
  }
}
