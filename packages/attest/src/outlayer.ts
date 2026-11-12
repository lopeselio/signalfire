import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { sha256Hex } from './measure.ts';
import { fetchCollateral, quoteChecks, verifyQuote, type Collateral } from './quote.ts';
import type { Check } from './types.ts';

// An OutLayer run's attestation (docs: app.outlayer.ai/docs/tee-attestation; code: out-layer/outlayer
// worker/src/tdx_attestation.rs). The worker that ran the job produces an Intel TDX quote whose report data's first
// 32 bytes are the task hash: sha256 of the task's type, id, code (wasm sha256), input and output hashes, block
// height, caller, timestamp and attached payment. We check, in a browser or Node:
//   the quote chains to Intel (dcap-qvl) and isn't a debug TD;
//   the report data is exactly the task hash recomputed from the published fields;
//   the code is the wasm we expect, the input and output are exactly the bytes the hub sent and kept, the caller is the hub;
//   the worker's five measurements (MRTD, RTMR0-3) are on OutLayer's onchain allowlist (worker.outlayer.testnet).

export const OUTLAYER_API_TESTNET = 'https://testnet-api.outlayer.ai';
export const OUTLAYER_REGISTER_TESTNET = 'worker.outlayer.testnet';

export interface OutlayerAttestation {
  task_id: string; task_type: string; tdx_quote: string; worker_measurement?: string;
  request_id?: string; caller_account_id?: string; transaction_hash?: string; block_height?: string;
  repo_url?: string; commit_hash?: string; build_target?: string; wasm_hash?: string; executed_wasm_sha256?: string;
  input_hash?: string; output_hash: string; project_id?: string; secrets_ref?: string; attached_usd?: string; timestamp?: string;
}

export async function fetchOutlayerAttestation(requestId: number | string, api = OUTLAYER_API_TESTNET): Promise<OutlayerAttestation> {
  const res = await fetch(`${api}/attestations/by-request/${requestId}`);
  if (!res.ok) throw new Error(`OutLayer attestation ${requestId}: HTTP ${res.status}`);
  return (await res.json()) as OutlayerAttestation;
}

const le64 = (n: bigint): Uint8Array => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt.asUintN(64, n), true);
  return b;
};
const s = (v?: string): Uint8Array[] => (v ? [utf8ToBytes(v)] : []);

/** The worker's task hash (V1): the 32 bytes it puts in the quote's report data. */
export function outlayerTaskHash(a: OutlayerAttestation): string {
  const parts = [
    utf8ToBytes(a.task_type), le64(BigInt(a.task_id)), ...s(a.repo_url), ...s(a.commit_hash), ...s(a.build_target), ...s(a.wasm_hash),
    ...s(a.input_hash), utf8ToBytes(a.output_hash), ...(a.block_height ? [le64(BigInt(a.block_height))] : []), ...s(a.caller_account_id),
    ...s(a.project_id), ...s(a.secrets_ref), le64(BigInt(a.timestamp ?? '0')), ...s(a.attached_usd),
  ];
  return bytesToHex(sha256(concatBytes(...parts)));
}

export interface OutlayerMeasurements { mrtd: string; rtmr0: string; rtmr1: string; rtmr2: string; rtmr3: string }

export interface OutlayerExpect {
  wasmHash: string;
  /** the exact input_data the caller sent, and the exact output it got back */
  input: string;
  output: string;
  caller: string;
  /** asks OutLayer's register contract whether these five measurements are approved */
  approved: (m: OutlayerMeasurements) => Promise<boolean>;
  collateral?: (quoteHex: string) => Promise<Collateral>;
  nowSecs?: number;
}

export async function verifyOutlayerRun(a: OutlayerAttestation, e: OutlayerExpect): Promise<{ checks: Check[]; measurements: OutlayerMeasurements | null }> {
  const checks: Check[] = [];
  const quoteHex = bytesToHex(Uint8Array.from(atob(a.tdx_quote), (c) => c.charCodeAt(0)));
  let measurements: OutlayerMeasurements | null = null;
  try {
    const q = verifyQuote(quoteHex, await (e.collateral ?? fetchCollateral)(quoteHex), e.nowSecs ?? Math.floor(Date.now() / 1000));
    checks.push(...quoteChecks(q));
    const want = outlayerTaskHash(a);
    checks.push({ id: 'ol.task', label: 'The quote’s report data is the task hash of this run (code, input, output, caller, block, time)', ok: bytesToHex(q.reportData.subarray(0, 32)) === want && q.reportData.subarray(32).every((b) => b === 0), detail: want.slice(0, 24) + '…' });
    measurements = { mrtd: bytesToHex(q.mrTd), rtmr0: bytesToHex(q.rtmr[0]), rtmr1: bytesToHex(q.rtmr[1]), rtmr2: bytesToHex(q.rtmr[2]), rtmr3: bytesToHex(q.rtmr[3]) };
    let approved = false;
    try { approved = await e.approved(measurements); } catch { /* fails below */ }
    checks.push({ id: 'ol.measurements', label: 'The worker’s five TDX measurements are on OutLayer’s onchain allowlist (worker.outlayer.testnet)', ok: approved, detail: `MRTD ${measurements.mrtd.slice(0, 16)}…` });
  } catch (err) {
    checks.push({ id: 'quote.intel', label: 'Intel TDX quote: its signature chains to Intel’s root CA (dcap-qvl)', ok: false, detail: (err as Error).message });
  }
  checks.push(
    { id: 'ol.code', label: 'It ran exactly the scorer’s wasm (sha256)', ok: a.wasm_hash === e.wasmHash && (a.executed_wasm_sha256 ?? a.wasm_hash) === e.wasmHash, detail: e.wasmHash.slice(0, 16) + '…' },
    { id: 'ol.input', label: 'Its input is exactly what the hub sent (sha256)', ok: a.input_hash === sha256Hex(e.input) },
    { id: 'ol.output', label: 'Its output is exactly what the hub accepted (sha256)', ok: a.output_hash === sha256Hex(e.output) },
    { id: 'ol.caller', label: `The run was requested by ${e.caller}`, ok: a.caller_account_id === e.caller },
  );
  return { checks, measurements };
}
