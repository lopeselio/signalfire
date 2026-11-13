import { describe, expect, it } from 'vitest';
import { contradictsProfile, dayNumber, guardBrief, profileCheck, profileInputs, profilePrompt, type EvidenceItem, type Fact } from '../src/index.ts';

const DAY = 86_400_000;
const at = dayNumber('2026-11-13')! * DAY + 3_600_000; // fetched 2026-11-13 01:00 UTC
const src = { label: 'test', url: 'https://x.test' };
const item = (id: string, kind: string, facts: Record<string, Fact>, group: EvidenceItem['group'] = 'onchain'): EvidenceItem => ({ id, group, kind, title: kind, facts, source: src, fetchedAt: at });

const links = (verified: number, repos = 0, claimed = 0, x = 0): EvidenceItem => item('E1', 'links', { verified, verified_github_repos: repos, verified_github_accounts: verified - repos - x, verified_x: x, claimed_unproven: claimed }, 'links');
const account = (age: number | null, txns: Fact = 100, operator = false): EvidenceItem => item('E2', 'founder-account', { account: 'alice.testnet', age_days: age, txns, signalfire_operator: operator }, 'founder');
const repo = (c30: number, c90: number, push: string, team = 1, archived = false, id = 'E3'): EvidenceItem => item(id, 'github-repo', { repo: `alice/${id}`, commits_30d: c30, commits_90d: c90, last_push: push, contributors: team, archived }, 'shipped');
const camps = (delivered: number, missed: number, buyers = delivered * 3, cost: Fact = 0.0002): EvidenceItem => item('E9', 'campaigns', { delivered, missed, new_buyers_from_delivered: buyers, cost_per_new_buyer_near: buyers ? cost : null });

const rating = (items: EvidenceItem[], key: string): string => profileCheck(items).signals.find((s) => s.key === key)!.rating;

describe('dayNumber', () => {
  it('counts days since 1970', () => {
    expect(dayNumber('1970-01-01')).toBe(0);
    expect(dayNumber('2000-03-01')).toBe(11017);
    expect(dayNumber('2026-11-13')).toBe(20770);
    expect(dayNumber('nope')).toBeNull();
  });
});

describe('code activity', () => {
  it('is Not linked without a verified repository', () => {
    expect(rating([links(0)], 'code')).toBe('not-linked');
    expect(profileCheck([links(1, 1)]).signals[0].detail).toContain('could not be read');
  });
  it('is Active at 5 commits in 30 days with a push within 30 days', () => {
    expect(rating([links(1, 1), repo(5, 5, '2026-10-14')], 'code')).toBe('active');
    expect(rating([links(1, 1), repo(4, 4, '2026-11-12')], 'code')).toBe('some');
    expect(rating([links(1, 1), repo(9, 9, '2026-10-13')], 'code')).toBe('some'); // push 31 days before the fetch
  });
  it('is Active with 1 commit in 30 days when 2+ people contribute', () => {
    expect(rating([links(1, 1), repo(1, 1, '2026-11-01', 2)], 'code')).toBe('active');
    expect(rating([links(1, 1), repo(1, 1, '2026-11-01', 1)], 'code')).toBe('some');
  });
  it('is Some with commits only in 90 days, None with none or archived', () => {
    expect(rating([links(1, 1), repo(0, 1, '2026-09-01')], 'code')).toBe('some');
    expect(rating([links(1, 1), repo(0, 0, '2026-01-01')], 'code')).toBe('none');
    expect(rating([links(1, 1), repo(50, 90, '2026-11-12', 3, true)], 'code')).toBe('none');
  });
  it('takes the most active verified repository', () => {
    const p = profileCheck([links(2, 2), repo(0, 0, '2026-01-01', 1, false, 'E3'), repo(7, 7, '2026-11-10', 1, false, 'E4')]);
    expect(p.signals[0]).toMatchObject({ rating: 'active', cites: ['E4'] });
  });
});

describe('public presence', () => {
  it('is Verified, Claimed only or None', () => {
    expect(rating([links(1, 0, 0, 1)], 'presence')).toBe('verified');
    expect(rating([links(0, 0, 2)], 'presence')).toBe('claimed');
    expect(rating([links(0)], 'presence')).toBe('none');
    expect(rating([], 'presence')).toBe('none');
  });
});

describe('founder account', () => {
  it('is Established at 90 days and 50 transactions', () => {
    expect(rating([account(90, 50)], 'founder')).toBe('established');
    expect(rating([account(90, '50+')], 'founder')).toBe('established');
    expect(rating([account(89, 500)], 'founder')).toBe('new');
    expect(rating([account(400, 49)], 'founder')).toBe('new');
  });
  it('is New from 7 days, Brand new under 7, Unknown without data', () => {
    expect(rating([account(7)], 'founder')).toBe('new');
    expect(rating([account(6)], 'founder')).toBe('brand-new');
    expect(rating([account(0, 2)], 'founder')).toBe('brand-new');
    expect(rating([account(null)], 'founder')).toBe('unknown');
    expect(rating([], 'founder')).toBe('unknown');
  });
});

describe('track record', () => {
  it('is Proven at 3 delivered with at most a third missed and new buyers', () => {
    expect(rating([camps(3, 1)], 'track')).toBe('proven');
    expect(rating([camps(3, 2)], 'track')).toBe('some');
    expect(rating([camps(3, 0, 0)], 'track')).toBe('some');
    expect(rating([camps(2, 0)], 'track')).toBe('some');
  });
  it('is Some from 1 delivered, None yet at 0 or without data', () => {
    expect(rating([camps(1, 0)], 'track')).toBe('some');
    expect(rating([camps(0, 2)], 'track')).toBe('none');
    expect(rating([], 'track')).toBe('none');
  });
  it('says the cost per new buyer', () => {
    expect(profileCheck([camps(1, 0, 3, 0.0002)]).signals[3].detail).toBe('1 campaign delivered, 0 missed; 3 new buyers at 0.0002 NEAR each.');
  });
});

describe('profile strength', () => {
  it('is Not enough evidence with no proven link and no delivered campaign', () => {
    expect(profileCheck([]).label).toBe('not-enough');
    expect(profileCheck([links(0, 0, 3), account(400, 900), camps(0, 0)]).label).toBe('not-enough');
  });
  it('is Thin without a proven link even with a record', () => {
    expect(profileCheck([links(0), account(400, 900), camps(5, 0)]).label).toBe('thin');
  });
  it('is Moderate at 3 points with a proven link', () => {
    expect(profileCheck([links(1, 0, 0, 1), account(7), camps(0, 0)]).label).toBe('moderate'); // 2 + 1
    expect(profileCheck([links(1, 0, 0, 1), account(3), camps(0, 0)]).label).toBe('thin'); // 2
  });
  it('is Strong at 6 points with active code and a founder account past a week', () => {
    const strong = [links(2, 1, 0, 1), repo(10, 30, '2026-11-12'), account(30), camps(1, 0)]; // 2+2+1+1
    expect(profileCheck(strong).label).toBe('strong');
    expect(profileCheck([links(2, 1, 0, 1), repo(10, 30, '2026-11-12'), account(3), camps(5, 0)]).label).toBe('moderate'); // brand new founder
    expect(profileCheck([links(2, 1, 0, 1), repo(1, 30, '2026-11-12'), account(400), camps(5, 0)]).label).toBe('moderate'); // code only Some
  });
  it('a SUSHI-like startup (proven links, active repo, brand-new founder account, 1 delivered) is Moderate', () => {
    const p = profileCheck([links(2, 1, 0, 1), repo(175, 175, '2026-11-13'), account(0, 2), camps(1, 0, 3)]);
    expect(p).toMatchObject({ label: 'moderate', points: 5, demo: false });
    expect(p.signals.map((s) => s.word)).toEqual(['Active', 'Verified', 'Brand new', 'Some']);
  });
  it('a demo startup is at most Thin, or Not enough evidence with no delivered campaign', () => {
    const demo = profileCheck([links(0), account(3, 400, true), camps(5, 0)]);
    expect(demo).toMatchObject({ label: 'thin', demo: true });
    expect(demo.why).toContain('demo startup');
    expect(profileCheck([links(0), account(3, 400, true), camps(0, 0)]).label).toBe('not-enough');
    // even a demo startup with every signal at its best stays Thin
    expect(profileCheck([links(2, 1, 0, 1), repo(10, 30, '2026-11-12'), account(400, 900, true), camps(5, 0)]).label).toBe('thin');
  });
  it('hashes exactly its inputs, and is deterministic', () => {
    const a = [links(1, 1), repo(5, 5, '2026-11-01'), account(30), camps(1, 0)];
    expect(profileCheck(a)).toEqual(profileCheck(a.map((i) => ({ ...i }))));
    expect(Object.keys(profileInputs(a))).toEqual(['E1', 'E3', 'E2', 'E9']);
    const other = a.map((i) => (i.kind === 'github-repo' ? { ...i, facts: { ...i.facts, stars: 99 } } : i));
    expect(profileCheck(other).inputsHash).toBe(profileCheck(a).inputsHash); // stars are not an input
    const more = a.map((i) => (i.kind === 'campaigns' ? { ...i, facts: { ...i.facts, delivered: 2 } } : i));
    expect(profileCheck(more).inputsHash).not.toBe(profileCheck(a).inputsHash);
  });
});

describe('the brief and the profile check', () => {
  const items = [links(2, 1, 0, 1), repo(175, 175, '2026-11-13'), account(0, 2), camps(1, 0, 3)];
  const p = profileCheck(items);
  it('the prompt gives the ratings as facts with their evidence ids', () => {
    const t = profilePrompt(p);
    expect(t).toContain('"profile_strength":"Moderate"');
    expect(t).toContain('"rating":"Brand new","rests_on":["E2"]');
    expect(t).toContain('you may not change it');
  });
  it('the guard drops a line naming another strength', () => {
    expect(contradictsProfile('The profile strength is Strong.', p)).toBe(true);
    expect(contradictsProfile('Moderate profile strength rests on proven links.', p)).toBe(false);
    expect(contradictsProfile('The repository is strong evidence of work.', p)).toBe(false);
    const g = guardBrief({ reading: [{ text: 'The profile strength is Strong overall.', cites: ['E1'] }, { text: 'The profile strength is Moderate because the founder account is brand new.', cites: ['E2'] }] }, items, { contradicts: (t) => contradictsProfile(t, p) });
    expect(g.dropped.map((d) => d.reason)).toEqual(['a profile strength other than the rule-computed one']);
    expect(g.brief.reading).toHaveLength(1);
  });
  it('the guard drops fundraising words', () => {
    const g = guardBrief({ reading: [{ text: 'The valuation looks fair.', cites: ['E1'] }, { text: 'There is no cap table.', cites: ['E1'] }] }, items);
    expect(g.dropped).toHaveLength(2);
  });
});
