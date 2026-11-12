// A person's bid sealed for the OutLayer scorer, with the same calls the web app's "Your sealed bid" panel makes:
//   pnpm sealed-bid <account> <campaign> <price in NEAR> ["pitch"]
// <account> is an admitted creator with a full-access key in ~/.near-credentials and a funded Signalfire wallet.
// It reads the scorer's key from the hub, encrypts the opening to it, and sends the commitment and the ciphertext
// (commit_sealed_bid). There is no reveal: when bidding closes anyone calls score_sealed, the TEE opens every bid and
// the hub accepts only the winner's. The opening is written next to it so the bidder can publish their pitch if they win.
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { sealBid as sealForScorer } from '@signalfire/attest';
import { BID_BOND, parseNear, sealBid } from '@signalfire/core';
import { call, view } from './chain.ts';
import { config, explorerTx } from './config.ts';
import { getWallet } from './hub.ts';

const [who, idArg, priceArg, pitch = 'Hand-written posts on campus boards and a study-spot map; I will share the link in three student Discords.'] = process.argv.slice(2);
if (!who || !idArg || !priceArg) { console.error('usage: pnpm sealed-bid <account> <campaign> <price in NEAR> ["pitch"]'); process.exit(2); }
const id = Number(idArg);
const scorer = await view<{ bid_key: string | null; wasm_hash: string } | null>('get_scorer', {});
if (!scorer?.bid_key) throw new Error('the hub has no scorer key yet');
const book = await view<{ bid_key: string } | null>('get_sealed', { campaign_id: id });
const key = book?.bid_key ?? scorer.bid_key;
const w = await getWallet(who);
if (!w || BigInt(w.balance) < BID_BOND) {
  const r = await call(who, 'fund_wallet', { account: who }, 30, BID_BOND);
  console.log(`funded the wallet for the bond: ${explorerTx(r.tx)}`);
}
const o = sealBid(id, who, parseNear(priceArg), pitch, randomBytes(32).toString('hex'));
const ciphertext = sealForScorer(key, config.hub, id, who, { price: o.price, pitch_hash: o.pitchHash, salt: o.salt });
writeFileSync(process.env.OPENING ?? `signalfire-bid-${id}-${who}.json`, JSON.stringify({ ...o, hub: config.hub, sealedFor: 'outlayer', ciphertext }, null, 1));
const r = await call(who, 'commit_sealed_bid', { campaign_id: id, hash: o.hash, ciphertext }, 30);
console.log(`${who}: sealed a bid on #${id} for the TEE (scorer key ${key.slice(0, 16)}…, wasm ${scorer.wasm_hash.slice(0, 16)}…)\n  ${explorerTx(r.tx)}\n  commitment ${o.hash}\n  ciphertext ${ciphertext.slice(0, 48)}… (${ciphertext.length / 2} bytes)`);
