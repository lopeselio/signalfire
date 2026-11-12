import { github, githubError } from './proofs.ts';
import { cached } from './store.ts';

// What we fetch about a founder from outside the hub: their NEAR account's age and activity (NearBlocks API v3),
// and, for verified links only, their GitHub account or repository. Cached on disk: GitHub allows 60 requests an
// hour without a token (GITHUB_TOKEN raises it), and NearBlocks rate-limits bursts.

const NEARBLOCKS = process.env.NEARBLOCKS_API ?? 'https://api-testnet.nearblocks.io';
const HOURS = 3_600_000;
const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

async function nb<T>(path: string): Promise<T> {
  const r = await fetch(`${NEARBLOCKS}${path}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`NearBlocks HTTP ${r.status}`);
  return ((await r.json()) as { data: T }).data;
}

export interface AccountInfo { account: string; createdMs: number | null; createdTx: string | null; txns: number | null; txnsCapped?: boolean; activeDays: number | null; firstDay: string | null; lastDay: string | null }
/** `/v3/accounts/<id>` (when and in which transaction it was created) and `/v3/accounts/<id>/stats` (daily totals). */
export function accountInfo(account: string, ttl = 6 * HOURS) {
  return cached<AccountInfo>(`nearblocks-${account}`, ttl, async () => {
    const a = await nb<{ created?: { block_timestamp?: string; transaction_hash?: string } }>(`/v3/accounts/${account}`);
    const s = await nb<{ txns?: string; active_days?: string; first_day?: string; last_day?: string }>(`/v3/accounts/${account}/stats`).catch(() => null);
    const ns = a.created?.block_timestamp;
    // the daily stats lag by a day; for a newer account, count its transactions page by page (next_page cursor)
    let txns = s?.txns ? Number(s.txns) : null;
    let txnsCapped = false;
    if (txns === null) {
      let count = 0;
      let cursor: string | undefined;
      for (let page = 0; page < 4; page++) {
        const r = await fetch(`${NEARBLOCKS}/v3/accounts/${account}/txns?limit=100${cursor ? `&next=${encodeURIComponent(cursor)}` : ''}`, { signal: AbortSignal.timeout(15_000) });
        if (!r.ok) break;
        const j = (await r.json()) as { data?: unknown[]; meta?: { next_page?: string } };
        count += j.data?.length ?? 0;
        cursor = j.meta?.next_page;
        if (!cursor) break;
        if (page === 3) txnsCapped = true;
      }
      txns = count;
    }
    return {
      account,
      createdMs: ns ? Number(BigInt(ns) / 1_000_000n) : null,
      createdTx: a.created?.transaction_hash ?? null,
      txns,
      txnsCapped,
      activeDays: s?.active_days ? Number(s.active_days) : null,
      firstDay: s?.first_day ?? null,
      lastDay: s?.last_day ?? null,
    };
  });
}

/** The count behind a paginated GitHub list, from per_page=1 and the Link header's last page. */
async function ghCount(path: string): Promise<number> {
  const r = await github(`${path}${path.includes('?') ? '&' : '?'}per_page=1`);
  if (r.status === 409) return 0; // an empty repository
  if (!r.ok) throw githubError(r);
  const last = /[?&]page=(\d+)>; rel="last"/.exec(r.headers.get('link') ?? '');
  if (last) return Number(last[1]);
  return ((await r.json()) as unknown[]).length;
}

export interface RepoInfo {
  repo: string; url: string; description: string | null; created: string; pushed: string; archived: boolean; fork: boolean;
  stars: number; forks: number; openIssues: number; commits30: number; commits90: number; contributors: number;
  lastRelease: { tag: string; date: string } | null; languages: string;
}
export function repoInfo(repo: string, ttl = 6 * HOURS) {
  return cached<RepoInfo>(`github-repo-${repo}`, ttl, async () => {
    const r = await github(`/repos/${repo}`);
    if (!r.ok) throw r.status === 404 ? new Error(`GitHub has no public repository ${repo}`) : githubError(r);
    const j = (await r.json()) as { html_url: string; description: string | null; created_at: string; pushed_at: string; archived: boolean; fork: boolean; stargazers_count: number; forks_count: number; open_issues_count: number };
    const now = Date.now();
    const since = (d: number): string => new Date(now - d * 86_400_000).toISOString();
    const [commits30, commits90, contributors] = [
      await ghCount(`/repos/${repo}/commits?since=${since(30)}`),
      await ghCount(`/repos/${repo}/commits?since=${since(90)}`),
      await ghCount(`/repos/${repo}/contributors?anon=1`),
    ];
    const rel = await github(`/repos/${repo}/releases/latest`);
    const release = rel.ok ? ((await rel.json()) as { tag_name: string; published_at: string }) : null;
    if (!rel.ok && rel.status !== 404) throw githubError(rel);
    const lr = await github(`/repos/${repo}/languages`);
    const langs = lr.ok ? ((await lr.json()) as Record<string, number>) : {};
    const total = Object.values(langs).reduce((a, b) => a + b, 0);
    const languages = Object.entries(langs).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k} ${Math.round((100 * v) / total)}%`).join(', ');
    return {
      repo, url: j.html_url, description: j.description, created: day(Date.parse(j.created_at)), pushed: day(Date.parse(j.pushed_at)),
      archived: j.archived, fork: j.fork, stars: j.stargazers_count, forks: j.forks_count, openIssues: j.open_issues_count,
      commits30, commits90, contributors, lastRelease: release ? { tag: release.tag_name, date: day(Date.parse(release.published_at)) } : null, languages,
    };
  });
}

export interface GithubAccount { login: string; url: string; type: string; created: string; publicRepos: number; followers: number }
export function githubAccount(login: string, ttl = 6 * HOURS) {
  return cached<GithubAccount>(`github-user-${login}`, ttl, async () => {
    const r = await github(`/users/${login}`);
    if (!r.ok) throw r.status === 404 ? new Error(`GitHub has no account ${login}`) : githubError(r);
    const j = (await r.json()) as { login: string; html_url: string; type: string; created_at: string; public_repos: number; followers: number };
    return { login: j.login, url: j.html_url, type: j.type, created: day(Date.parse(j.created_at)), publicRepos: j.public_repos, followers: j.followers };
  });
}
