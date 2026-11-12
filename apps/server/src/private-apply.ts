// A person's private creator application, end to end on testnet, with the same calls the web app's Apply form makes:
//   pnpm private-apply <account> [baseUrl]     e.g. pnpm private-apply sf-priv.signalfire-intents.testnet https://signalfire.lopeselio.online
// <account> is an ordinary account with a full-access key in ~/.near-credentials.
// 1. it signs in to <baseUrl> with its key (NEP-413, as a wallet would)
// 2. it verifies the NEAR AI model's attestation itself (Ed25519 key, fresh nonce), checks the server names the same
//    key, seals its private details to it, and writes a receipt (details, salt, one-off key) next to it
// 3. it sends the ciphertext to the server, funds its Signalfire wallet and applies onchain
// 4. it waits for the scout's report, then checks its receipt against the published, signed request.
// Then: pnpm verify creator <account> <baseUrl>. Against a local server run with AGENTS=0, set LOCAL_SCOUT=1 (and the
// same DATA_DIR) to run the scout in this process.
import { writeFileSync } from 'node:fs';
import { attestModel, newSalt, openSealed, privateCommitment, sealForModel } from '@signalfire/attest';
import { BID_BOND, VET_FEE, fmtNear } from '@signalfire/core';
import { Near } from 'near-kit';
import { call, view } from './chain.ts';
import { config, explorerTx, privateKey } from './config.ts';
import { getWallet } from './hub.ts';

const [who, base = 'http://localhost:8861'] = process.argv.slice(2);
if (!who) { console.error('usage: pnpm private-apply <account> [baseUrl]'); process.exit(2); }
const t0 = Date.now();
const log = (s: string, tx?: string): void => console.log(`[${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s] ${s}${tx ? `\n        ${explorerTx(tx)}` : ''}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const origin = new URL(base).origin;
const host = new URL(base).host;

// 1. sign in, as a wallet would
let cookie = '';
async function post<T>(path: string, body: unknown): Promise<T> {
  // the hosted ingress answers 502/503 now and then: try again
  for (let i = 0; ; i++) {
    try { return await postOnce<T>(path, body); } catch (e) { if (i >= 5 || !/: 50\d$/.test((e as Error).message)) throw e; await sleep(3000); }
  }
}
async function postOnce<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin, cookie }, body: JSON.stringify(body) });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = [...new Map([...cookie.split('; ').filter(Boolean), ...set.map((c) => c.split(';')[0])].map((c) => [c.split('=')[0], c])).values()].join('; ');
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string };
  if (!res.ok) throw new Error(`${path}: ${data.error ?? data.message ?? res.status}`);
  return data;
}
const near = new Near({ network: 'testnet', privateKey: privateKey(who) as `ed25519:${string}`, defaultSignerId: who });
// the server checks the account and its key over public RPC, which rate-limits: try the whole sign-in again
for (let i = 0; ; i++) {
  try {
    const { nonce } = await post<{ nonce: string }>('/api/ba/near/nonce', { accountId: who, networkId: 'testnet' });
    const message = `Sign in to ${host}`;
    const signedMessage = await near.signMessage({ message, recipient: host, nonce: Uint8Array.from(Buffer.from(nonce, 'hex')) }, { signerId: who });
    await post('/api/ba/near/verify', { signedMessage, message, recipient: host, nonce, accountId: who });
    break;
  } catch (e) {
    if (i >= 8) throw e;
    await sleep(5000);
  }
}
log(`${who}: signed in to ${host}`);

if (await view<unknown>('get_creator', { account: who }).catch(() => null)) { log(`${who} is already an admitted creator`); process.exit(0); }

// 2. the model's key, verified here
const model = config.nearAi.model;
const v = await attestModel(model, { algo: 'ed25519' });
for (const c of v.candidates[0]?.checks ?? []) log(`  ${c.ok ? '✓' : '✗'} ${c.label}`);
if (!v.ok || v.trustedSigners.length !== 1) throw new Error('the model attestation did not verify; nothing sent');
const key = v.trustedSigners[0].replace(/^0x/, '');
const server = await (await fetch(`${base}/api/e2ee-key`)).json() as { key: string };
if (server.key !== key) throw new Error('the server names a different model key; nothing sent');
log(`the model's Ed25519 key ${key.slice(0, 16)}… is attested (fresh nonce) and matches the server's`);

const text = 'Private details from the applicant (for judging only; never quote them):\n' +
  `Audience size: ${process.env.AUDIENCE ?? '6,200 followers on campus Instagram, 1,900 on TikTok'}\n` +
  `Past results: ${process.env.RESULTS ?? 'Ran the freshers-week study-spot map for the student union: 2,400 opens, 310 sign-ups in a week'}\n` +
  `Contact: ${process.env.CONTACT ?? 'dm @studyspots on Instagram'}`;
const salt = newSalt();
const commitment = privateCommitment(who, salt, text);
const sealed = sealForModel(text, key);
const receiptFile = process.env.RECEIPT ?? `signalfire-private-application-${who}.json`;
writeFileSync(receiptFile, JSON.stringify({ kind: 'signalfire-private-application', account: who, model, modelPub: key, text, salt, commitment, ephSecret: sealed.ephSecret, at: Date.now() }, null, 1));
log(`sealed the private details; receipt (keep it) at ${receiptFile}; commitment ${commitment.slice(0, 16)}…`);

// 3. ciphertext to the scout's queue, then the onchain application
await post('/api/private-application', { sealed: sealed.hex, modelPub: key, commitment });
log('sent the ciphertext to the server (it cannot open it)');
const w = await getWallet(who);
if (!w || BigInt(w.balance) < VET_FEE + BID_BOND) {
  const r = await call(who, 'fund_wallet', { account: who }, 30, VET_FEE + BID_BOND);
  log(`${who}: funded the Signalfire wallet with ${fmtNear(VET_FEE + BID_BOND)} NEAR`, r.tx);
}
if (!(await view<unknown>('get_application', { account: who }).catch(() => null))) {
  const r = await call(who, 'apply_creator', { name: process.env.NAME ?? 'Sam (a person)', profile: process.env.PROFILE ?? 'Maps study spots and runs campus-club takeovers; writes every post by hand.' }, 30);
  log(`${who}: applied as a creator (public: name and profile only)`, r.tx);
}
await post('/api/applied', {});
if (process.env.LOCAL_SCOUT === '1') {
  // testing against a local server started with AGENTS=0: run the scout here, on the same DATA_DIR
  const { vet } = await import('./agents.ts');
  const { invalidate, snapshot } = await import('./snapshot.ts');
  await sleep(3000);
  invalidate();
  await vet(await snapshot(), who);
}

// 4. the scout's report, then the receipt against the signed request
for (let i = 0; i < 40; i++) {
  const d = await (await fetch(`${base}/api/creator/${who}`)).json() as { vetting: { report: string; privateCommitment: string | null; privateVerdict: unknown } | null };
  if (d.vetting) {
    log(`the scout filed its report; private verdict ${JSON.stringify(d.vetting.privateVerdict)}; public commitment ${d.vetting.privateCommitment?.slice(0, 16)}…`);
    console.log(`\n${d.vetting.report}\n`);
    const rep = await (await fetch(`${base}/api/reply/private/${who}`)).json() as { request: string; e2ee: { modelPub: string } };
    const msgs = (JSON.parse(rep.request) as { messages: { content: string }[] }).messages;
    const opened = openSealed(msgs[msgs.length - 1].content, sealed.ephSecret, rep.e2ee.modelPub);
    log(`${d.vetting.privateCommitment === commitment ? '✓' : '✗'} the report commits to these details`);
    log(`${opened === text ? '✓' : '✗'} the receipt's one-off key opens the ciphertext the model received to exactly these details`);
    break;
  }
  await sleep(10_000);
}
const admitted = !!(await view<unknown>('get_creator', { account: who }).catch(() => null));
log(admitted ? `${who}: admitted by rule` : `${who}: not admitted yet`);
console.log(`\nnext: pnpm verify creator ${who} ${base}`);
