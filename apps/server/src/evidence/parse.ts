import { contradictsProfile, evidencePrompt, guardBrief, profilePrompt, type Brief, type Dropped, type EvidenceItem, type ProfileCheck } from '@signalfire/core';

// From the model's exact signed response to the brief the page shows. No I/O, so `pnpm verify-brief` runs the same
// code on the published response and must get the same brief.

const line = { type: 'object', properties: { text: { type: 'string', maxLength: 220 }, cites: { type: 'array', items: { type: 'string', pattern: '^E[0-9]{1,3}$' }, minItems: 1, maxItems: 4 } }, required: ['text', 'cites'], additionalProperties: false };
const lines = (min: number, max: number) => ({ type: 'array', items: line, minItems: min, maxItems: max });
/** Structured output (guided decoding): the reply is always this JSON shape, with bounded sections, so it can't run on. */
export const RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: { name: 'research_brief', strict: true, schema: { type: 'object', properties: { observed: lines(3, 6), reading: lines(1, 4), gaps: lines(2, 5), check: lines(2, 4) }, required: ['observed', 'reading', 'gaps', 'check'], additionalProperties: false } },
};

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
  '3 to 6 observed, 1 to 4 reading, 2 to 5 gaps and 2 to 4 check lines; pick the most important points and never repeat one; each text is one plain sentence under 200 characters.',
].join('\n');

export function replyText(response: string): string {
  try {
    const body = JSON.parse(response) as { choices?: { message?: { content?: string | null } }[] };
    return (body.choices?.[0]?.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  } catch { return ''; }
}
/**
 * A reply that isn't valid JSON (cut off by the token limit, or a missing brace or "text" key): keep every complete
 * "<text>", "cites": [...] pair, under the section it sits in.
 */
function salvage(text: string): unknown {
  const out: Record<string, { text: string; cites: string[] }[]> = {};
  const keys = [...text.matchAll(/"(observed|reading|gaps|check)"\s*:\s*\[/g)];
  keys.forEach((k, i) => {
    const part = text.slice(k.index! + k[0].length, keys[i + 1]?.index ?? text.length);
    out[k[1]] = [...part.matchAll(/(?:"text"\s*:\s*)?"((?:[^"\\]|\\.)*)"\s*,\s*"cites"\s*:\s*\[([^\]]*)\]/g)].map((m) => ({
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
/** With a profile check (briefs written since rule profile-check/1), a line naming another strength is dropped too. */
export function briefFrom(response: string, items: EvidenceItem[], profile?: ProfileCheck | null): { brief: Brief; dropped: Dropped[]; parsed: boolean } {
  const raw = firstJson(replyText(response));
  return { ...guardBrief(raw, items, profile ? { contradicts: (t) => contradictsProfile(t, profile) } : {}), parsed: raw !== null };
}

/** The user message: the evidence, then (since profile-check/1) the rule-computed profile check as facts with ids. */
export const briefPrompt = (startup: { id: string; name: string }, items: EvidenceItem[], profile?: ProfileCheck | null): string =>
  profile ? `${evidencePrompt(startup, items)}\n\n${profilePrompt(profile)}` : evidencePrompt(startup, items);
