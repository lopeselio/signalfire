import { DOES_NOT_PROVE, attestModel, replyChecks } from '@signalfire/attest';
import { canonical, evidenceHash, evidencePrompt, plainBrief, ruleFlags, type EvidenceItem } from '@signalfire/core';
import type { BriefRecord } from './evidence/brief.ts';
import { SYSTEM, briefFrom } from './evidence/parse.ts';
import { RPCS, checkProof, github } from './evidence/proofs.ts';
import type { FounderLink } from './evidence/store.ts';

// Re-checks a startup's founder links and AI research brief without trusting the Signalfire server:
//   pnpm verify-brief <startup> [baseUrl]
// It fetches the proof bundle (links with their proofs, the brief with the evidence it was given and the exact NEAR AI
// exchange), then checks: every verified link (re-fetches the gist, file or X post and checks the founder's NEP-413
// signature against the account's full-access keys over public RPC); the evidence hash; that the model was given
// exactly that evidence under the published rules; that re-running the guard on the signed reply gives the brief
// the page shows; the rule checks; the model's TEE attestation (fresh nonce) and the reply's signature. Then it
// re-fetches the sources themselves and reports what changed since the brief was written.

const [startup, base = 'http://localhost:8861'] = process.argv.slice(2);
if (!startup) { console.error('usage: pnpm verify-brief <startup> [baseUrl]'); process.exit(2); }

let ok = 0;
let failed = 0;
const pass = (s: string): void => { ok++; console.log(`✓ ${s}`); };
const fail = (s: string): void => { failed++; console.log(`✗ ${s}`); };
const check = (c: boolean, yes: string, no: string): void => (c ? pass(yes) : fail(no));
const info = (s: string): void => console.log(`  ${s}`);

async function viewOn<T>(account: string, method: string, args: object): Promise<T> {
  for (const rpc of RPCS) {
    try {
      const r = (await (await fetch(rpc, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'call_function', finality: 'final', account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') } }),
      })).json()) as { result?: { result: number[] } };
      if (r.result) return JSON.parse(Buffer.from(r.result.result).toString('utf8')) as T;
    } catch { /* next RPC */ }
  }
  throw new Error(`could not read ${method} from ${account}`);
}
const near = (y: string): number => Number(BigInt(y) / 10n ** 20n) / 10_000;

interface Bundle { hub: string; startup: string; founder: string; links: FounderLink[]; brief: BriefRecord | null }

async function main(): Promise<void> {
  const res = await fetch(`${base.replace(/\/$/, '')}/api/evidence/${startup}/proof`);
  if (!res.ok) throw new Error(`${base} has no evidence bundle for ${startup} (HTTP ${res.status})`);
  const b = (await res.json()) as Bundle;
  const st = await viewOn<{ id: string; name: string; founder: string; fees_in: string; paid: string; campaigns: number[] } | null>(b.hub, 'get_startup', { id: startup });
  if (!st) { fail(`${b.hub} has no startup ${startup}`); return; }
  console.log(`${st.name} (${startup.toUpperCase()}) on ${b.hub}, founder ${st.founder}`);
  check(st.founder === b.founder, `the founder in the bundle is the founder onchain (${st.founder})`, `the bundle names ${b.founder}, the chain ${st.founder}`);

  // 1. founder links
  const verified = b.links.filter((l) => l.status === 'verified');
  if (!b.links.length) pass('no founder links claimed (nothing to recheck)');
  for (const l of b.links.filter((x) => x.status !== 'verified')) pass(`${l.kind}:${l.target} is shown as claimed, not verified`);
  for (const l of verified) {
    const r = await checkProof({ startup, founder: st.founder, kind: l.kind, target: l.target }, l.proofUrl ?? '', b.hub);
    check(r.ok, `${l.kind}:${l.target}: the proof at ${l.proofUrl} is published by that account and signed by ${st.founder}'s full-access key ${r.publicKey?.slice(0, 18)}…`, `${l.kind}:${l.target}: proof does not check (${r.error})`);
  }

  // 2. the brief
  const br = b.brief;
  if (!br) { pass('no research brief written yet'); return; }
  console.log(`research brief of ${new Date(br.at).toISOString()} (${br.evidence.length} evidence items)`);
  check(evidenceHash(br.evidence) === br.evidenceHash, `the evidence hashes to ${br.evidenceHash.slice(0, 16)}… (sha256 of its canonical JSON)`, 'the evidence does not match its hash');
  const ids = br.evidence.map((i) => i.id);
  check(new Set(ids).size === ids.length && br.evidence.every((i) => i.source.url !== undefined && i.fetchedAt > 0), 'every evidence item has a unique id, a source and a fetch time', 'evidence items are malformed');
  check(canonical(ruleFlags(br.evidence)) === canonical(br.flags), `the ${br.flags.length} rule checks recompute from the evidence`, 'the rule checks do not recompute from the evidence');
  for (const l of verified) {
    check(br.evidence.some((i) => i.kind === 'links' && String(i.facts.links).includes(`${l.kind}:${l.target} (verified)`)) || br.at < (l.checkedAt ?? 0),
      `${l.kind}:${l.target} appears in the brief's evidence as verified`, `${l.kind}:${l.target} is verified but the brief's evidence doesn't say so`);
  }
  if (!br.proof) {
    pass('written without NEAR AI: facts and rule checks only, unsigned');
  } else {
    const req = JSON.parse(br.proof.request) as { model: string; messages: { role: string; content: string }[] };
    check(req.messages[0]?.content === SYSTEM, 'the model was given the published rules (no advice, cite every line, inference labelled)', 'the system prompt differs from the published rules');
    check(req.messages[1]?.content === evidencePrompt({ id: startup, name: br.name }, br.evidence) && req.messages.length === 2, 'the model was given exactly this evidence and nothing else', 'the request holds something other than this evidence');
    const g0 = briefFrom(br.proof.response, br.evidence);
    // an unreadable reply leaves only the facts and the rule checks (plainBrief), never the model's text
    const g = g0.parsed ? g0 : { parsed: false, brief: plainBrief(br.evidence), dropped: [] };
    check(g.parsed === br.parsed && canonical(g.brief) === canonical(br.brief) && canonical(g.dropped) === canonical(br.dropped),
      `re-running the guard on the signed reply gives the brief shown (${Object.values(g.brief).flat().length} lines kept, ${g.dropped.length} dropped)`, 'the brief shown is not what the guard makes of the signed reply');
    for (const d of g.dropped) info(`dropped (${d.reason}): “${d.text}”`);
    try {
      const v = await attestModel(req.model);
      for (const c of v.candidates.find((x) => x.signingAddress.toLowerCase() === br.proof!.signingAddress?.toLowerCase())?.checks ?? v.candidates[0]?.checks ?? []) check(c.ok, `TEE: ${c.label}`, `TEE: ${c.label}`);
      check(v.ok, `${req.model}: attested by NEAR AI Cloud with a fresh nonce (signer ${v.trustedSigners.join(', ')})`, `${req.model}: no report candidate passed every check`);
      check(replyChecks(br.proof, v).every((c) => c.ok), `the brief was signed by the attested NEAR AI TEE key ${br.proof.signingAddress?.slice(0, 10)}…`, 'the brief’s signature does not check against a verified report');
    } catch (e) { fail(`could not check the attestation (${(e as Error).message})`); }
  }

  // 3. the sources now
  console.log('the sources now (live data moves; only what can never go back is checked):');
  for (const it of br.evidence as EvidenceItem[]) {
    try {
      if (it.kind === 'founder-account') {
        const a = (await (await fetch(`https://api-testnet.nearblocks.io/v3/accounts/${st.founder}`)).json()) as { data?: { created?: { transaction_hash?: string } } };
        check(a.data?.created?.transaction_hash === it.facts.created_tx, `${it.id} founder account created in ${String(it.facts.created_tx).slice(0, 10)}… (NearBlocks)`, `${it.id} the founder account's creation differs`);
      } else if (it.kind === 'treasury') {
        check(near(st.fees_in) >= Number(it.facts.fees_in_near) && near(st.paid) >= Number(it.facts.paid_to_creators_near),
          `${it.id} treasury: fees in ${it.facts.fees_in_near} → ${near(st.fees_in)} NEAR, paid to creators ${it.facts.paid_to_creators_near} → ${near(st.paid)} (never down)`, `${it.id} the treasury's totals went down, which the hub can't do`);
      } else if (it.kind === 'campaigns') {
        check(st.campaigns.length >= Number(it.facts.posted), `${it.id} campaigns posted: ${it.facts.posted} then, ${st.campaigns.length} now`, `${it.id} fewer campaigns than the brief says`);
      } else if (it.kind === 'github-repo') {
        const r = await github(`/repos/${String(it.facts.repo)}`);
        if (r.ok) { const j = (await r.json()) as { stargazers_count: number; pushed_at: string }; pass(`${it.id} ${String(it.facts.repo)} still public; stars ${it.facts.stars} → ${j.stargazers_count}, last push ${String(it.facts.last_push)} → ${j.pushed_at.slice(0, 10)}`); }
        else fail(`${it.id} ${String(it.facts.repo)}: GitHub HTTP ${r.status}`);
      }
    } catch (e) { info(`${it.id}: could not re-fetch (${(e as Error).message})`); }
  }
  console.log(`\nWhat a verified brief does not prove: that the brief is right or complete, or anything about the startup's future. ${DOES_NOT_PROVE}`);
}

main().then(() => {
  console.log(`${failed ? '✗' : '✓'} ${ok} checks passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(1); });
