import { randomBytes } from '@noble/hashes/utils.js';
import { gpuChecks, nrasDirect, type NrasPost } from './gpu.ts';
import { appIdOf, bindingChecks, composeCheck, rtmr3Check, sha256Hex, appComposeOf } from './measure.ts';
import { fetchCollateral, hex, quoteChecks, verifyQuote, type Collateral } from './quote.ts';
import type { AttestationReport, Candidate, Check, ModelAttestation, ModelVerification } from './types.ts';

// The whole check of a NEAR AI Cloud model, runnable in a browser or in Node:
// fresh nonce → report → for every candidate: Intel quote, binding of signer + nonce, MRCONFIGID, RTMR3, GPUs.

export const NEARAI_API = 'https://cloud-api.near.ai';
export const newNonce = (): string => hex(randomBytes(32));

export async function fetchReport(model: string, nonce: string): Promise<AttestationReport> {
  const url = `${NEARAI_API}/v1/attestation/report?model=${encodeURIComponent(model)}&signing_algo=ecdsa&nonce=${nonce}`;
  const res = await fetch(url, { headers: { accept: 'application/json', 'x-no-aliasing': 'true' } });
  if (!res.ok) throw new Error(`attestation report: HTTP ${res.status}`);
  return (await res.json()) as AttestationReport;
}

export interface VerifyOptions {
  nras?: NrasPost;
  /** collateral to use instead of fetching it (tests) */
  collateral?: (quoteHex: string) => Promise<Collateral>;
  nowSecs?: number;
  /** skip the NVIDIA call (tests) */
  skipGpu?: boolean;
}

export async function verifyCandidate(a: ModelAttestation, model: string, nonce: string, o: VerifyOptions = {}): Promise<Candidate> {
  const checks: Check[] = [
    { id: 'report.model', label: `The report is for ${model}`, ok: a.model_name === model },
    { id: 'report.algo', label: 'Signing algorithm is ECDSA (secp256k1)', ok: a.signing_algo === 'ecdsa' },
  ];
  const measurements: Candidate['measurements'] = {};
  try {
    const collateral = await (o.collateral ?? fetchCollateral)(a.intel_quote);
    const q = verifyQuote(a.intel_quote, collateral, o.nowSecs ?? Math.floor(Date.now() / 1000));
    checks.push(...quoteChecks(q), ...bindingChecks(q.reportData, a, nonce), composeCheck(q.mrConfigId, a), rtmr3Check(q.rtmr[3], a));
    Object.assign(measurements, {
      tcbStatus: q.status, advisories: q.advisories, mrTd: hex(q.mrTd), rtmr0: hex(q.rtmr[0]), rtmr1: hex(q.rtmr[1]), rtmr2: hex(q.rtmr[2]), rtmr3: hex(q.rtmr[3]),
      mrConfigId: hex(q.mrConfigId), composeHash: sha256Hex(appComposeOf(a) ?? ''), appId: appIdOf(a.event_log),
    });
  } catch (e) {
    checks.push({ id: 'quote.intel', label: 'Intel TDX quote: its signature chains to Intel’s root CA (dcap-qvl)', ok: false, detail: (e as Error).message });
  }
  if (!o.skipGpu) {
    const g = await gpuChecks(a.nvidia_payload, nonce, o.nras ?? nrasDirect);
    checks.push(...g.checks);
    measurements.gpus = g.gpus;
  }
  return { signingAddress: a.signing_address, ok: checks.every((c) => c.ok), checks, measurements };
}

export async function verifyReport(report: AttestationReport, model: string, nonce: string, o: VerifyOptions = {}): Promise<ModelVerification> {
  const candidates: Candidate[] = [];
  for (const a of report.model_attestations ?? []) candidates.push(await verifyCandidate(a, model, nonce, o));
  const trustedSigners = candidates.filter((c) => c.ok).map((c) => c.signingAddress.toLowerCase());
  return { model, nonce, at: Date.now(), ok: trustedSigners.length > 0, trustedSigners, candidates };
}

/** Picks a fresh nonce, fetches the model's report from NEAR AI Cloud and verifies every candidate. */
export async function attestModel(model: string, o: VerifyOptions = {}): Promise<ModelVerification> {
  const nonce = newNonce();
  return verifyReport(await fetchReport(model, nonce), model, nonce, o);
}
