import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LIMITS, badgeOf, cleanText, cleanUrl, discussRoute, rolesFrom, type Deps, type Roles } from '../src/discuss.ts';

// The campaign discussion and content links: auth, permissions, limits, URL checks and hiding, against a temp DATA_DIR.

const roles: Roles = { startup: 'glow', founder: 'founder.testnet', winner: 'maker.testnet', phase: 'funded', holders: ['holder.testnet'] };
let dir = '';
let clock = 1_000_000;
let r: Roles = roles;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'discuss-')); clock = 1_000_000; r = roles; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const deps = (me: string | null, o: Partial<Deps> = {}): Deps => ({
  dataDir: dir, roles: async (id) => (id === 7 ? r : null), me: async () => me, writes: true, origin: 'https://signalfire.example', now: () => clock, ...o,
});

async function call(path: string, o: { me?: string | null; body?: unknown; method?: string; headers?: Record<string, string>; deps?: Partial<Deps> } = {}): Promise<{ code: number; body: any }> {
  const raw = o.body === undefined ? '' : typeof o.body === 'string' ? o.body : JSON.stringify(o.body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []) as unknown as IncomingMessage;
  req.method = o.method ?? (o.body === undefined ? 'GET' : 'POST');
  req.headers = { 'content-type': 'application/json', ...o.headers };
  let code = 0;
  let out = '';
  const res = { writeHead(c: number) { code = c; return res; }, end(s: string) { out = s; } } as unknown as ServerResponse;
  const handled = await discussRoute(req, res, path, deps(o.me === undefined ? 'someone.testnet' : o.me, o.deps));
  if (!handled) return { code: -1, body: null };
  return { code, body: JSON.parse(out) };
}
const comment = (text: unknown, me: string | null = 'someone.testnet') => call('/api/campaign/7/discussion/comment', { me, body: { text } });
const thread = async () => (await call('/api/campaign/7/discussion')).body;

describe('validation', () => {
  it('accepts http(s) links only, with a real host and no login', () => {
    expect(cleanUrl('https://youtube.com/watch?v=abc')).toEqual({ ok: true, url: 'https://youtube.com/watch?v=abc' });
    expect(cleanUrl('http://x.com/a/status/1').ok).toBe(true);
    for (const bad of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'ftp://x.com/a', 'https://user:pw@x.com/', 'https://localhost/', 'https://x.com/a b', 'https://x.com/"onmouseover=1', '//x.com/a', 'x.com', '', 42, `https://x.com/${'a'.repeat(LIMITS.url)}`]) {
      expect(cleanUrl(bad).ok, String(bad)).toBe(false);
    }
  });
  it('keeps comments plain: strips control and direction-override characters, caps length', () => {
    expect(cleanText(`  hi${String.fromCharCode(0x202e)}evil${String.fromCharCode(7)} \r\n\n\n\nthere `, 500, 'c')).toEqual({ ok: true, text: 'hievil \n\nthere' });
    expect(cleanText('<script>alert(1)</script>', 500, 'c')).toEqual({ ok: true, text: '<script>alert(1)</script>' }); // stored as text; the page never renders HTML
    expect(cleanText('   ', 500, 'c').ok).toBe(false);
    expect(cleanText('x'.repeat(501), 500, 'c').ok).toBe(false);
    expect(cleanText('x'.repeat(500), 500, 'c').ok).toBe(true);
    expect(cleanText(['x'], 500, 'c').ok).toBe(false);
  });
  it('badges: winner Creator, founder Founder, holders Holder, others none', () => {
    expect(badgeOf('maker.testnet', roles)).toBe('Creator');
    expect(badgeOf('founder.testnet', roles)).toBe('Founder');
    expect(badgeOf('holder.testnet', roles)).toBe('Holder');
    expect(badgeOf('someone.testnet', roles)).toBe(null);
  });
  it('roles come from the hub snapshot', () => {
    const s = { campaigns: [{ id: 7, startup: 'glow', winner: 'maker.testnet', phase: 'funded' }], startups: [{ id: 'glow', founder: 'founder.testnet' }], holders: { glow: ['holder.testnet'] } };
    expect(rolesFrom(s, 7)).toEqual(roles);
    expect(rolesFrom(s, 8)).toBe(null);
  });
});

describe('comments', () => {
  it('only our paths are handled; unknown campaigns are 404', async () => {
    expect((await call('/api/campaign/7')).code).toBe(-1);
    expect((await call('/api/campaign/8/discussion')).code).toBe(404);
  });
  it('need a session', async () => {
    expect((await comment('hello', null)).code).toBe(401);
    expect((await thread()).comments).toEqual([]);
  });
  it('are posted, badged and listed oldest first', async () => {
    expect((await comment('first', 'maker.testnet')).code).toBe(200);
    clock += 1;
    await comment('second', 'founder.testnet');
    clock += 1;
    await comment('third', 'holder.testnet');
    clock += 1;
    await comment('https://example.com fourth');
    const t = await thread();
    expect(t.comments.map((c: any) => [c.text, c.badge])).toEqual([['first', 'Creator'], ['second', 'Founder'], ['third', 'Holder'], ['https://example.com fourth', null]]);
    expect(t.comments[0]).toEqual({ n: 1, by: 'maker.testnet', badge: 'Creator', at: 1_000_000, hidden: false, text: 'first' });
  });
  it('enforce the length limit and plain JSON from our own page', async () => {
    expect((await comment('x'.repeat(501))).code).toBe(400);
    expect((await comment('')).code).toBe(400);
    expect((await call('/api/campaign/7/discussion/comment', { body: { text: 'hi' }, headers: { 'content-type': 'text/plain' } })).code).toBe(415);
    expect((await call('/api/campaign/7/discussion/comment', { body: { text: 'hi' }, headers: { origin: 'https://evil.example' } })).code).toBe(403);
    expect((await call('/api/campaign/7/discussion/comment', { body: { text: 'x'.repeat(3000) } })).code).toBe(413);
    expect((await call('/api/campaign/7/discussion/comment', { body: '{oops' })).code).toBe(400);
    expect((await call('/api/campaign/7/discussion/comment', { method: 'GET' })).code).toBe(405);
  });
  it('are rate limited per account: 5 a minute, 30 a day, and the day survives a restart', async () => {
    for (let i = 0; i < 5; i++) expect((await comment(`m${i}`)).code).toBe(200);
    expect((await comment('too fast')).code).toBe(429);
    expect((await comment('another account', 'other.testnet')).code).toBe(200);
    for (let k = 0; k < 5; k++) {
      clock += 61_000;
      for (let i = 0; i < 5; i++) expect((await comment(`d${k}${i}`)).code).toBe(200);
    }
    clock += 61_000;
    const r = await comment('31st today');
    expect(r.code).toBe(429);
    expect(r.body.error).toMatch(/30 posts today/);
    clock += 86_400_000;
    expect((await comment('tomorrow')).code).toBe(200);
  });
  it('are rate limited per campaign', async () => {
    for (let i = 0; i < LIMITS.campaignPerMinute; i++) expect((await comment('hi', `a${i}.testnet`)).code).toBe(200);
    expect((await comment('hi', 'late.testnet')).code).toBe(429);
  });
  it('the founder, and only the founder, can hide one; its text is no longer sent', async () => {
    await comment('rude words', 'someone.testnet');
    for (const who of ['someone.testnet', 'maker.testnet', 'holder.testnet']) {
      expect((await call('/api/campaign/7/discussion/hide', { me: who, body: { n: 1 } })).code).toBe(403);
    }
    expect((await call('/api/campaign/7/discussion/hide', { me: null, body: { n: 1 } })).code).toBe(401);
    expect((await call('/api/campaign/7/discussion/hide', { me: 'founder.testnet', body: { n: 99 } })).code).toBe(404);
    expect((await call('/api/campaign/7/discussion/hide', { me: 'founder.testnet', body: { n: 1 } })).code).toBe(200);
    const c = (await thread()).comments[0];
    expect(c).toMatchObject({ n: 1, hidden: true, text: null, by: 'someone.testnet' });
    expect(JSON.stringify(await thread())).not.toContain('rude words');
  });
  it('a switch turns every write off; reading still works', async () => {
    const off = { writes: false };
    expect((await call('/api/campaign/7/discussion/comment', { body: { text: 'hi' }, deps: off })).code).toBe(503);
    expect((await call('/api/campaign/7/discussion/link', { me: 'maker.testnet', body: { url: 'https://x.com/a' }, deps: off })).code).toBe(503);
    const t = await call('/api/campaign/7/discussion', { deps: off });
    expect(t.code).toBe(200);
    expect(t.body.writes).toBe(false);
  });
  it('store accounts only, in one capped file per campaign', async () => {
    await comment('hello');
    const f = JSON.parse(readFileSync(join(dir, 'discuss', '7.json'), 'utf8'));
    expect(Object.keys(f.comments[0]).sort()).toEqual(['at', 'by', 'n', 'text']);
  });
});

describe('content links', () => {
  const add = (url: unknown, caption: unknown = '', me = 'maker.testnet') => call('/api/campaign/7/discussion/link', { me, body: { url, caption } });
  it('only the winning creator can add one, once the campaign is funded', async () => {
    for (const who of ['founder.testnet', 'holder.testnet', 'someone.testnet']) expect((await add('https://x.com/a', '', who)).code).toBe(403);
    expect((await call('/api/campaign/7/discussion/link', { me: null, body: { url: 'https://x.com/a' } })).code).toBe(401);
    r = { ...roles, phase: 'voting' };
    expect((await add('https://x.com/a')).code).toBe(409);
    r = roles;
    expect((await add('https://youtube.com/watch?v=1', 'The launch video')).code).toBe(200);
    expect((await thread()).links).toEqual([{ n: 1, url: 'https://youtube.com/watch?v=1', caption: 'The launch video', by: 'maker.testnet', at: 1_000_000 }]);
  });
  it('validate the link and caption', async () => {
    expect((await add('javascript:alert(1)')).code).toBe(400);
    expect((await add('https://x.com/a', 'c'.repeat(141))).code).toBe(400);
    expect((await add('https://x.com/a', 'c'.repeat(140))).code).toBe(200);
    expect((await add('https://x.com/a')).code).toBe(409); // already posted
  });
  it('are capped per campaign and the creator can remove their own', async () => {
    for (let i = 0; i < LIMITS.linksPerCampaign; i++) { clock += 61_000; expect((await add(`https://x.com/${i}`)).code).toBe(200); }
    clock += 61_000;
    expect((await add('https://x.com/more')).code).toBe(409);
    expect((await call('/api/campaign/7/discussion/unlink', { me: 'founder.testnet', body: { n: 1 } })).code).toBe(403);
    expect((await call('/api/campaign/7/discussion/unlink', { me: 'maker.testnet', body: { n: 1 } })).code).toBe(200);
    expect((await thread()).links).toHaveLength(LIMITS.linksPerCampaign - 1);
    expect((await add('https://x.com/more')).code).toBe(200);
  });
  it('say they are not used for payouts', async () => {
    expect((await thread()).note).toMatch(/never used for payouts/);
  });
});
