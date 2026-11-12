/** One line of a verification: what was checked, whether it held, and the evidence behind it. */
export interface Check {
  id: string;
  label: string;
  ok: boolean;
  detail?: string;
}

/** One RTMR event of a dstack TEE's event log. */
export interface TeeEvent {
  imr: number;
  event_type: number;
  digest?: string;
  event: string;
  event_payload?: string;
}

/** One `model_attestations[]` candidate of `GET /v1/attestation/report` (the fields we verify). */
export interface ModelAttestation {
  model_name: string;
  signing_address: string;
  signing_algo: string;
  request_nonce: string;
  intel_quote: string;
  nvidia_payload?: string;
  event_log: TeeEvent[] | string;
  info: { tcb_info: string | { app_compose?: string; [k: string]: unknown }; app_id?: string; [k: string]: unknown };
}

export interface AttestationReport {
  model_attestations?: ModelAttestation[];
}

/** What the quote measured, shown to people next to the checks. */
export interface Measurements {
  tcbStatus: string;
  advisories: string[];
  mrTd: string;
  rtmr0: string;
  rtmr1: string;
  rtmr2: string;
  rtmr3: string;
  mrConfigId: string;
  composeHash: string;
  appId?: string;
  gpus: string[];
}

export interface Candidate {
  signingAddress: string;
  ok: boolean;
  checks: Check[];
  measurements: Partial<Measurements>;
}

export interface ModelVerification {
  model: string;
  nonce: string;
  /** ms since epoch, when the check ran */
  at: number;
  ok: boolean;
  /** lowercase signing addresses whose candidate passed every check */
  trustedSigners: string[];
  candidates: Candidate[];
}

/** A NEAR AI reply as Signalfire keeps it (apps/server/src/nearai.ts `Signed`). */
export interface SignedReply {
  model: string;
  request: string;
  response: string;
  signedText?: string;
  signature?: string;
  signingAddress?: string;
}
