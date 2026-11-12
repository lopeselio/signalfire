import { DOES_NOT_PROVE, attestModel, replyChecks, type ModelVerification } from '@signalfire/attest';
import {
  MIN_ATTRIB, bidHash, cost, credible, fmtTusd, milestoneAmount, pickWinner, pitchHash, sha256Hex, threshold, tusdFor,
} from '@signalfire/core';
import type { ProofBundle } from './proof.ts';

// Re-checks a campaign without trusting the Signalfire server:
//   pnpm verify <campaignId> [baseUrl]
// It fetches the proof bundle (bid openings, pitches, vetting reports and their NEAR AI signatures) from the
// server, then reads the hub, the startup's Sputnik DAO and the NFTs itself over public RPC, and checks:
// every revealed bid against its sealed commitment; the winner by the shared scoring rule; the DAO proposal
// (what it calls, its status and who voted); the attributed buyers; every payout against the milestones and
// the spend policy log; the tUSD amounts; the receipt NFT; the curve reserve; the NEAR AI model's TEE attestation (fresh nonce, Intel quote, bindings,
// RTMR3, GPUs); and every reply's TEE signature against it.

const RPCS = ['https://rpc.testnet.fastnear.com', 'https://test.rpc.fastnear.com', 'https://near-testnet.drpc.org'];

async function viewOn<T>(account: string, method: string, args: object): Promise<T> {
  for (const rpc of RPCS) {
    try {
      const r = (await (await fetch(rpc, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'call_function', finality: 'final', account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') } }),
      })).json()) as { result?: { result: number[] } };
      if (r.result) return JSON.parse(Buffer.from(r.result.result).toString('utf8')) as T;
    } catch { /* next RPC */ }
  }
  throw new Error(`could not read ${method} from ${account}`);
}

interface ChainBid { creator: string; hash: string; revealed: boolean; price: string | null; pitch_hash: string | null; credible: boolean; rep: number }
interface ChainCampaign {
  id: number; startup: string; title: string; target: number; budget: string; phase: string; bids: ChainBid[]; winner: string | null; price: string;
  proposal_id: number | null; results: number; attributed: string[]; milestones_paid: number; paid: string; paid_tusd: string; receipt: string | null;
}
interface ChainStartup { id: string; token: string; dao: string; circulating: string; reserve: string; constraints: { min_bid_bps: number; max_payout: string } }
interface Audit { n: number; campaign: number | null; action: string; account: string | null; amount: string; outcome: string; flags: string[]; note: string }
interface Trade { account: string; near: string; ref_code: string | null; attributed: number | null }

export interface Report { ok: number; failed: number; lines: string[] }

export async function verifyCampaign(id: number, bundle: ProofBundle, log: (s: string) => void = console.log): Promise<Report> {
  const r: Report = { ok: 0, failed: 0, lines: [] };
  const ok = (s: string): void => { r.ok++; r.lines.push(`✓ ${s}`); log(`✓ ${s}`); };
  const bad = (s: string): void => { r.failed++; r.lines.push(`✗ ${s}`); log(`✗ ${s}`); };
  const check = (cond: boolean, yes: string, no: string): void => (cond ? ok(yes) : bad(no));
  const hub = bundle.hub;

  const c = await viewOn<ChainCampaign | null>(hub, 'get_campaign', { id });
  if (!c) { bad(`${hub} has no campaign ${id}`); return r; }
  const s = await viewOn<ChainStartup>(hub, 'get_startup', { id: c.startup });
  log(`campaign #${id} "${c.title}" for ${c.startup.toUpperCase()} (${hub}), phase ${c.phase}`);

  // 1. sealed bids
  for (const b of c.bids.filter((x) => x.revealed)) {
    const o = bundle.bids.find((x) => x.creator === b.creator);
    if (!o) { bad(`no opening published for ${b.creator}`); continue; }
    check(bidHash(id, b.creator, BigInt(o.price), o.pitchHash, o.salt) === b.hash, `${b.creator}: the opening matches the sealed commitment`, `${b.creator}: the opening does NOT match the commitment`);
    check(pitchHash(o.pitch) === o.pitchHash && o.pitchHash === b.pitch_hash, `${b.creator}: the pitch text hashes to the pitch_hash sealed in the bid`, `${b.creator}: the pitch does not match its hash`);
    check(o.price === b.price && credible(BigInt(o.price), BigInt(c.budget), s.constraints.min_bid_bps) === b.credible, `${b.creator}: price and credibility match the chain`, `${b.creator}: price or credibility differ`);
  }
  const unrevealed = c.bids.filter((x) => !x.revealed).length;
  if (unrevealed) ok(`${unrevealed} bid(s) never revealed (their bonds go to the treasury)`);

  // 2. the winner, by the shared rule
  if (c.phase !== 'bidding') {
    const revealed = c.bids.map((b, i) => ({ b, i })).filter(({ b }) => b.revealed);
    const w = pickWinner(revealed.map(({ b, i }) => ({ creator: b.creator, price: BigInt(b.price!), rep: b.rep, commitIndex: i })), BigInt(c.budget), s.constraints.min_bid_bps);
    const want = w === null ? null : revealed[w].b.creator;
    check(want === c.winner, `the winner (${c.winner ?? 'none'}) is the lowest reputation-weighted credible bid`, `the rule picks ${want}, the chain says ${c.winner}`);
  }

  // 3. the DAO proposal
  if (c.proposal_id !== null) {
    const p = await viewOn<{ kind: { FunctionCall?: { receiver_id: string; actions: { method_name: string; args: string; deposit: string }[] } }; status: string; votes: Record<string, string> }>(s.dao, 'get_proposal', { id: c.proposal_id });
    const fc = p.kind.FunctionCall;
    const args = fc ? JSON.parse(Buffer.from(fc.actions[0].args, 'base64').toString('utf8')) as { campaign_id: number } : null;
    check(!!fc && fc.receiver_id === hub && fc.actions[0].method_name === 'fund_campaign' && args?.campaign_id === id && fc.actions[0].deposit === '0',
      `DAO proposal ${c.proposal_id} in ${s.dao} calls ${hub}.fund_campaign({"campaign_id":${id}}) and moves no money itself`, 'the DAO proposal is not the funding call');
    const policy = await viewOn<{ roles: { name: string; kind: { Group?: string[] } }[] }>(s.dao, 'get_policy', {});
    const holders = policy.roles.find((x) => x.name === 'holders')?.kind.Group ?? [];
    const voters = Object.keys(p.votes);
    check(voters.every((v) => holders.includes(v)), `${voters.length} vote(s), all from the DAO's holders role: ${Object.entries(p.votes).map(([a, v]) => `${a.split('.')[0]} ${v}`).join(', ')}`, 'a vote came from outside the holders role');
    check(policy.roles.every((x) => !(x as { permissions?: string[] }).permissions?.some((pm) => pm.startsWith('transfer:') || pm === '*:*')), 'nobody in the DAO may propose or approve a transfer', 'the DAO policy allows transfers');
    if (['funded', 'done', 'expired'].includes(c.phase)) check(p.status === 'Approved', 'the proposal passed, and only then was the campaign funded', `the campaign is ${c.phase} but the proposal is ${p.status}`);
  }

  // 4. attribution
  check(c.attributed.length === c.results, `${c.results} attributed first-time buyer(s) recorded`, 'results and the attributed list disagree');
  const trades = await viewOn<Trade[]>(hub, 'get_trades', { startup: c.startup, limit: 240 });
  const mine = trades.filter((t) => t.attributed === id);
  check(mine.every((t) => BigInt(t.near) >= MIN_ATTRIB && t.ref_code === `c${id}` && t.account !== c.winner),
    `every attributed trade still in the ring (${mine.length}) used code c${id}, paid at least 0.05 NEAR and isn't the creator's`, 'an attributed trade breaks the rule');
  check(new Set(c.attributed).size === c.attributed.length, 'no buyer counted twice', 'a buyer was counted twice');

  // 5. payouts against the milestones and the policy log
  const audit = await viewOn<Audit[]>(hub, 'get_audit', { from: 0, limit: 200 });
  const more = audit.length === 200 ? await viewOn<Audit[]>(hub, 'get_audit', { from: 200, limit: 200 }) : [];
  const entries = [...audit, ...more].filter((e) => e.campaign === id);
  const paid = entries.filter((e) => e.action === 'payout' && e.outcome === 'paid');
  check(paid.length === c.milestones_paid, `${paid.length} payout(s) logged as paid = milestones paid`, `the log has ${paid.length} paid payouts, the campaign ${c.milestones_paid}`);
  let sum = 0n;
  let tusd = 0n;
  paid.forEach((e, i) => {
    const k = i + 1;
    const amt = BigInt(e.amount);
    sum += amt;
    tusd += tusdFor(amt);
    check(amt === milestoneAmount(BigInt(c.price), k) && e.account === c.winner, `milestone ${k}: ${e.amount} yoctoNEAR to the winner [flags: ${e.flags.join(', ') || 'none'}]`, `milestone ${k} paid the wrong amount or payee`);
  });
  if (c.milestones_paid > 0) check(c.results >= threshold(c.target, c.milestones_paid), `the results (${c.results}) reach milestone ${c.milestones_paid}'s threshold (${threshold(c.target, c.milestones_paid)})`, 'paid ahead of the results');
  check(sum === BigInt(c.paid) && sum <= BigInt(c.price), 'payouts add up to what the campaign paid, within the price', 'payouts do not add up');
  check(tusd === BigInt(c.paid_tusd), `${fmtTusd(tusd)} tUSD paid at the fixed test rate (1 NEAR = 3 tUSD)`, 'tUSD amounts disagree');
  const held = entries.filter((e) => e.outcome.startsWith('held'));
  if (held.length) ok(`${held.length} payout attempt(s) held by the policy: ${held.map((e) => e.outcome).join(', ')}`);
  const fund = entries.find((e) => e.action === 'fund');
  if (['funded', 'done', 'expired'].includes(c.phase)) check(!!fund && fund.amount === c.price, 'the fund entry reserved exactly the winning price', 'no fund entry for the price');

  // 6. the receipt NFT
  if (c.phase === 'done') {
    const t = await viewOn<{ owner_id: string; metadata: { extra: string } } | null>(hub, 'nft_token', { token_id: `receipt:${id}` });
    const extra = t ? JSON.parse(t.metadata.extra) as { results: number; spend_yocto: string } : null;
    check(!!t && t.owner_id === c.winner && extra?.results === c.results && extra.spend_yocto === c.price, `receipt NFT receipt:${id} belongs to the creator and records ${c.results} results for ${c.price} yoctoNEAR`, 'the receipt NFT is missing or wrong');
  }

  // 7. the curve
  check(BigInt(s.reserve) === cost(0n, BigInt(s.circulating)), `${c.startup.toUpperCase()}'s curve reserve equals the integral of the price line (every token can be sold back)`, 'the curve reserve is off');

  // 8. NEAR AI: the model's TEE, checked now with a fresh nonce, then every reply's signature against it
  const signed = [...bundle.bids.map((b) => b.proof), ...bundle.vetting.map((v) => v.proof)].filter((p): p is NonNullable<typeof p> => !!p?.signature);
  const models = [...new Set(signed.map((p) => p.model))];
  const attested = new Map<string, ModelVerification | null>();
  for (const model of models) {
    try {
      const v = await attestModel(model);
      attested.set(model, v);
      v.candidates.forEach((cand, i) => {
        log(`  ${model} report candidate ${i + 1} (signer ${cand.signingAddress}), nonce ${v.nonce.slice(0, 16)}…`);
        for (const k of cand.checks) check(k.ok, `TEE: ${k.label}${k.detail ? ` [${k.detail}]` : ''}`, `TEE: ${k.label}${k.detail ? ` [${k.detail}]` : ''}`);
        if (cand.measurements.mrTd) log(`  measurements: MRTD ${cand.measurements.mrTd.slice(0, 16)}…, compose ${cand.measurements.composeHash?.slice(0, 16)}…, app ${cand.measurements.appId ?? '?'}, TCB ${cand.measurements.tcbStatus}, GPUs ${cand.measurements.gpus?.join(' ') ?? '?'}`);
      });
      check(v.ok, `${model}: attested by NEAR AI Cloud with a fresh nonce (signer ${v.trustedSigners.join(', ')})`, `${model}: no report candidate passed every check`);
    } catch (e) {
      attested.set(model, null);
      bad(`${model}: could not fetch or check the attestation report (${(e as Error).message})`);
    }
  }
  const replyOk = (p: NonNullable<ProofBundle['bids'][number]['proof']>): boolean => replyChecks(p, attested.get(p.model) ?? null).every((k) => k.ok);
  for (const o of bundle.bids) {
    if (!o.proof) { ok(o.author === 'creator' ? `${o.creator}: pitch written by the creator in their browser (no model, nothing to sign)` : `${o.creator}: pitch written without NEAR AI (fallback text, unsigned)`); continue; }
    check(replyOk(o.proof) && o.proof.response.includes(JSON.stringify(o.pitch).slice(1, 30)), `${o.creator}: pitch signed by the attested NEAR AI TEE key ${o.proof.signingAddress?.slice(0, 10)}…`, `${o.creator}: the pitch's TEE signature does not check against a verified report`);
  }
  for (const v of bundle.vetting) {
    const cr = await viewOn<{ creator: { report_hash: string } } | null>(hub, 'get_creator', { account: v.account });
    check(!!cr && sha256Hex(v.report) === cr.creator.report_hash, `${v.account}: the vetting report hashes to the report_hash the scout put onchain`, `${v.account}: report hash mismatch`);
    if (v.proof) check(replyOk(v.proof), `${v.account}: vetting report signed by the attested NEAR AI TEE key`, `${v.account}: vetting report signature does not check against a verified report`);
  }
  if (models.length) log(`  note: ${DOES_NOT_PROVE}`);
  log(`\n${r.failed === 0 ? '✓' : '✗'} ${r.ok} checks passed, ${r.failed} failed`);
  return r;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [idArg, base = 'http://localhost:8861'] = process.argv.slice(2);
  if (!idArg) { console.error('usage: pnpm verify <campaignId> [baseUrl]'); process.exit(2); }
  const res = await fetch(`${base}/api/campaign/${idArg}/proof`);
  const bundle = (await res.json()) as ProofBundle & { error?: string };
  if (!res.ok) { console.error(`✗ ${bundle.error ?? res.status}`); process.exit(1); }
  const rep = await verifyCampaign(Number(idArg), bundle);
  process.exit(rep.failed === 0 ? 0 : 1);
}
