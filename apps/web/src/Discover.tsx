import { useState } from 'react';
import { fmtNear } from '@signalfire/core';
import { acctUrl, type Startup } from './api.ts';
import { EvidenceChips, EvidenceFilters, NO_FILTER, passes, useEvidenceSummaries, type Summaries } from './EvidenceChips.tsx';
import { useApp } from './ui.tsx';

// Discover: every startup on the hub as a card. One big number per card, the marketing treasury, because that is
// what trading a startup's attention token builds: a budget for reaching customers that the founders can't pocket.

/** The demo startups' founders are fictional people; the operator account runs the startups for them. */
const FOUNDERS: Record<string, { name: string; role: string }> = {
  glow: { name: 'Rosa Lindqvist', role: 'Founder' },
  fern: { name: 'Ines Okafor', role: 'Founder' },
  loop: { name: 'Mateo Brandt', role: 'Founder' },
  kiln: { name: 'Priya Hallam', role: 'Founder' },
};

export function founderOf(s: Startup, operator: string): { name: string; role: string; account: string; demo: boolean } {
  const f = s.founder === operator ? FOUNDERS[s.id] : undefined;
  if (f) return { ...f, account: s.founder, demo: true };
  return { name: s.founder.replace(/\.testnet$/, ''), role: 'Founder', account: s.founder, demo: false };
}

const hash = (s: string): number => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7);

/** The tones logos and avatars are drawn from: warm, muted, readable on the off-white page. */
const TONES = ['#e8590c', '#1f6f5c', '#3a4fb0', '#9c3d6b', '#6b5b2e', '#2f6f9f', '#b54a2a', '#4f4a8c'];

/** A procedural logo: a coloured tile with a mark derived from the symbol (no images). */
export function StartupLogo({ id, size = 44 }: { id: string; size?: number }) {
  const h = hash(id);
  const tone = TONES[h % TONES.length];
  const kind = (h >>> 3) % 4;
  const letter = id.slice(0, 1).toUpperCase();
  return (
    <svg className="s-logo" width={size} height={size} viewBox="0 0 44 44" aria-hidden="true">
      <rect width="44" height="44" rx="10" fill={tone} />
      {kind === 0 && <circle cx="31" cy="13" r="7" fill="#fff" opacity="0.22" />}
      {kind === 1 && <path d="M0 34 L44 18 L44 44 L0 44Z" fill="#fff" opacity="0.16" />}
      {kind === 2 && <rect x="26" y="-6" width="14" height="56" transform="rotate(28 33 22)" fill="#fff" opacity="0.15" />}
      {kind === 3 && <circle cx="22" cy="44" r="18" fill="#fff" opacity="0.16" />}
      <text x="22" y="29" textAnchor="middle" fontSize="20" fontWeight="700" fill="#fff" fontFamily="var(--display)">{letter}</text>
    </svg>
  );
}

/** Initials in a circle, for founders (fictional people get drawn avatars, never photos). */
export function Avatar({ name, size = 26 }: { name: string; size?: number }) {
  const parts = name.split(/[\s.-]+/).filter(Boolean);
  const ini = ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  const tone = TONES[(hash(name) >>> 2) % TONES.length];
  return <span className="avatar-sm" style={{ width: size, height: size, background: tone }} aria-hidden="true">{ini}</span>;
}

const Arrow = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 11.5 11.5 4.5M6 4.5h5.5V10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
);

/** A small flame whose height is the startup's marketing treasury relative to the largest; brighter while a campaign runs. */
function CardFlame({ level, lit }: { level: number; lit: boolean }) {
  const k = 0.45 + 0.55 * Math.max(0, Math.min(1, level));
  return (
    <svg className={`s-flame${lit ? ' lit' : ''}`} viewBox="0 0 24 30" width="22" height="28" style={{ ['--k' as string]: k.toFixed(2) }} role="img" aria-label={`Marketing fund at ${Math.round(level * 100)}% of the largest${lit ? ', campaign open' : ''}`}>
      <path className="f-out" d="M12 1.5c3.4 5 8 8.300 8 15.200a8 8 0 0 1-16 0c0-4.300 3.100-6.600 4.600-10.400 1.900 2.300 2.300 4.300 2.300 6.200C12.600 9 12.800 5.200 12 1.500z" />
      <path className="f-in" d="M12 13c1.700 2.400 3.600 3.800 3.600 6.600a3.600 3.600 0 0 1-7.200 0c0-1.900 1.300-3 2-4.600.9 1 1.100 1.900 1.100 2.800.5-1.600.8-3.200.5-4.800z" />
    </svg>
  );
}

export function StartupCard({ s, ev }: { s: Startup; ev?: Summaries | null }) {
  const { state, go } = useApp();
  const f = founderOf(s, state!.operator);
  const treasury = BigInt(s.available) + BigInt(s.committed);
  // the card's flame: this treasury against the largest one on the hub
  const top = state!.startups.reduce((m, x) => { const v = BigInt(x.available) + BigInt(x.committed); return v > m ? v : m; }, 1n);
  const level = Number((treasury * 100n) / top) / 100;
  const campaigns = state!.campaigns.filter((c) => c.startup === s.id);
  const running = campaigns.find((c) => ['bidding', 'proposing', 'voting', 'funded', 'propose_failed'].includes(c.phase));
  const results = campaigns.filter((c) => c.phase === 'done' || c.phase === 'expired').reduce((a, c) => a + c.results, 0);
  const open = (): void => go(`/s/${s.id}`);
  return (
    <article className="s-card" onClick={open}>
      <header className="s-card-head">
        <StartupLogo id={s.id} />
        <div>
          <h3><a href={`/s/${s.id}`} onClick={(e) => { e.preventDefault(); e.stopPropagation(); open(); }}>{s.name}</a></h3>
          <span className="s-sym">{s.id.toUpperCase()}{running && <span className="s-live">campaign {running.phase === 'funded' ? 'running' : 'open'}</span>}</span>
        </div>
      </header>
      <p className="s-pitch">{s.pitch}</p>
      <div className="s-big">
        <span className="s-big-l">Marketing fund</span>
        <span className="s-big-n">{fmtNear(treasury, 3)}<small> NEAR</small><CardFlame level={level} lit={!!running} /></span>
        <span className="s-big-sub">{fmtNear(s.paid, 3)} NEAR paid to creators · {results} new buyers reached</span>
      </div>
      <EvidenceChips sum={ev?.[s.id]} />
      <footer className="s-card-foot">
        <Avatar name={f.name} />
        <span className="s-founder"><strong>{f.name}</strong><small>{f.role}{f.demo ? ' (fictional)' : ''}</small></span>
        <a className="s-acct" href={acctUrl(f.account)} target="_blank" rel="noreferrer" title={`Founder account ${f.account}`} onClick={(e) => e.stopPropagation()}>
          <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M1.8 8h12.4M8 1.8c2 2 2 10.4 0 12.4M8 1.8c-2 2-2 10.4 0 12.4" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>
          <span className="sr-only">Founder's NEAR account</span>
        </a>
        <span className="s-go" aria-hidden="true"><Arrow /></span>
      </footer>
    </article>
  );
}

type Sort = 'treasury' | 'new' | 'buyers' | 'evidence';

export function Discover() {
  const { state, account, go } = useApp();
  const [sort, setSort] = useState<Sort>('treasury');
  const ev = useEvidenceSummaries();
  const [filter, setFilter] = useState(NO_FILTER);
  const list = state!.startups.filter((s) => s.status === 'live' && passes(filter, ev?.[s.id]));
  const key = (s: Startup): bigint => (sort === 'evidence' ? BigInt(ev?.[s.id]?.score ?? 0) : sort === 'treasury' ? BigInt(s.available) + BigInt(s.committed) : sort === 'new' ? BigInt(s.created_ms) : BigInt(s.buyers));
  const sorted = [...list].sort((a, b) => (key(b) > key(a) ? 1 : key(b) < key(a) ? -1 : 0));
  return (
    <div className="discover">
      <section className="page-head">
        <p className="eyebrow">Discover</p>
        <h1>Startups whose attention pays for reaching new customers</h1>
        <p className="lede">
          Each startup has an attention token and a marketing fund. The big number on each card is what that fund
          holds right now: trading fees that only creators can earn, by bringing in new buyers.
        </p>
      </section>
      <div className="d-tools" role="radiogroup" aria-label="Sort startups">
        <span className="muted small">Sort by</span>
        {([['treasury', 'Marketing fund'], ['buyers', 'Buyers'], ['new', 'Newest'], ['evidence', 'Most evidence']] as [Sort, string][]).map(([k, l]) => (
          <button key={k} role="radio" aria-checked={sort === k} className={`pill${sort === k ? ' on' : ''}`} onClick={() => setSort(k)}>{l}</button>
        ))}
        {account && <button className="ghost small d-launch" onClick={() => go('/launch')}>Launch a startup</button>}
      </div>
      <EvidenceFilters f={filter} set={setFilter} />
      <div className="s-grid" data-tour="startups">{sorted.map((s) => <StartupCard key={s.id} s={s} ev={ev} />)}</div>
      {sorted.length === 0 && <p className="muted">No startup has that evidence yet. A founder adds it by linking and proving their GitHub and X.</p>}
      <p className="muted small d-note">
        The demo startups and their founders are fictional. The Signalfire team runs them on NEAR’s test network, and their
        creators, holders and buyers are AI agents. Anyone signed in can launch a startup of their own.
      </p>
    </div>
  );
}
