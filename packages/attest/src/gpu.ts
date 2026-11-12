import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Check } from './types.ts';

// NVIDIA GPU evidence (docs.near.ai: "Verify GPU evidence when present"). The payload goes to NVIDIA's
// attestation service (NRAS) unchanged; NRAS answers with JWTs it signs. We check every JWT's signature
// against NVIDIA's published keys, so whoever carried the answer (our server relays it for browsers, because
// NRAS refuses browser origins) can't forge a PASS, and each JWT must carry this check's nonce.

export const NRAS_URL = 'https://nras.attestation.nvidia.com/v3/attest/gpu';
export const NRAS_ISSUER = 'https://nras.attestation.nvidia.com';
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

/** Sends the GPU payload to NRAS and returns its raw JSON answer. Browsers pass a relay instead. */
export type NrasPost = (payloadJson: string) => Promise<unknown>;
export const nrasDirect: NrasPost = async (payloadJson) => {
  const res = await fetch(NRAS_URL, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: payloadJson });
  if (!res.ok) throw new Error(`NRAS HTTP ${res.status}`);
  return res.json();
};

export async function gpuChecks(payloadJson: string | undefined, nonce: string, post: NrasPost): Promise<{ checks: Check[]; gpus: string[] }> {
  if (!payloadJson) return { checks: [{ id: 'gpu', label: 'GPU evidence is present', ok: false, detail: 'no nvidia_payload' }], gpus: [] };
  const checks: Check[] = [];
  const payload = JSON.parse(payloadJson) as { nonce?: string };
  checks.push({ id: 'gpu.nonce', label: 'The GPU evidence was made for this check’s nonce', ok: payload.nonce?.toLowerCase() === nonce.toLowerCase() });
  if (!checks[0].ok) return { checks, gpus: [] };
  let answer: [[string, string], Record<string, string>];
  try {
    answer = (await post(payloadJson)) as typeof answer;
  } catch (e) {
    checks.push({ id: 'gpu.nras', label: 'NVIDIA’s attestation service judged the GPUs', ok: false, detail: (e as Error).message });
    return { checks, gpus: [] };
  }
  jwks ??= createRemoteJWKSet(new URL(`${NRAS_ISSUER}/.well-known/jwks.json`));
  const verify = async (jwt: string): Promise<JWTPayload | Error> => {
    try { return (await jwtVerify(jwt, jwks!, { issuer: NRAS_ISSUER })).payload; } catch (e) { return e as Error; }
  };
  const overall = await verify(answer?.[0]?.[1] ?? '');
  checks.push({
    id: 'gpu.overall',
    label: 'NVIDIA signed an overall PASS for the GPUs (JWT checked against NVIDIA’s keys)',
    ok: !(overall instanceof Error) && overall['x-nvidia-overall-att-result'] === true && String(overall.eat_nonce).toLowerCase() === nonce.toLowerCase(),
    detail: overall instanceof Error ? overall.message : undefined,
  });
  const gpus: string[] = [];
  for (const [gpu, jwt] of Object.entries(answer?.[1] ?? {})) {
    const c = await verify(jwt);
    const fails: string[] = [];
    if (c instanceof Error) fails.push(c.message);
    else {
      if (String(c.eat_nonce).toLowerCase() !== nonce.toLowerCase()) fails.push('nonce');
      if (c.secboot !== true) fails.push('secure boot off');
      if (c.dbgstat !== 'disabled') fails.push('debug on');
      if (c.measres !== 'success') fails.push('measurements');
      gpus.push(String(c.hwmodel ?? gpu));
    }
    checks.push({ id: `gpu.${gpu}`, label: `${gpu}: secure boot on, debug off, measurements match NVIDIA’s reference`, ok: fails.length === 0, detail: fails.join(', ') || String((c as JWTPayload).hwmodel ?? '') });
  }
  if (gpus.length === 0) checks.push({ id: 'gpu.count', label: 'NVIDIA reported at least one GPU', ok: false });
  return { checks, gpus };
}
