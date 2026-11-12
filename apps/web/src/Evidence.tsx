import { useCallback, useEffect, useState } from 'react';
import {
  linkMessage, linkNonce, normalizeTarget, proofLine, signatureToB58,
  type Brief, type Dropped, type EvidenceItem, type EvidenceSummary, type Flag, type LinkKind,
} from '@signalfire/core';
import { api, type Startup } from './api.ts';
import { PrivateAiBadge } from './Attest.tsx';
import { Acct, ago, useApp, useNow } from './ui.tsx';
import { signMessage } from './wallet.ts';
import './evidence.css';

// The Evidence tab: who is behind this startup, with a source and a fetch time on every item, and the AI research
// brief written from that evidence alone (a TEE model on NEAR AI Cloud; code drops every line without a valid
// citation, with advice or a prediction, or with a number its sources don't hold). Founders link and prove their
// GitHub and X here and in the Founder's desk: their wallet signs, the account publishes, the server checks.

export interface FounderLink { kind: LinkKind; target: string; status: 'claimed' | 'verified'; claimedAt: number; proofUrl?: string; publicKey?: string; checkedAt?: number; error?: string }
interface BriefView {
  at: number; trigger: 'auto' | 'request'; evidence: EvidenceItem[]; evidenceHash: string; parsed: boolean; brief: Brief; dropped: Dropped[]; flags: Flag[];
  model: string | null; signed: boolean; signingAddress: string | null;
}
interface EvidenceView {
  startup: { id: string; name: string; founder: string }; items: EvidenceItem[]; errors: string[]; evidenceHash: string; flags: Flag[]; summary: EvidenceSummary;
  links: FounderLink[]; brief: BriefView | null; generating: boolean; nearAi: boolean; everyHours: number; nextRequestAt: number;
}

const GROUPS: { key: EvidenceItem['group']; title: string; note: string }[] = [
  { key: 'links', title: 'Founder-linked sources', note: 'GitHub and X accounts the founder linked. Verified means the founder’s NEAR wallet signed the link and that account published the signature.' },
  { key: 'founder', title: 'Founder history', note: 'The founder’s NEAR account and what they launched here before.' },
  { key: 'shipped', title: 'Shipped work', note: 'Read only for verified links: a claimed repository is the founder’s say-so.' },
  { key: 'onchain', title: 'Onchain track record', note: 'Read from the hub contract: the treasury, campaigns, buyers and the creators who ran them.' },
];

export function useEvidence(id: string) {
  const [ev, setEv] = useState<EvidenceView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => { api<EvidenceView>(`/evidence/${id}`).then((v) => { setEv(v); setErr(null); }).catch((e: Error) => setErr(e.message)); }, [id]);
  useEffect(() => {
    load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, [load]);
  return { ev, err, load };
}

const showFact = (v: unknown): string => (v === null || v === undefined || v === '' ? '—' : typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v));
const label = (k: string): string => k.replace(/_near$/, ' (NEAR)').replace(/_(\d+)d$/, ' ($1 days)').replace(/_/g, ' ');

export function EvidenceTab({ s }: { s: Startup }) {
  const { state } = useApp();
  const { ev, err, load } = useEvidence(s.id);
  if (!ev) return <section className="panel">{err ? <p className="bad-text">Couldn’t load the evidence: {err}</p> : <p className="muted">Gathering the evidence…</p>}</section>;
  const demo = ev.summary.demo;
  return (
    <div className="ev" data-tour="evidence-panel">
      <section className="panel ev-intro">
        <p className="small">
          <strong>Evidence about the team, with a source on every item.</strong> It helps you look before you back {s.name}; it isn’t advice, and an
          attention token is not equity or a claim on anything. The research brief below is a model’s reading of this evidence and nothing else:
          facts and inference are kept apart, every line cites its sources, and lines without one are removed by code.
        </p>
        <SummaryChips sum={ev.summary} />
        {demo && (
          <p className="ev-demo small">
            <strong>Demo startup.</strong> {s.name}’s founder is fictional and the Signalfire operator (<Acct a={state!.operator} />) runs it on testnet,
            so it has no verified repository or founder links: only its onchain record is real.
          </p>
        )}
      </section>
      <div className="ev-grid">
        <div className="ev-main">
          <BriefPanel ev={ev} reload={load} />
        </div>
        <div className="ev-side">
          <LinksPanel ev={ev} s={s} />
          {GROUPS.map((g) => {
            const list = ev.items.filter((i) => i.group === g.key && i.kind !== 'links');
            if (g.key === 'links') return null;
            return (
              <section key={g.key} className="panel ev-group">
                <h2>{g.title}</h2>
                <p className="muted small">{g.note}</p>
                {list.length === 0 && <p className="muted small">{g.key === 'shipped' ? 'Nothing to show: no verified GitHub or X link.' : 'Nothing yet.'}</p>}
                {list.map((i) => <EvidenceCard key={i.id} i={i} />)}
              </section>
            );
          })}
          {ev.errors.length > 0 && <p className="muted small">Couldn’t fetch: {ev.errors.join('; ')} (shown again when the source answers).</p>}
          <p className="muted small">Evidence hash <code>{ev.evidenceHash.slice(0, 16)}…</code> · full bundle: <a href={`/api/evidence/${s.id}/proof`} target="_blank" rel="noreferrer">proof (JSON)</a> · recheck it with <code>pnpm verify-brief {s.id}</code></p>
        </div>
      </div>
    </div>
  );
}

function SummaryChips({ sum }: { sum: EvidenceSummary }) {
  return (
    <p className="ev-chips">
      <span className={`chip ${sum.verifiedLinks ? 'ok' : 'smoke'}`}>{sum.verifiedLinks ? `${sum.verifiedLinks} verified founder link${sum.verifiedLinks > 1 ? 's' : ''}` : 'no verified founder links'}</span>
      <span className={`chip ${sum.verifiedRepos ? 'ok' : 'smoke'}`}>{sum.verifiedRepos ? `${sum.verifiedRepos} verified repo${sum.verifiedRepos > 1 ? 's' : ''}` : 'no verified repository'}</span>
      {sum.verifiedRepos > 0 && <span className={`chip ${sum.repoActive30 ? 'ok' : 'warn'}`}>{sum.repoActive30 ? 'commits in the last 30 days' : 'no commits in 30 days'}</span>}
      {sum.claimed > 0 && <span className="chip warn">{sum.claimed} claimed, not proven</span>}
      <span className={`chip ${sum.delivered ? 'ok' : 'smoke'}`}>{sum.delivered} campaign{sum.delivered === 1 ? '' : 's'} delivered</span>
      {sum.ageDays !== null && <span className={`chip ${sum.ageDays < 7 ? 'bad' : 'smoke'}`}>founder account {sum.ageDays} day{sum.ageDays === 1 ? '' : 's'} old</span>}
    </p>
  );
}

function EvidenceCard({ i }: { i: EvidenceItem }) {
  const now = useNow(30_000);
  return (
    <article className="ev-item" id={`ev-${i.id}`}>
      <header><span className="ev-id">{i.id}</span><h3>{i.title}</h3></header>
      <dl className="facts">
        {Object.entries(i.facts).map(([k, v]) => <div key={k}><dt>{label(k)}</dt><dd>{showFact(v)}</dd></div>)}
      </dl>
      <p className="ev-src small">
        Source: {i.source.url ? <a href={i.source.url} target="_blank" rel="noreferrer">{i.source.label}</a> : i.source.label} · fetched {ago(i.fetchedAt, now)}
      </p>
    </article>
  );
}

// ---------- the research brief ----------

function Cites({ ids, items }: { ids: string[]; items: EvidenceItem[] }) {
  return (
    <span className="ev-cites">
      {ids.map((id) => {
        const it = items.find((x) => x.id === id);
        return it?.source.url
          ? <a key={id} href={it.source.url} target="_blank" rel="noreferrer" title={`${it.title}: ${it.source.label}`}>{id}</a>
          : <span key={id} title={it?.title}>{id}</span>;
      })}
    </span>
  );
}

function Lines({ lines, items, empty }: { lines: { text: string; cites: string[] }[]; items: EvidenceItem[]; empty: string }) {
  if (!lines.length) return <p className="muted small">{empty}</p>;
  return <ul className="ev-lines">{lines.map((l, k) => <li key={k}>{l.text} <Cites ids={l.cites} items={items} /></li>)}</ul>;
}

function BriefPanel({ ev, reload }: { ev: EvidenceView; reload: () => void }) {
  const now = useNow(10_000);
  const [asking, setAsking] = useState(false);
  const [askErr, setAskErr] = useState<string | null>(null);
  const b = ev.brief;
  const wait = ev.nextRequestAt - now;
  const ask = (): void => {
    setAsking(true);
    setAskErr(null);
    api<{ brief: BriefView }>(`/evidence/${ev.startup.id}/brief`, {}).then(() => reload()).catch((e: Error) => setAskErr(e.message)).finally(() => setAsking(false));
  };
  return (
    <section className="panel ev-brief" data-tour="research-brief">
      <header className="ev-brief-head">
        <h2>AI research brief</h2>
        {b?.signed && b.model && <PrivateAiBadge src={{ kind: 'brief', startup: ev.startup.id }} model={b.model} what="brief" />}
        {b && !b.signed && <span className="tee off" title="Written without NEAR AI: the facts and rule checks only, unsigned">facts only, no AI</span>}
      </header>
      {!b && <p className="muted">{ev.generating ? 'Writing the first brief from the evidence (about half a minute)…' : 'No brief yet.'}</p>}
      {b && (
        <>
          <p className="muted small">
            Written {ago(b.at, now)} {b.trigger === 'request' ? 'on request' : 'automatically'} from {b.evidence.length} sources
            (evidence hash <code>{b.evidenceHash.slice(0, 12)}…</code>){b.model ? ` by ${b.model} in a TEE on NEAR AI Cloud` : ''}. It is rewritten every {ev.everyHours} hours.
            {!b.parsed && b.signed && ' The model’s reply couldn’t be read, so only the facts and rule checks are shown.'}
          </p>
          <h3 className="ev-sec">Observed <span className="muted small">facts from the sources, each cited</span></h3>
          <Lines lines={b.brief.observed} items={b.evidence} empty="No observations." />
          <h3 className="ev-sec ev-ai">AI reading <span className="small">inference by the model, not fact</span></h3>
          <div className="ev-reading"><Lines lines={b.brief.reading} items={b.evidence} empty="No inference offered." /></div>
          <h3 className="ev-sec">Gaps and red flags</h3>
          <p className="muted small ev-sub">Rule checks (computed by code, not the model)</p>
          <ul className="ev-lines ev-flags">{b.flags.length ? b.flags.map((f, k) => <li key={k} className={f.level}>{f.text} <Cites ids={f.cites} items={b.evidence} /></li>) : <li className="muted">None.</li>}</ul>
          {b.brief.gaps.length > 0 && <><p className="muted small ev-sub">Noted by the model</p><Lines lines={b.brief.gaps} items={b.evidence} empty="" /></>}
          <h3 className="ev-sec">What to check yourself</h3>
          <Lines lines={b.brief.check} items={b.evidence} empty="Open each source on the right." />
          {b.dropped.length > 0 && (
            <details className="ev-dropped small">
              <summary>{b.dropped.length} line{b.dropped.length > 1 ? 's' : ''} the guard removed</summary>
              <ul>{b.dropped.map((d, k) => <li key={k}><span className="chip bad">{d.reason}</span> {d.text}</li>)}</ul>
            </details>
          )}
        </>
      )}
      <div className="row">
        <button className="ghost small" disabled={asking || ev.generating || wait > 0} onClick={ask}>{asking || ev.generating ? 'Writing…' : 'Write a fresh brief'}</button>
        {wait > 0 && <span className="muted small">available in {Math.ceil(wait / 60_000)} min (one per startup every {Math.round((ev.nextRequestAt - (b?.at ?? 0)) / 60_000)} min)</span>}
        {askErr && <span className="bad-text small">{askErr}</span>}
      </div>
      <p className="muted small">
        The model sees only the evidence on this page. It never decides anything here and gives no buy, sell or price advice; code removes any line
        that does, any line without a valid citation, and any number its sources don’t hold, and keeps the model’s inference apart from the facts.
        Recheck all of it without trusting us: <code>pnpm verify-brief {ev.startup.id}</code>.
      </p>
    </section>
  );
}

// ---------- founder links ----------

const where = (kind: LinkKind, target: string): string => {
  if (kind === 'x') return `Post it from @${target} on X, then paste the post’s URL.`;
  const owner = target.split('/')[0];
  return target.includes('/')
    ? `Commit it as a file (for example SIGNALFIRE.txt) to ${target}, or put it in a public gist as ${owner}; then paste the file’s or the gist’s URL.`
    : `Put it in a public gist as ${owner} (gist.github.com), or commit it to one of ${owner}’s repositories; then paste the URL.`;
};

function LinksPanel({ ev, s }: { ev: EvidenceView; s: Startup }) {
  const { account } = useApp();
  return (
    <section className="panel ev-group">
      <h2>Founder-linked sources</h2>
      <p className="muted small">{GROUPS[0].note}</p>
      {ev.links.length === 0 && <p className="small">No GitHub or X account linked{ev.summary.demo ? ' (a demo startup has none)' : ''}.</p>}
      <ul className="ev-links">
        {ev.links.map((l) => (
          <li key={`${l.kind}:${l.target}`}>
            <span className={`chip ${l.status === 'verified' ? 'ok' : 'warn'}`}>{l.status}</span>
            <a href={l.kind === 'x' ? `https://x.com/${l.target}` : `https://github.com/${l.target}`} target="_blank" rel="noreferrer">{l.kind === 'x' ? `X @${l.target}` : `GitHub ${l.target}`}</a>
            {l.status === 'verified' && l.proofUrl && <> · <a href={l.proofUrl} target="_blank" rel="noreferrer">proof</a></>}
          </li>
        ))}
      </ul>
      {account === s.founder
        ? <p className="small">You’re the founder: link and prove your accounts in the <strong>Founder’s desk</strong> (tab Treasury and campaigns).</p>
        : <p className="muted small">A founder gets the full brief by linking their GitHub and X and proving each one: their wallet signs a message naming this startup and the account, and they publish the signature from that account.</p>}
    </section>
  );
}

/** The founder's link-and-prove steps. Shown in the Founder's desk. */
export function FounderLinks({ s }: { s: Startup }) {
  const { state, account } = useApp();
  const { ev, load } = useEvidence(s.id);
  const [kind, setKind] = useState<LinkKind>('github');
  const [target, setTarget] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  if (!account || account !== s.founder) return null;
  const t = normalizeTarget(kind, target);
  const add = (): void => {
    if (!t) return;
    api<FounderLink[]>(`/evidence/${s.id}/links`, { kind, target: t }).then(() => { setTarget(''); setMsg(null); load(); }).catch((e: Error) => setMsg(e.message));
  };
  return (
    <div className="founder-form ev-founder" data-tour="founder-links" id="links">
      <h3>Link and prove your GitHub and X</h3>
      <p className="muted small">
        Backers see a research brief built from evidence. Without proven links it can only show your NEAR account and the onchain record. For each
        account: add it, sign one message with your wallet (it names {s.id.toUpperCase()}, you and the account; no transaction, no gas), publish the
        signature from that account, and paste the URL. We check it against your account’s full-access keys; anyone can recheck it later.
      </p>
      {(ev?.links ?? []).map((l) => <LinkRow key={`${l.kind}:${l.target}`} s={s} l={l} hub={state!.hub} reload={load} />)}
      <div className="row">
        <select value={kind} onChange={(e) => setKind(e.target.value as LinkKind)} aria-label="Kind of account">
          <option value="github">GitHub</option>
          <option value="x">X</option>
        </select>
        <input className="ev-input" value={target} onChange={(e) => setTarget(e.target.value)} placeholder={kind === 'github' ? 'user, org or owner/repo' : '@handle'} aria-label="Account" />
        <button className="ghost small" disabled={!t} onClick={add}>Add</button>
      </div>
      {target && !t && <p className="bad-text small">{kind === 'github' ? 'A GitHub user or org name, or owner/repo.' : 'An X handle: letters, digits and _, up to 15.'}</p>}
      {msg && <p className="bad-text small">{msg}</p>}
    </div>
  );
}

function LinkRow({ s, l, hub, reload }: { s: Startup; l: FounderLink; hub: string; reload: () => void }) {
  const [line, setLine] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(l.error ?? null);
  const claim = { startup: s.id, founder: s.founder, kind: l.kind, target: l.target };
  const sign = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      const message = linkMessage(claim, hub);
      const signed = await signMessage(message, hub, linkNonce(message));
      if (signed.accountId && signed.accountId !== s.founder) throw new Error(`the wallet signed as ${signed.accountId}, not ${s.founder}`);
      setLine(proofLine(claim, signatureToB58(signed.signature)));
    } catch (e) { setErr((e as Error).message || 'the wallet didn’t sign'); } finally { setBusy(false); }
  };
  const check = (): void => {
    setBusy(true);
    setErr(null);
    api<{ error: string | null }>(`/evidence/${s.id}/prove`, { kind: l.kind, target: l.target, url: url.trim() })
      .then(() => { setLine(null); setUrl(''); reload(); })
      .catch((e: Error) => setErr(e.message))
      .finally(() => setBusy(false));
  };
  const remove = (): void => { void api(`/evidence/${s.id}/unlink`, { kind: l.kind, target: l.target }).then(reload).catch((e: Error) => setErr(e.message)); };
  return (
    <div className="ev-linkrow">
      <p className="row">
        <span className={`chip ${l.status === 'verified' ? 'ok' : 'warn'}`}>{l.status}</span>
        <strong>{l.kind === 'x' ? `X @${l.target}` : `GitHub ${l.target}`}</strong>
        {l.proofUrl && <a className="small" href={l.proofUrl} target="_blank" rel="noreferrer">proof</a>}
        <button className="link small" onClick={remove}>remove</button>
      </p>
      {l.status !== 'verified' && (
        <ol className="ev-steps small">
          <li>
            <button className="ghost small" disabled={busy} onClick={() => void sign()}>Sign with my wallet</button>
            {line && <><code className="ev-line">{line}</code><button className="link small" onClick={() => void navigator.clipboard?.writeText(line)}>copy</button></>}
          </li>
          <li>{where(l.kind, l.target)}</li>
          <li className="row">
            <input className="ev-input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={l.kind === 'x' ? 'https://x.com/…/status/…' : 'https://gist.github.com/… or https://github.com/…/blob/…'} aria-label="Proof URL" />
            <button className="primary small" disabled={busy || !/^https:\/\//.test(url.trim())} onClick={check}>Check proof</button>
          </li>
        </ol>
      )}
      {err && <p className="bad-text small">{err}</p>}
    </div>
  );
}
