import { describe, expect, it } from 'vitest';
import {
  base58Decode, base58Encode, canonical, evidenceHash, guardBrief, linkMessage, linkNonce, normalizeTarget, parseProofLines, proofLine,
  ruleFlags, summarize, type EvidenceItem,
} from '../src/index.ts';

const at = 1_794_480_000_000;
const items: EvidenceItem[] = [
  { id: 'E1', group: 'links', kind: 'links', title: 'Founder-linked sources', facts: { verified: 1, verified_github_repos: 1, claimed_unproven: 1 }, source: { label: 'Signalfire link store', url: 'https://x.test/a' }, fetchedAt: at },
  { id: 'E2', group: 'founder', kind: 'founder-account', title: 'Founder NEAR account', facts: { account: 'alice.testnet', created: '2026-11-10', age_days: 2, txns: 39, signalfire_operator: false }, source: { label: 'NearBlocks', url: 'https://x.test/b' }, fetchedAt: at },
  { id: 'E3', group: 'shipped', kind: 'github-repo', title: 'GitHub repository alice/app', facts: { repo: 'alice/app', stars: 12, commits_30d: 0, commits_90d: 0, languages: 'TypeScript 70%, Rust 30%' }, source: { label: 'GitHub', url: 'https://x.test/c' }, fetchedAt: at },
  { id: 'E4', group: 'onchain', kind: 'campaigns', title: 'Campaigns', facts: { posted: 2, delivered: 1, missed: 1, cost_per_new_buyer_near: 0.0217 }, source: { label: 'hub', url: 'https://x.test/d' }, fetchedAt: at },
];

describe('founder link proofs', () => {
  it('normalizes targets', () => {
    expect(normalizeTarget('github', 'https://github.com/Alice/App.git')).toBe('alice/app');
    expect(normalizeTarget('github', 'alice')).toBe('alice');
    expect(normalizeTarget('github', 'a/b/c')).toBeNull();
    expect(normalizeTarget('x', '@Alice_1')).toBe('alice_1');
    expect(normalizeTarget('x', 'https://x.com/alice')).toBe('alice');
    expect(normalizeTarget('x', 'way_too_long_handle_x')).toBeNull();
  });
  it('the message names the startup, the account and the link; the nonce is its hash', () => {
    const c = { startup: 'glow', founder: 'alice.testnet', kind: 'github' as const, target: 'alice/app' };
    const m = linkMessage(c, 'signalfire.testnet');
    expect(m).toContain('startup: glow');
    expect(m).toContain('founder: alice.testnet');
    expect(m).toContain('link: github:alice/app');
    expect(linkNonce(m)).toHaveLength(32);
  });
  it('a proof line round-trips and fits in a post', () => {
    const sig = base58Encode(new Uint8Array(64).fill(7));
    const c = { startup: 'glow', founder: 'alice.testnet', kind: 'x' as const, target: 'alice_1' };
    const line = proofLine(c, sig);
    expect(line.length).toBeLessThan(200);
    expect(parseProofLines(`hello\n${line}\nbye`)).toEqual([{ ...c, signature: sig }]);
  });
  it('base58 round-trips, leading zeros included', () => {
    const b = Uint8Array.from([0, 0, 1, 2, 255, 128]);
    expect(base58Decode(base58Encode(b))).toEqual(b);
  });
});

describe('evidence', () => {
  it('hashes canonically', () => {
    expect(canonical({ b: 1, a: [2, { d: 1, c: null }] })).toBe('{"a":[2,{"c":null,"d":1}],"b":1}');
    expect(evidenceHash(items)).toBe(evidenceHash(items.map((i) => ({ ...i }))));
  });
  it('rule checks name the gaps from the facts, with citations', () => {
    const f = ruleFlags(items).map((x) => x.text);
    expect(f.some((t) => t.includes('2 day(s) old'))).toBe(true);
    expect(f.some((t) => t.includes('claimed but not proven'))).toBe(true);
    expect(f.some((t) => t.includes('no commits in the last 90 days'))).toBe(true);
    expect(f.some((t) => t.includes('missed their deadline'))).toBe(true);
    expect(ruleFlags(items).every((x) => x.cites.length > 0)).toBe(true);
  });
  it('summarizes for Discover', () => {
    expect(summarize(items)).toMatchObject({ verifiedRepos: 1, repoActive30: false, delivered: 1, score: 3 });
  });
});

describe('brief guard', () => {
  const raw = {
    observed: [
      { text: 'The founder account was created on 2026-11-10 and is 2 days old.', cites: ['E2'] },
      { text: 'The repository has 12 stars.', cites: ['E3'] },
      { text: 'The repository has 400 stars.', cites: ['E3'] },
      { text: 'The founder has shipped a lot.', cites: [] },
      { text: 'Two campaigns were posted.', cites: ['E9'] },
      { text: 'The low activity suggests the project is paused.', cites: ['E3'] },
    ],
    reading: [
      { text: 'This is a good buy before the price will rise.', cites: ['E4'] },
      { text: 'One delivered campaign out of 2 is a thin record so far.', cites: ['E4'] },
      { text: 'Backers should consider investing early.', cites: ['E1'] },
    ],
    gaps: [{ text: 'One link is unproven (E1).', cites: [] }],
    check: ['Open the repository and read the last commits [E3].'],
  };
  const { brief, dropped } = guardBrief(raw, items);
  it('keeps cited facts', () => {
    expect(brief.observed.map((l) => l.text)).toEqual(['The founder account was created on 2026-11-10 and is 2 days old.', 'The repository has 12 stars.']);
  });
  it('drops lines without a valid citation, with invented numbers, or with advice', () => {
    const reasons = dropped.map((d) => `${d.text} => ${d.reason}`);
    expect(reasons).toContain('The repository has 400 stars. => a number that is not in the cited sources');
    expect(reasons).toContain('The founder has shipped a lot. => no valid citation');
    expect(reasons).toContain('Two campaigns were posted. => cites a source that does not exist');
    expect(reasons).toContain('This is a good buy before the price will rise. => advice, a prediction or fundraising language');
    expect(reasons).toContain('Backers should consider investing early. => advice, a prediction or fundraising language');
  });
  it('moves a hedged observation to the AI reading', () => {
    expect(brief.reading.map((l) => l.text)).toEqual(['The low activity suggests the project is paused.', 'One delivered campaign out of 2 is a thin record so far.']);
  });
  it('takes citations written in the text', () => {
    expect(brief.gaps).toEqual([{ text: 'One link is unproven.', cites: ['E1'] }]);
    expect(brief.check).toEqual([{ text: 'Open the repository and read the last commits.', cites: ['E3'] }]);
  });
  it('is deterministic', () => expect(guardBrief(raw, items)).toEqual({ brief, dropped }));
});
