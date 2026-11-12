import { randomBytes } from 'node:crypto';
import { attestModel, clientKey, openReply, sealForModel } from '@signalfire/attest';
import { config } from './config.ts';

// NEAR AI Cloud (TEE-hosted models). Every reply is kept with its exact request/response bytes and the
// enclave's signature, so anyone can check later that the text wasn't altered (`pnpm verify`).
// The model writes vetting reports and pitches. It never decides money, admission or a winner.

export interface Signed {
  who: string;
  /** what the model said (or the fallback, when NEAR AI is off) */
  text: string;
  model: string;
  request: string;
  response: string;
  signedText?: string;
  signature?: string;
  signingAddress?: string;
  /** 'ed25519' when the request was end-to-end encrypted (the reply is then signed with the model's Ed25519 key) */
  signingAlgo?: string;
  /** end-to-end encrypted: the model key the request was sealed to, and the one-off client secret the reply was
   *  encrypted to. The client secret is published so anyone can open the reply; it opens nothing in the request. */
  e2ee?: { modelPub: string; clientSecret: string };
  at: number;
}

export const nearAiEnabled = (): boolean => config.nearAi.apiKey.length > 0;
const headers = (): Record<string, string> => ({ authorization: `Bearer ${config.nearAi.apiKey}`, 'content-type': 'application/json' });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Asks the TEE model. Falls back to `fallback` (unsigned, model "none") if NEAR AI is off or fails. */
export async function ask(who: string, system: string, user: string, fallback: string, maxTokens = 220, timeoutMs = 20_000, temperature = 0.7): Promise<Signed> {
  const model = config.nearAi.model;
  const at = Date.now();
  if (!nearAiEnabled()) return { who, text: fallback, model: 'none', request: '', response: '', at };
  const request = JSON.stringify({
    model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    max_tokens: maxTokens,
    temperature,
    chat_template_kwargs: { enable_thinking: false },
  });
  try {
    const res = await fetch(`${config.nearAi.baseUrl}/chat/completions`, { method: 'POST', headers: headers(), body: request, signal: AbortSignal.timeout(timeoutMs) });
    const response = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = JSON.parse(response) as { id: string; choices: { message: { content: string | null } }[] };
    const text = (body.choices[0]?.message.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim() || fallback;
    const out: Signed = { who, text, model, request, response, at };
    for (let attempt = 0; attempt < 6; attempt++) {
      const r = await fetch(`${config.nearAi.baseUrl}/signature/${encodeURIComponent(body.id)}?model=${encodeURIComponent(model)}&signing_algo=ecdsa`, { headers: headers() });
      if (r.ok) {
        const sig = (await r.json()) as { text?: string; signature?: string; signing_address?: string };
        if (sig.signature) { out.signedText = sig.text; out.signature = sig.signature; out.signingAddress = sig.signing_address; break; }
      }
      await sleep(500 * (attempt + 1));
    }
    return out;
  } catch (e) {
    console.warn(`NEAR AI for ${who}: ${(e as Error).message}`);
    return { who, text: fallback, model: 'none', request: '', response: '', at };
  }
}

/** Pulls the first JSON object out of a model reply. */
export function jsonFrom<T>(text: string): T | null {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return null;
  try { return JSON.parse(m[0]) as T; } catch { return null; }
}

/** The model's TEE attestation, bound to a fresh nonce. */
export async function attestation(): Promise<{ nonce: string; model: string; report: unknown } | null> {
  if (!nearAiEnabled()) return null;
  const nonce = randomBytes(32).toString('hex');
  const model = config.nearAi.model;
  const res = await fetch(`${config.nearAi.baseUrl}/attestation/report?model=${encodeURIComponent(model)}&signing_algo=ecdsa&nonce=${nonce}`, { headers: headers() });
  if (!res.ok) return null;
  return { nonce, model, report: await res.json() };
}

/**
 * The model's Ed25519 key that requests are sealed to, taken only from a report this server just verified
 * (fresh nonce, Intel quote, bindings, RTMR3, GPUs). Browsers verify it again themselves before sealing.
 */
let e2eeKey: { key: string; at: number } | null = null;
export async function modelE2eeKey(): Promise<string> {
  if (e2eeKey && Date.now() - e2eeKey.at < 10 * 60_000) return e2eeKey.key;
  const v = await attestModel(config.nearAi.model, { algo: 'ed25519' });
  if (!v.ok || v.trustedSigners.length !== 1) throw new Error('no single verified Ed25519 model key');
  e2eeKey = { key: v.trustedSigners[0].replace(/^0x/, ''), at: Date.now() };
  return e2eeKey.key;
}

/**
 * Asks the TEE model with every message end-to-end encrypted: the system prompt and public text are sealed here,
 * `sealedPrivate` was sealed in the applicant's browser (this server can't read it). The reply comes back
 * encrypted to a one-off client key, which we open for the verdict and publish with the proof.
 */
export async function askPrivate(who: string, system: string, user: string, sealedPrivate: string, modelPub: string, responseFormat: unknown, maxTokens = 120): Promise<Signed> {
  const model = config.nearAi.model;
  const at = Date.now();
  const client = clientKey();
  const request = JSON.stringify({
    model,
    messages: [
      { role: 'system', content: sealForModel(system, modelPub).hex },
      { role: 'user', content: sealForModel(user, modelPub).hex },
      { role: 'user', content: sealedPrivate },
    ],
    max_tokens: maxTokens,
    temperature: 0.2,
    response_format: responseFormat,
    stream: false,
    chat_template_kwargs: { enable_thinking: false },
  });
  const res = await fetch(`${config.nearAi.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { ...headers(), 'X-Signing-Algo': 'ed25519', 'X-Client-Pub-Key': client.pub, 'X-Model-Pub-Key': modelPub, 'X-Encryption-Version': '2', 'x-no-aliasing': 'true' },
    body: request,
    signal: AbortSignal.timeout(30_000),
  });
  const response = await res.text();
  if (!res.ok) throw new Error(`NEAR AI (encrypted) HTTP ${res.status}: ${response.slice(0, 120)}`);
  const body = JSON.parse(response) as { id: string; choices: { message: { content: string | null } }[] };
  const sealed = body.choices[0]?.message.content ?? '';
  const text = (sealed ? openReply(sealed, client.secret) : '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (!text) throw new Error('empty encrypted reply');
  const out: Signed = { who, text, model, request, response, signingAlgo: 'ed25519', e2ee: { modelPub, clientSecret: client.secret }, at };
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch(`${config.nearAi.baseUrl}/signature/${encodeURIComponent(body.id)}?model=${encodeURIComponent(model)}&signing_algo=ed25519`, { headers: headers() });
    if (r.ok) {
      const sig = (await r.json()) as { text?: string; signature?: string; signing_address?: string };
      if (sig.signature) { out.signedText = sig.text; out.signature = sig.signature; out.signingAddress = sig.signing_address; break; }
    }
    await sleep(500 * (attempt + 1));
  }
  return out;
}
