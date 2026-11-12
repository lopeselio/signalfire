import { sha256, sha384 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import type { Check, ModelAttestation, TeeEvent } from './types.ts';

// Checks on what a verified TDX quote binds, following docs.near.ai
// "Quote, Nonce, and Signer Bindings" (cloud/verification/reference/quote-nonce-signer).

export const sha256Hex = (s: string | Uint8Array): string => bytesToHex(sha256(typeof s === 'string' ? utf8ToBytes(s) : s));
const hex = (s: string): Uint8Array => hexToBytes(s.replace(/^0x/i, ''));
const eq = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

const asJson = <T>(v: T | string): T => (typeof v === 'string' ? (JSON.parse(v) as T) : v);

/** The raw `app_compose` string (hash it as is, never re-serialised). */
export function appComposeOf(a: ModelAttestation): string | undefined {
  return asJson(a.info.tcb_info as { app_compose?: string } | string).app_compose;
}

/**
 * Replays the IMR 3 events: digest = SHA-384(event_type u32 LE ‖ ":" ‖ event ‖ ":" ‖ payload bytes),
 * RTMR3 = SHA-384(RTMR3 ‖ digest) from 48 zero bytes. Throws if an event's stated digest is wrong.
 */
export function replayRtmr3(log: TeeEvent[] | string): Uint8Array {
  let rtmr: Uint8Array = new Uint8Array(48);
  for (const e of asJson(log)) {
    if (e.imr !== 3) continue;
    const t = new Uint8Array(4);
    new DataView(t.buffer).setUint32(0, e.event_type >>> 0, true);
    const digest = sha384(concatBytes(t, utf8ToBytes(':'), utf8ToBytes(e.event), utf8ToBytes(':'), hex(e.event_payload ?? '')));
    if (e.digest && !eq(hex(e.digest), digest)) throw new Error(`digest mismatch for event ${e.event}`);
    rtmr = sha384(concatBytes(rtmr, digest));
  }
  return rtmr;
}

/** The app id the TEE booted, as the event log records it (payload of the `app-id` event). */
export function appIdOf(log: TeeEvent[] | string): string | undefined {
  return asJson(log).find((e) => e.imr === 3 && e.event === 'app-id')?.event_payload;
}

/** Report data (64 bytes) = signing address zero-padded to 32 bytes ‖ the client nonce (no TLS binding). */
export function bindingChecks(reportData: Uint8Array, a: ModelAttestation, nonce: string): Check[] {
  const id = hex(a.signing_address);
  const want = { ecdsa: 20, ed25519: 32 }[a.signing_algo];
  const padded = new Uint8Array(32);
  padded.set(id.subarray(0, 32));
  return [
    {
      id: 'binding.signer',
      label: 'The signing key was made inside this TEE (its address is bound in the quote’s report data)',
      ok: want === id.length && eq(reportData.subarray(0, 32), padded),
      detail: a.signing_address,
    },
    { id: 'binding.nonce', label: 'The quote is fresh: its report data holds the nonce this check just picked', ok: eq(reportData.subarray(32, 64), hex(nonce)) },
    { id: 'binding.echo', label: 'The report echoes the same nonce (request_nonce)', ok: a.request_nonce.toLowerCase() === nonce.toLowerCase() },
  ];
}

/** MRCONFIGID = 0x01 ‖ sha256(app_compose) ‖ 15 zero bytes: which container configuration the TEE booted. */
export function composeCheck(mrConfigId: Uint8Array, a: ModelAttestation): Check {
  const compose = appComposeOf(a);
  if (!compose) return { id: 'compose', label: 'The container configuration matches the quote (MRCONFIGID)', ok: false, detail: 'no app_compose in the report' };
  const h = sha256(utf8ToBytes(compose));
  return {
    id: 'compose',
    label: 'The container configuration (app_compose) hashes to the quote’s MRCONFIGID',
    ok: eq(mrConfigId, concatBytes(new Uint8Array([1]), h, new Uint8Array(15))),
    detail: `sha256 ${bytesToHex(h)}`,
  };
}

export function rtmr3Check(rtmr3: Uint8Array, a: ModelAttestation): Check {
  try {
    const got = replayRtmr3(a.event_log);
    return { id: 'rtmr3', label: 'The runtime event log replays to the quote’s RTMR3 (app id, compose hash, keys)', ok: eq(got, rtmr3), detail: bytesToHex(got).slice(0, 24) + '…' };
  } catch (e) {
    return { id: 'rtmr3', label: 'The runtime event log replays to the quote’s RTMR3', ok: false, detail: (e as Error).message };
  }
}
