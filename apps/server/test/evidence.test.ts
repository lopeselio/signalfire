import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKey } from 'near-kit';
import { linkMessage, linkNonce, proofLine, signatureToB58, type LinkClaim } from '@signalfire/core';
import { checkProof, publishedByTarget } from '../src/evidence/proofs.ts';
import { briefFrom } from '../src/evidence/parse.ts';

// A founder link proof end to end, with GitHub, X and the RPC answered by stubs.
const hub = 'signalfire.testnet';
const founderKey = generateKey();
const otherKey = generateKey();
const claim: LinkClaim = { startup: 'glow', founder: 'alice.testnet', kind: 'github', target: 'alice/app' };
const sign = (c: LinkClaim, key = founderKey): string => {
  const message = linkMessage(c, hub);
  return signatureToB58(key.signNep413Message!(c.founder, { message, recipient: hub, nonce: linkNonce(message) }).signature);
};

function stub(o: { gistOwner?: string; text: string; keys?: { pk: string; full: boolean }[]; xAuthor?: string }): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    if (u.startsWith('https://api.github.com/gists/')) return new Response(JSON.stringify({ owner: { login: o.gistOwner ?? 'alice' }, files: { 'p.txt': { content: o.text } } }));
    if (u.startsWith('https://raw.githubusercontent.com/')) return new Response(o.text);
    if (u.startsWith('https://publish.x.com/oembed')) return new Response(JSON.stringify({ author_url: `https://x.com/${o.xAuthor}`, html: `<blockquote><p>${o.text}</p></blockquote>` }));
    // the RPC: view_access_key_list
    const keys = o.keys ?? [{ pk: founderKey.publicKey.toString(), full: true }];
    return new Response(JSON.stringify({ result: { keys: keys.map((k) => ({ public_key: k.pk, access_key: { permission: k.full ? 'FullAccess' : { FunctionCall: {} } } })) } }));
  }));
}
afterEach(() => vi.unstubAllGlobals());

describe('founder link proofs', () => {
  it('a gist by the repository owner with the founder’s signature verifies', async () => {
    stub({ text: `hello\n${proofLine(claim, sign(claim))}` });
    const r = await checkProof(claim, 'https://gist.github.com/alice/0123456789abcdef0123', hub);
    expect(r).toMatchObject({ ok: true, publicKey: founderKey.publicKey.toString() });
  });
  it('a file in the repository verifies', async () => {
    stub({ text: proofLine(claim, sign(claim)) });
    expect((await checkProof(claim, 'https://github.com/alice/app/blob/main/SIGNALFIRE.txt', hub)).ok).toBe(true);
  });
  it('a gist by someone else does not', async () => {
    stub({ gistOwner: 'mallory', text: proofLine(claim, sign(claim)) });
    expect((await checkProof(claim, 'https://gist.github.com/0123456789abcdef0123', hub)).error).toMatch(/gist by alice/);
  });
  it('a signature by a key the founder account does not have, or only as a function-call key, does not', async () => {
    stub({ text: proofLine(claim, sign(claim, otherKey)) });
    expect((await checkProof(claim, 'https://gist.github.com/0123456789abcdef0123', hub)).error).toMatch(/full-access key/);
    stub({ text: proofLine(claim, sign(claim)), keys: [{ pk: founderKey.publicKey.toString(), full: false }] });
    expect((await checkProof(claim, 'https://gist.github.com/0123456789abcdef0123', hub)).ok).toBe(false);
  });
  it('a proof for another startup does not count for this one', async () => {
    const other = { ...claim, startup: 'fern' };
    stub({ text: proofLine(other, sign(other)) });
    expect((await checkProof(claim, 'https://gist.github.com/0123456789abcdef0123', hub)).error).toMatch(/no signalfire-proof line/);
  });
  it('an X post must be by the handle', async () => {
    const x: LinkClaim = { ...claim, kind: 'x', target: 'alice_dev' };
    stub({ text: proofLine(x, sign(x)), xAuthor: 'alice_dev' });
    expect((await checkProof(x, 'https://x.com/alice_dev/status/1234567890', hub)).ok).toBe(true);
    stub({ text: proofLine(x, sign(x)), xAuthor: 'mallory' });
    expect((await checkProof(x, 'https://x.com/alice_dev/status/1234567890', hub)).ok).toBe(false);
  });
  it('only known hosts are fetched', async () => {
    stub({ text: '' });
    expect((await checkProof(claim, 'http://169.254.169.254/latest', hub)).error).toMatch(/gist URL/);
  });
  it('who may publish what', () => {
    const doc = (host: 'gist' | 'repo' | 'x', owner: string, repo?: string) => ({ host, owner, repo, text: '', url: '' });
    expect(publishedByTarget({ ...claim, target: 'alice' }, doc('repo', 'alice', 'alice/other'))).toBeNull();
    expect(publishedByTarget(claim, doc('repo', 'alice', 'alice/other'))).not.toBeNull();
    expect(publishedByTarget(claim, doc('x', 'alice'))).not.toBeNull();
  });
});

describe('reading the model’s reply', () => {
  const items = [{ id: 'E1', group: 'links' as const, kind: 'links', title: 'Links', facts: { verified: 0 }, source: { label: 's', url: 'u' }, fetchedAt: 1 }];
  const wrap = (content: string): string => JSON.stringify({ choices: [{ message: { content } }] });
  it('tolerates trailing commas', () => {
    expect(briefFrom(wrap('{"observed":[{"text":"There are 0 verified links.","cites":["E1"]},],}'), items).brief.observed).toHaveLength(1);
  });
  it('keeps the complete lines of a reply cut off by the token limit', () => {
    const b = briefFrom(wrap('{"observed":[{"text":"There are 0 verified links.","cites":["E1"]},{"text":"Cut off'), items);
    expect(b.parsed).toBe(true);
    expect(b.brief.observed).toEqual([{ text: 'There are 0 verified links.', cites: ['E1'] }]);
  });
});
