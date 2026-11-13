import { useState } from 'react';
import { fmtNear } from '@signalfire/core';
import { acctUrl, type Startup } from './api.ts';
import { EvidenceChips, EvidenceFilters, NO_FILTER, evidenceRank, passes, useEvidenceSummaries, type Summaries } from './EvidenceChips.tsx';
import { useApp, useNow } from './ui.tsx';
import { STAGES, activeCampaign, campaignStage, delivered, stagesOf, useTrades24h, type Stage } from './landing/stage.ts';
import { whenNext } from './tour/state.ts';
import { NextAction } from './NextAction.tsx';
import { FireMark } from './FireMark.tsx';
import './landing/landing.css';

// Discover: every startup on the hub as a card, in tabs by where its campaign stands (landing/stage.ts). One big
// number per card, the marketing fund, then plain counts: holders, trades in 24 h, campaigns delivered.

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
    <FireMark className="s-flame" dim={!lit} style={{ ['--k' as string]: k.toFixed(2) }} label={`Marketing fund at ${Math.round(level * 100)}% of the largest${lit ? ', campaign open' : ''}`} />
  );
}

const STAGE_CHIP: Record<Stage, { text: string; kind: string }> = {
  offers: { text: 'taking offers', kind: 'ember' },
  picking: { text: 'picking the winner', kind: 'warn' },
  running: { text: 'campaign running', kind: 'ok' },
  next: { text: 'next brief soon', kind: 'smoke' },
  paid: { text: 'paid out', kind: 'ok' },
};

export function StartupCard({ s, ev, trades, now = Date.now() }: { s: Startup; ev?: Summaries | null; trades?: number; now?: number }) {
  const { state, go } = useApp();
  const f = founderOf(s, state!.operator);
  const treasury = BigInt(s.available) + BigInt(s.committed);
  // the card's flame: this treasury against the largest one on the hub
  const top = state!.startups.reduce((m, x) => { const v = BigInt(x.available) + BigInt(x.committed); return v > m ? v : m; }, 1n);
  const level = Number((treasury * 100n) / top) / 100;
  const active = activeCampaign(state!, s.id);
  const stage = (active && campaignStage(active, now)) || 'next';
  const done = delivered(state!, s.id);
  const chip = STAGE_CHIP[stage];
  const open = (): void => go(`/s/${s.id}`);
  return (
    <article className="s-card" onClick={open}>
      <header className="s-card-head">
        <StartupLogo id={s.id} />
        <div>
          <h3><a href={`/s/${s.id}`} onClick={(e) => { e.preventDefault(); e.stopPropagation(); open(); }}>{s.name}</a></h3>
          <span className="s-sym">{s.id.toUpperCase()}<span className={`chip ${chip.kind} s-stage`} title={STAGES.find((x) => x.id === stage)?.tip}>{chip.text}</span></span>
        </div>
      </header>
      <p className="s-pitch">{s.pitch}</p>
      <div className="s-big">
        <span className="s-big-l">Marketing fund</span>
        <span className="s-big-n">{fmtNear(treasury, 3)}<small> NEAR</small><CardFlame level={level} lit={!!active} /></span>
      </div>
      <dl className="s-stats">
        <div><dt>holders</dt><dd>{s.holders.length}</dd></div>
        <div><dt>trades, 24 h</dt><dd>{trades ?? '…'}</dd></div>
        <div><dt>campaigns delivered</dt><dd>{done}</dd></div>
      </dl>
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

type Tab = Stage | 'all';
const readTab = (): Tab => { const t = new URLSearchParams(location.search).get('stage'); return t && STAGES.some((x) => x.id === t) ? (t as Stage) : 'all'; };

/** What an empty tab says, in plain words. */
const EMPTY: Record<Tab, string> = {
  offers: 'No brief is taking offers right now.',
  next: 'Every startup has a campaign under way.',
  picking: 'No winner is being picked right now.',
  running: 'No campaign is running right now.',
  paid: 'No campaign has paid out yet.',
  all: 'No startup matches those filters yet.',
};

export function Discover() {
  const { state, account, go } = useApp();
  const now = useNow(5000);
  const [sort, setSort] = useState<Sort>('treasury');
  const [tab, setTabState] = useState<Tab>(readTab);
  const setTab = (t: Tab): void => {
    setTabState(t);
    history.replaceState(null, '', t === 'all' ? '/discover' : `/discover?stage=${t}`);
  };
  const ev = useEvidenceSummaries();
  const [filter, setFilter] = useState(NO_FILTER);
  const all = state!.startups.filter((s) => s.status === 'live');
  const trades = useTrades24h(all.map((s) => s.id));
  const stages = new Map(all.map((s) => [s.id, stagesOf(state!, s, now)]));
  const count = (t: Tab): number => (t === 'all' ? all.length : all.filter((s) => stages.get(s.id)!.has(t)).length);
  const list = all.filter((s) => (tab === 'all' || stages.get(s.id)!.has(tab)) && passes(filter, ev?.[s.id]));
  const key = (s: Startup): bigint => (sort === 'evidence' ? BigInt(evidenceRank(ev?.[s.id])) : sort === 'treasury' ? BigInt(s.available) + BigInt(s.committed) : sort === 'new' ? BigInt(s.created_ms) : BigInt(s.buyers));
  const sorted = [...list].sort((a, b) => (key(b) > key(a) ? 1 : key(b) < key(a) ? -1 : 0));
  const tabs: { id: Tab; label: string; tip: string }[] = [...STAGES, { id: 'all', label: 'All', tip: 'Every live startup' }];
  return (
    <div className="discover">
      <section className="page-head">
        <p className="eyebrow">Discover</p>
        <h1>Find a startup worth talking about</h1>
        <p className="lede">
          Every startup here has an attention token and a marketing fund. Trades fill the fund; creators earn it only by
          bringing in new buyers. Pick one that’s taking offers, or one whose campaign you want to watch.
        </p>
        <NextAction page="discover" />
      </section>
      <div className="d-stages" role="group" aria-label="Show startups by campaign stage">
        {tabs.map((t) => (
          <button key={t.id} aria-pressed={tab === t.id} title={t.tip} className={`pill${tab === t.id ? ' on' : ''}`} onClick={() => setTab(t.id)}>
            {t.label} <span className="d-count">{count(t.id)}</span>
          </button>
        ))}
      </div>
      <div className="d-tools" role="radiogroup" aria-label="Sort startups">
        <span className="muted small">Sort by</span>
        {([['treasury', 'Marketing fund'], ['buyers', 'Buyers'], ['new', 'Newest'], ['evidence', 'Most evidence']] as [Sort, string][]).map(([k, l]) => (
          <button key={k} role="radio" aria-checked={sort === k} className={`pill${sort === k ? ' on' : ''}`} onClick={() => setSort(k)}>{l}</button>
        ))}
        {account && <button className="ghost small d-launch" onClick={() => go('/launch')}>Launch a startup</button>}
      </div>
      <EvidenceFilters f={filter} set={setFilter} />
      <div className="s-grid" data-tour="startups">{sorted.map((s) => <StartupCard key={s.id} s={s} ev={ev} trades={trades?.[s.id]} now={now} />)}</div>
      {sorted.length === 0 && (
        <div className="d-empty">
          <p><strong>{EMPTY[tab]}</strong> {tab === 'offers' || tab === 'picking' || tab === 'running' ? whenNext(state!, now) : tab === 'all' ? 'A founder adds evidence by linking and proving their GitHub and X.' : ''}</p>
          {tab !== 'all' && <button className="ghost small" onClick={() => setTab('all')}>Show every startup</button>}
        </div>
      )}
      <p className="muted small d-note">
        The demo startups and their founders are fictional. The Signalfire team runs them on NEAR’s test network, and their
        creators, holders and buyers are AI agents. Anyone signed in can launch a startup of their own.
      </p>
    </div>
  );
}
