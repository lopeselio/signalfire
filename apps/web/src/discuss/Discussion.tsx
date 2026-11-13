import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api } from '../api.ts';
import { Acct, Chip, SignInHint, ago, useApp, useNow } from '../ui.tsx';
import { ContentLinks } from './ContentLinks.tsx';
import './discuss.css';

// A campaign's talk: the winning creator's posted links and a plain-text discussion (apps/server/src/discuss.ts).
// Everything here is shown as text: no HTML from anyone is ever rendered, and links open in a new tab without
// passing on who sent you.

export interface Thread {
  campaign: number; writes: boolean; linksOpen: boolean; creator: string | null; founder: string; note: string;
  limits: { comment: number; caption: number; url: number; perMinute: number; perDay: number };
  links: { n: number; url: string; caption: string; by: string; at: number }[];
  comments: { n: number; by: string; badge: 'Creator' | 'Founder' | 'Holder' | null; at: number; hidden: boolean; text: string | null }[];
}

const URL_RE = /https?:\/\/[^\s<>"'`]+/g;

/** Plain text with its http(s) addresses as links. React escapes everything else. */
export function Linkified({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    let href = m[0];
    const trail = /[.,;:!?)\]]+$/.exec(href)?.[0] ?? '';
    href = href.slice(0, href.length - trail.length);
    const at = m.index ?? 0;
    let ok = false;
    try { const u = new URL(href); ok = u.protocol === 'https:' || u.protocol === 'http:'; } catch { /* plain text */ }
    if (!ok) continue;
    out.push(text.slice(last, at));
    out.push(<a key={at} href={href} target="_blank" rel="nofollow noopener noreferrer">{href}</a>);
    last = at + href.length;
  }
  out.push(text.slice(last));
  return <>{out}</>;
}

const BADGE: Record<string, { kind: string; title: string }> = {
  Creator: { kind: 'ember', title: 'Won this campaign and is making its content' },
  Founder: { kind: 'ok', title: 'Runs this startup' },
  Holder: { kind: 'smoke', title: 'On the holders’ council: votes on campaign funding' },
};

export function Discussion({ campaign }: { campaign: number }) {
  const { account, run, busy } = useApp();
  const now = useNow(30_000);
  const [t, setT] = useState<Thread | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [text, setText] = useState('');

  const load = useCallback(() => {
    api<Thread>(`/campaign/${campaign}/discussion`).then((x) => { setT(x); setErr(null); }).catch((e: Error) => setErr(e.message));
  }, [campaign]);
  useEffect(() => {
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [load]);

  if (!t) return err ? <p className="muted small">The discussion isn’t loading right now.</p> : null;

  const founder = account === t.founder;
  const post = async (): Promise<void> => {
    const body = text.trim();
    if (!body) return;
    const ok = await run('Post comment', async () => { await api(`/campaign/${campaign}/discussion/comment`, { text: body }); }, { pending: 'Posting your comment…', done: 'Comment posted.', wallet: false });
    if (ok) setText('');
    load();
  };
  const hide = async (n: number): Promise<void> => {
    if (!window.confirm('Hide this comment for everyone? It stays listed as hidden by the founder.')) return;
    await run('Hide comment', async () => { await api(`/campaign/${campaign}/discussion/hide`, { n }); }, { pending: 'Hiding the comment…', done: 'Comment hidden.', wallet: false });
    load();
  };
  const left = t.limits.comment - [...text].length;

  return (
    <section className="talk" aria-label="Creator’s posts and discussion">
      <ContentLinks t={t} reload={load} />
      <h4>Discussion {t.comments.length > 0 && <span className="muted small">({t.comments.length})</span>}</h4>
      {t.comments.length === 0 && <p className="empty small">No comments yet. Ask the creator about their plan, or share what you saw.</p>}
      <ol className="talk-list">
        {t.comments.map((c) => (
          <li key={c.n} className={c.hidden ? 'hidden' : ''}>
            <div className="talk-meta">
              <Acct a={c.by} />
              {c.badge && <span title={BADGE[c.badge].title}><Chip kind={BADGE[c.badge].kind}>{c.badge}</Chip></span>}
              <span className="muted small" title={new Date(c.at).toLocaleString()}>{ago(c.at, now)}</span>
              {founder && !c.hidden && <button className="link small talk-hide" disabled={!!busy} onClick={() => void hide(c.n)}>Hide</button>}
            </div>
            {c.hidden ? <p className="muted small talk-text">Comment hidden by the founder.</p> : <p className="talk-text"><Linkified text={c.text ?? ''} /></p>}
          </li>
        ))}
      </ol>
      {!t.writes && <p className="muted small">Posting is paused on this server for now. You can still read everything.</p>}
      {t.writes && !account && <SignInHint what="join the discussion" />}
      {t.writes && account && (
        <form className="talk-form" onSubmit={(e) => { e.preventDefault(); void post(); }}>
          <label className="small" htmlFor={`talk-${campaign}`}>Add a comment</label>
          <textarea id={`talk-${campaign}`} value={text} maxLength={t.limits.comment} rows={3} placeholder="Plain text. Links start with https://" onChange={(e) => setText(e.target.value)} />
          <div className="row">
            <button className="primary small" type="submit" disabled={!!busy || !text.trim() || left < 0}>Post</button>
            <span className={`muted small${left < 40 ? ' warn-text' : ''}`}>{left} characters left · up to {t.limits.perMinute} a minute</span>
          </div>
        </form>
      )}
    </section>
  );
}
