import { isRepo, type EvidenceItem } from '@signalfire/core';
import { config, explorerAccount } from '../config.ts';
import { latest as snapshot } from '../snapshot.ts';
import { accountInfo, githubAccount, repoInfo } from './sources.ts';
import { loadLinks } from './store.ts';

// Everything we know about the team behind a startup, as numbered evidence items with a source link and the time
// each was fetched: founder-linked sources (verified or only claimed), the founder's NEAR account, other startups they
// launched here, shipped work on verified GitHub links, and the startup's onchain record read from the hub.
// Only verified links are fetched: a claimed repository is the founder's say-so, so we show the claim, not its numbers.

const near = (y: string | bigint): number => Number(BigInt(y) / 10n ** 20n) / 10_000;
const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
export const publicBase = (): string => (process.env.BETTER_AUTH_URL ?? `http://localhost:${config.port}`).replace(/\/$/, '');
const hubSource = (method: string, args: object): { label: string; url: string } => ({ label: `${config.hub} ${method} ${JSON.stringify(args)} (onchain)`, url: explorerAccount(config.hub) });

export interface Gathered { startup: { id: string; name: string; founder: string }; items: EvidenceItem[]; errors: string[] }

export async function gather(id: string): Promise<Gathered | null> {
  const s = await snapshot();
  const st = s.startups.find((x) => x.id === id);
  if (!st) return null;
  const items: Omit<EvidenceItem, 'id'>[] = [];
  const errors: string[] = [];
  const links = loadLinks(id, st.founder).links;
  const verified = links.filter((l) => l.status === 'verified');

  // ---- founder-linked sources
  items.push({
    group: 'links', kind: 'links', title: 'Founder-linked sources',
    facts: {
      verified: verified.length,
      verified_github_repos: verified.filter((l) => l.kind === 'github' && isRepo(l.target)).length,
      verified_github_accounts: verified.filter((l) => l.kind === 'github' && !isRepo(l.target)).length,
      verified_x: verified.filter((l) => l.kind === 'x').length,
      claimed_unproven: links.length - verified.length,
      links: links.length ? links.map((l) => `${l.kind}:${l.target} (${l.status})`).join(', ') : 'none',
    },
    source: { label: 'Signalfire link store (each verified link has a NEP-413 proof, recheck with pnpm verify-brief)', url: `${publicBase()}/api/evidence/${id}/proof` },
    fetchedAt: Date.now(),
  });
  for (const l of verified) {
    items.push({
      group: 'links', kind: 'link-proof', title: `Proof: ${st.founder} controls ${l.kind === 'x' ? `X @${l.target}` : `GitHub ${l.target}`}`,
      facts: { link: `${l.kind}:${l.target}`, proof_url: l.proofUrl ?? null, signed_by_key: l.publicKey ?? null, checked: day(l.checkedAt ?? Date.now()) },
      source: { label: l.kind === 'x' ? 'X post by the account' : 'GitHub, published by the account', url: l.proofUrl ?? '' },
      fetchedAt: l.checkedAt ?? Date.now(),
    });
  }

  // ---- founder history
  const isOperator = st.founder === config.operator;
  try {
    const a = await accountInfo(st.founder);
    const v = a.value;
    items.push({
      group: 'founder', kind: 'founder-account', title: `Founder NEAR account ${st.founder}`,
      facts: {
        account: st.founder, created: v.createdMs ? day(v.createdMs) : null, age_days: v.createdMs ? Math.floor((Date.now() - v.createdMs) / 86_400_000) : null,
        created_tx: v.createdTx, txns: v.txnsCapped ? `${v.txns}+` : v.txns, active_days: v.activeDays, first_active_day: v.firstDay, last_active_day: v.lastDay,
        signalfire_operator: isOperator,
      },
      source: { label: `NearBlocks API v3 /v3/accounts/${st.founder} and /stats${a.stale ? ' (cached; refresh failed)' : ''}`, url: explorerAccount(st.founder) },
      fetchedAt: a.at,
    });
  } catch (e) { errors.push(`founder account: ${(e as Error).message}`); }
  const mine = s.startups.filter((x) => x.founder === st.founder);
  const record = (sid: string): string => {
    const cs = s.campaigns.filter((c) => c.startup === sid);
    return `${cs.filter((c) => c.phase === 'done').length} delivered, ${cs.filter((c) => c.phase === 'expired').length} missed of ${cs.length} campaigns`;
  };
  items.push({
    group: 'founder', kind: 'founder-startups', title: 'Startups this founder launched on Signalfire',
    facts: {
      launched: mine.length,
      startups: mine.map((x) => `${x.id.toUpperCase()} ${x.name} (launched ${day(x.created_ms)}; ${record(x.id)}; ${near(BigInt(x.fees_in) + BigInt(x.forfeits_in))} NEAR fees in)`).join('; '),
    },
    source: hubSource('get_startups', {}),
    fetchedAt: s.at,
  });

  // ---- shipped work (verified GitHub links only)
  for (const l of verified.filter((x) => x.kind === 'github')) {
    try {
      if (isRepo(l.target)) {
        const r = await repoInfo(l.target);
        const v = r.value;
        items.push({
          group: 'shipped', kind: 'github-repo', title: `GitHub repository ${v.repo}`,
          facts: {
            repo: v.repo, description: v.description, created: v.created, last_push: v.pushed, commits_30d: v.commits30, commits_90d: v.commits90,
            contributors: v.contributors, open_issues_and_prs: v.openIssues, stars: v.stars, forks: v.forks, languages: v.languages || null,
            last_release: v.lastRelease ? `${v.lastRelease.tag} on ${v.lastRelease.date}` : 'none', archived: v.archived, fork: v.fork,
          },
          source: { label: `GitHub REST API /repos/${v.repo}${r.stale ? ' (cached; refresh failed)' : ''}`, url: v.url },
          fetchedAt: r.at,
        });
      } else {
        const g = await githubAccount(l.target);
        const v = g.value;
        items.push({
          group: 'shipped', kind: 'github-user', title: `GitHub ${v.type === 'Organization' ? 'organization' : 'account'} ${v.login}`,
          facts: { login: v.login, type: v.type, created: v.created, public_repos: v.publicRepos, followers: v.followers },
          source: { label: `GitHub REST API /users/${v.login}${g.stale ? ' (cached; refresh failed)' : ''}`, url: v.url },
          fetchedAt: g.at,
        });
      }
    } catch (e) { errors.push(`GitHub ${l.target}: ${(e as Error).message}`); }
  }
  for (const l of verified.filter((x) => x.kind === 'x')) {
    items.push({
      group: 'shipped', kind: 'x-account', title: `X account @${l.target}`,
      facts: { handle: `@${l.target}`, profile: `https://x.com/${l.target}`, note: 'Signalfire reads no X statistics; open the profile yourself' },
      source: { label: 'X profile', url: `https://x.com/${l.target}` },
      fetchedAt: l.checkedAt ?? Date.now(),
    });
  }

  // ---- onchain track record (the hub)
  items.push({
    group: 'onchain', kind: 'treasury', title: `${st.id.toUpperCase()} marketing treasury`,
    facts: {
      fees_in_near: near(st.fees_in), forfeited_bonds_in_near: near(st.forfeits_in), free_near: near(st.available), reserved_near: near(st.committed),
      paid_to_creators_near: near(st.paid), paid_to_founders_near: 0, trades: st.trades, volume_near: near(st.volume), launched: day(st.created_ms),
    },
    source: hubSource('get_startup', { id }),
    fetchedAt: s.at,
  });
  const cs = s.campaigns.filter((c) => c.startup === id).sort((a, b) => a.id - b.id);
  const done = cs.filter((c) => c.phase === 'done');
  const spent = done.reduce((a, c) => a + BigInt(c.price), 0n);
  const results = done.reduce((a, c) => a + c.results, 0);
  items.push({
    group: 'onchain', kind: 'campaigns', title: `${st.id.toUpperCase()} marketing campaigns`,
    facts: {
      posted: cs.length, delivered: done.length, missed: cs.filter((c) => c.phase === 'expired').length,
      running: cs.filter((c) => ['bidding', 'proposing', 'voting', 'funded', 'propose_failed'].includes(c.phase)).length,
      new_buyers_from_delivered: results, spent_on_delivered_near: near(spent), cost_per_new_buyer_near: results ? near(spent / BigInt(results)) : null,
      campaigns: cs.slice(-6).map((c) => `#${c.id} ${c.phase}, ${c.results}/${c.target} new buyers`).join('; ') || 'none',
    },
    source: hubSource('get_campaigns', { startup: null }),
    fetchedAt: s.at,
  });
  const trades = [...(s.trades[id] ?? [])].sort((a, b) => a.ts_ms - b.ts_ms);
  const firstBuy = new Map<string, number>();
  for (const t of trades) if (t.side === 'buy' && !firstBuy.has(t.account)) firstBuy.set(t.account, t.ts_ms);
  const byDay = new Map<string, number>();
  for (const ms of firstBuy.values()) byDay.set(day(ms), (byDay.get(day(ms)) ?? 0) + 1);
  let running = 0;
  items.push({
    group: 'onchain', kind: 'holders', title: `${st.id.toUpperCase()} buyers and holders`,
    facts: {
      buyers_all_time: st.buyers, holders_council: (s.holders[id] ?? []).length, trades_in_ring: trades.length,
      buyers_over_time: [...byDay.entries()].map(([d, n]) => `${d}: ${(running += n)}`).join('; ') || 'no buys yet',
    },
    source: hubSource('get_trades', { startup: id, limit: 240 }),
    fetchedAt: s.at,
  });
  const winners = new Map<string, { won: number; results: number }>();
  for (const c of cs) if (c.winner) { const w = winners.get(c.winner) ?? { won: 0, results: 0 }; w.won++; w.results += c.results; winners.set(c.winner, w); }
  items.push({
    group: 'onchain', kind: 'creators', title: `Creators who ran ${st.id.toUpperCase()} campaigns`,
    facts: {
      creators: winners.size, results: [...winners.entries()].map(([a, w]) => `${a.replace(`.${config.hub}`, '')}: won ${w.won}, ${w.results} new buyers`).join('; ') || 'none yet',
      paid_tusd: done.reduce((a, c) => a + Number(BigInt(c.paid_tusd) / 10_000n) / 100, 0),
    },
    source: hubSource('get_campaigns', { startup: null }),
    fetchedAt: s.at,
  });

  return { startup: { id: st.id, name: st.name, founder: st.founder }, items: items.map((x, i) => ({ id: `E${i + 1}`, ...x }) as EvidenceItem), errors };
}

