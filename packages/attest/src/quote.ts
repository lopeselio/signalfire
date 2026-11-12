import dcap from '@phala/dcap-qvl';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { Check } from './types.ts';

// The Intel TDX quote, verified with Phala's dcap-qvl (the verifier docs.near.ai names): the quote's signature
// chains to Intel's root CA (built into dcap-qvl), against the TCB info and QE identity Intel signed. Collateral
// comes from Phala's PCCS (a cache of Intel's PCS that allows browsers); it is signed by Intel, so the cache
// can't forge it, only withhold it.

export const PCCS_URL = 'https://pccs.phala.network';
/** TCB statuses we accept: the signature chain verifies and the platform has no TD-relaunch or revocation advisory. */
export const TCB_OK = new Set(['UpToDate', 'SWHardeningNeeded', 'OutOfDate']);

export interface VerifiedQuote {
  status: string;
  advisories: string[];
  debug: boolean;
  reportData: Uint8Array;
  mrTd: Uint8Array;
  mrConfigId: Uint8Array;
  rtmr: Uint8Array[];
}

export type Collateral = Parameters<typeof dcap.verify>[1];

export async function fetchCollateral(quoteHex: string): Promise<Collateral> {
  return dcap.getCollateral(PCCS_URL, hexToBytes(quoteHex));
}

/** Verifies the quote against the collateral at `nowSecs`; throws if the signature chain or policy fails. */
export function verifyQuote(quoteHex: string, collateral: Collateral, nowSecs: number): VerifiedQuote {
  const v = dcap.verify(hexToBytes(quoteHex), collateral, nowSecs);
  if (v.report.type !== 'td10' && v.report.type !== 'td15') throw new Error(`not a TDX quote (${v.report.type})`);
  const d = v.report.data as unknown as Record<string, Uint8Array>;
  const u = (k: string): Uint8Array => new Uint8Array(d[k]);
  return {
    status: v.status,
    advisories: v.advisory_ids ?? [],
    debug: (u('tdAttributes')[0] & 1) === 1,
    reportData: u('reportData'),
    mrTd: u('mrTd'),
    mrConfigId: u('mrConfigId'),
    rtmr: [u('rtMr0'), u('rtMr1'), u('rtMr2'), u('rtMr3')],
  };
}

export function quoteChecks(q: VerifiedQuote): Check[] {
  return [
    { id: 'quote.intel', label: 'Intel TDX quote: its signature chains to Intel’s root CA (dcap-qvl)', ok: true, detail: `TCB ${q.status}${q.advisories.length ? `, advisories ${q.advisories.join(' ')}` : ''}` },
    { id: 'quote.tcb', label: 'The platform’s TCB status is acceptable (UpToDate, SWHardeningNeeded or OutOfDate)', ok: TCB_OK.has(q.status), detail: q.status },
    { id: 'quote.debug', label: 'The TEE is not in debug mode (its memory is closed to the host)', ok: !q.debug },
  ];
}

export const hex = bytesToHex;
