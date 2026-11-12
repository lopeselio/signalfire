import { isRepo, linkMessage, linkNonce, parseProofLines, type LinkClaim } from '@signalfire/core';
import { verifyNep413Signature } from 'near-kit';

// Checking a founder link's proof. Shared by the server (when a founder pastes a proof URL) and by
// `pnpm verify-brief` (which rechecks every verified link without trusting the server). Only these hosts are
// fetched: gists and raw files on GitHub, and an X post through X's public oEmbed endpoint.

const UA = { 'user-agent': 'signalfire-evidence (+https://github.com/lopeselio/signalfire)' };
export const RPCS = ['https://rpc.testnet.fastnear.com', 'https://test.rpc.fastnear.com', 'https://near-testnet.drpc.org'];

/** GitHub REST API, with GITHUB_TOKEN if one is set in the environment (never in the repo). */
export async function github(path: string): Promise<Response> {
  const token = process.env.GITHUB_TOKEN;
  return fetch(`https://api.github.com${path}`, {
    headers: { ...UA, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    signal: AbortSignal.timeout(15_000),
  });
}
export function githubError(r: Response): Error {
  if ((r.status === 403 || r.status === 429) && r.headers.get('x-ratelimit-remaining') === '0') return new Error('GitHub rate limit reached; try again within the hour');
  return new Error(`GitHub HTTP ${r.status}`);
}

/** Where a proof was published, and by whom according to the host. */
export interface ProofDoc { host: 'gist' | 'repo' | 'x'; owner: string; repo?: string; text: string; url: string }

export async function fetchProofDoc(url: string): Promise<ProofDoc> {
  const u = url.trim();
  let m = /^https:\/\/gist\.github\.com\/(?:[A-Za-z0-9-]{1,39}\/)?([0-9a-f]{20,40})\/?(?:#.*)?$/.exec(u);
  if (m) {
    const r = await github(`/gists/${m[1]}`);
    if (!r.ok) throw r.status === 404 ? new Error('no such gist') : githubError(r);
    const g = (await r.json()) as { owner?: { login?: string }; files?: Record<string, { content?: string }> };
    if (!g.owner?.login) throw new Error('the gist has no owner (anonymous gists prove nothing)');
    return { host: 'gist', owner: g.owner.login.toLowerCase(), text: Object.values(g.files ?? {}).map((f) => f.content ?? '').join('\n').slice(0, 100_000), url: u };
  }
  m = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\/blob\/([^/]{1,100})\/([^?#]{1,300})$/.exec(u)
    ?? /^https:\/\/raw\.githubusercontent\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\/([^/]{1,100})\/([^?#]{1,300})$/.exec(u);
  if (m) {
    const [, owner, repo, ref, path] = m;
    const r = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`, { headers: UA, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(r.status === 404 ? 'no such file in that repository (is it public and pushed?)' : `GitHub HTTP ${r.status}`);
    return { host: 'repo', owner: owner.toLowerCase(), repo: `${owner}/${repo}`.toLowerCase(), text: (await r.text()).slice(0, 100_000), url: u };
  }
  m = /^https:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d{5,25})(?:[/?#].*)?$/.exec(u);
  if (m) {
    const post = `https://x.com/${m[1]}/status/${m[2]}`;
    let author: string | undefined;
    let text = '';
    const r = await fetch(`https://publish.x.com/oembed?url=${encodeURIComponent(post)}&omit_script=1&dnt=true`, { headers: UA, signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (r?.ok) {
      const o = (await r.json()) as { author_url?: string; html?: string };
      author = /(?:twitter|x)\.com\/([A-Za-z0-9_]{1,15})\/?$/.exec(o.author_url ?? '')?.[1];
      text = (o.html ?? '').replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    } else {
      // X's embed data for the same post, when oEmbed refuses
      const s = await fetch(`https://cdn.syndication.twimg.com/tweet-result?id=${m[2]}&token=4`, { headers: UA, signal: AbortSignal.timeout(15_000) }).catch(() => null);
      if (!s?.ok) throw new Error(r?.status === 404 ? 'X says there is no such public post' : 'X did not return the post; try again');
      const t = (await s.json()) as { text?: string; user?: { screen_name?: string } };
      author = t.user?.screen_name;
      text = t.text ?? '';
    }
    if (!author) throw new Error('X did not say who wrote the post');
    return { host: 'x', owner: author.toLowerCase(), text, url: u };
  }
  throw new Error('use a GitHub gist URL, a file in the repository (github.com/<owner>/<repo>/blob/…), or an X post URL');
}

/** Does the place the proof was published belong to the linked account? */
export function publishedByTarget(c: LinkClaim, d: ProofDoc): string | null {
  if (c.kind === 'x') return d.host === 'x' && d.owner === c.target ? null : `the post must be by @${c.target}`;
  if (d.host === 'x') return 'a GitHub link is proven by a gist or a file in the repository, not an X post';
  const owner = c.target.split('/')[0];
  if (isRepo(c.target)) {
    if (d.host === 'repo' && d.repo === c.target) return null;
    if (d.host === 'gist' && d.owner === owner) return null;
    return `publish it as a file in ${c.target}, or as a gist by ${owner}`;
  }
  return d.owner === owner ? null : `publish it as a gist by ${owner}, or as a file in one of ${owner}'s repositories`;
}

/** The founder account's full-access keys, read over public RPC. */
export async function fullAccessKeys(account: string): Promise<string[]> {
  let last: unknown;
  for (const rpc of RPCS) {
    try {
      const r = (await (await fetch(rpc, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'view_access_key_list', finality: 'final', account_id: account } }),
      })).json()) as { result?: { keys: { public_key: string; access_key: { permission: unknown } }[] }; error?: unknown };
      if (r.result) return r.result.keys.filter((k) => k.access_key.permission === 'FullAccess').map((k) => k.public_key);
      last = new Error(JSON.stringify(r.error).slice(0, 160));
    } catch (e) { last = e; }
  }
  throw last;
}

/** Which of `keys` signed this claim's message (NEP-413, recipient = the hub), or null. */
export async function signerOf(c: LinkClaim, signatureB58: string, hub: string, keys: string[]): Promise<string | null> {
  const message = linkMessage(c, hub);
  const nonce = linkNonce(message);
  for (const publicKey of keys) {
    if (await verifyNep413Signature({ accountId: c.founder, publicKey, signature: `ed25519:${signatureB58}` }, { message, recipient: hub, nonce }, { maxAge: Infinity })) return publicKey;
  }
  return null;
}

export interface ProofResult { ok: boolean; error?: string; message: string; signature?: string; publicKey?: string }

/** Fetch the proof, find the line for this claim, check where it was published and who signed it. */
export async function checkProof(c: LinkClaim, url: string, hub: string): Promise<ProofResult> {
  const message = linkMessage(c, hub);
  let doc: ProofDoc;
  try { doc = await fetchProofDoc(url); } catch (e) { return { ok: false, message, error: (e as Error).message }; }
  const line = parseProofLines(doc.text).find((p) => p.startup === c.startup && p.founder === c.founder && p.kind === c.kind && p.target === c.target);
  if (!line) return { ok: false, message, error: 'no signalfire-proof line for this link at that URL (copy the whole line)' };
  const where = publishedByTarget(c, doc);
  if (where) return { ok: false, message, signature: line.signature, error: where };
  const keys = await fullAccessKeys(c.founder).catch(() => null);
  if (!keys) return { ok: false, message, signature: line.signature, error: 'could not read the founder account’s keys; try again' };
  const publicKey = await signerOf(c, line.signature, hub, keys);
  if (!publicKey) return { ok: false, message, signature: line.signature, error: `the signature does not check against any full-access key of ${c.founder}` };
  return { ok: true, message, signature: line.signature, publicKey };
}
