import { guardBrief, type Brief, type Dropped, type EvidenceItem } from '@signalfire/core';

// From the model's exact signed response to the brief the page shows. No I/O, so `pnpm verify-brief` runs the same
// code on the published response and must get the same brief.

/** The system prompt: the hard rules the model is told (and the guard enforces anyway). */
export const SYSTEM = [
  'You write a short research brief about the team behind a startup on Signalfire, a NEAR testnet app where startups have attention tokens.',
  'Attention tokens are not equity and not a claim on revenue. You never give advice.',
  'You are given ONLY evidence items, each with an id (E1, E2, ...). Rules:',
  '1. Use only the evidence given. Every line cites the ids it relies on in "cites". A line without a valid citation is deleted.',
  '2. "observed": facts exactly as the evidence states them, with the same numbers. No judgement words, no inference.',
  '3. "reading": your inference, worded as inference ("this suggests ...", "one reading is ..."), each tied to the facts it cites.',
  '4. "gaps": missing or weak evidence and red flags (for example no verified repository, a very new founder account, unproven links, missed campaigns, a demo startup run by the platform).',
  '5. "check": concrete things a person can check themselves, each pointing at a cited source.',
  '6. Never write buy, sell or hold advice, price talk or predictions. Never mention investing, returns, profit, equity, ownership or raising money. Such lines are deleted.',
  '7. Never use a number that is not in the cited evidence.',
  '8. Read the facts literally: "verified": 0 means nothing is proven; "claimed" means unproven; "signalfire_operator": true means the platform itself runs this startup. Do not put ids inside the text; put them only in "cites".',
  'Reply with JSON only: {"observed":[{"text":"...","cites":["E1"]}],"reading":[...],"gaps":[...],"check":[...]}.',
  'At most 6 observed, 4 reading, 5 gaps and 4 check lines; each text is one plain sentence under 200 characters.',
].join('\n');

export function replyText(response: string): string {
  try {
    const body = JSON.parse(response) as { choices?: { message?: { content?: string | null } }[] };
    return (body.choices?.[0]?.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  } catch { return ''; }
}
/** A reply cut off by the token limit: keep every complete {"text", "cites"} line, under the section it sits in. */
function salvage(text: string): unknown {
  const out: Record<string, { text: string; cites: string[] }[]> = {};
  const keys = [...text.matchAll(/"(observed|reading|gaps|check)"\s*:\s*\[/g)];
  keys.forEach((k, i) => {
    const part = text.slice(k.index! + k[0].length, keys[i + 1]?.index ?? text.length);
    out[k[1]] = [...part.matchAll(/\{\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"cites"\s*:\s*\[([^\]]*)\]\s*\}/g)].map((m) => ({
      text: JSON.parse(`"${m[1]}"`) as string,
      cites: [...m[2].matchAll(/"([^"]*)"/g)].map((c) => c[1]),
    }));
  });
  return keys.length ? out : null;
}
function firstJson(text: string): unknown {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return salvage(text);
  try { return JSON.parse(m[0]) as unknown; } catch { /* models often leave trailing commas */ }
  try { return JSON.parse(m[0].replace(/,(\s*[\]}])/g, '$1')) as unknown; } catch { return salvage(text); }
}
export function briefFrom(response: string, items: EvidenceItem[]): { brief: Brief; dropped: Dropped[]; parsed: boolean } {
  const raw = firstJson(replyText(response));
  return { ...guardBrief(raw, items), parsed: raw !== null };
}
