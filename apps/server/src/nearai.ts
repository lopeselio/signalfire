import { randomBytes } from 'node:crypto';
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
  at: number;
}

export const nearAiEnabled = (): boolean => config.nearAi.apiKey.length > 0;
const headers = (): Record<string, string> => ({ authorization: `Bearer ${config.nearAi.apiKey}`, 'content-type': 'application/json' });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Asks the TEE model. Falls back to `fallback` (unsigned, model "none") if NEAR AI is off or fails. */
export async function ask(who: string, system: string, user: string, fallback: string, maxTokens = 220): Promise<Signed> {
  const model = config.nearAi.model;
  const at = Date.now();
  if (!nearAiEnabled()) return { who, text: fallback, model: 'none', request: '', response: '', at };
  const request = JSON.stringify({
    model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    max_tokens: maxTokens,
    temperature: 0.7,
    chat_template_kwargs: { enable_thinking: false },
  });
  try {
    const res = await fetch(`${config.nearAi.baseUrl}/chat/completions`, { method: 'POST', headers: headers(), body: request, signal: AbortSignal.timeout(20_000) });
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
