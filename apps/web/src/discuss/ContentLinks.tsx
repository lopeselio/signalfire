import { useState } from 'react';
import { api } from '../api.ts';
import { Acct, ago, useApp } from '../ui.tsx';
import type { Thread } from './Discussion.tsx';

// What the winning creator made for a campaign: links they post for backers to see. Never checked and never used
// for payouts; payouts follow the new buyers who came through the creator's link, onchain.

const host = (u: string): string => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

export function ContentLinks({ t, reload }: { t: Thread; reload: () => void }) {
  const { account, run, busy } = useApp();
  const [url, setUrl] = useState('');
  const [caption, setCaption] = useState('');
  const mine = !!account && account === t.creator;
  if (!t.linksOpen && t.links.length === 0) return null;

  let urlErr = '';
  if (url.trim()) {
    try { const u = new URL(url.trim()); if (u.protocol !== 'https:' && u.protocol !== 'http:') urlErr = 'Only http:// or https:// links.'; } catch { urlErr = 'That isn’t a web address yet (start with https://).'; }
  }
  const add = async (): Promise<void> => {
    const ok = await run('Post link', async () => { await api(`/campaign/${t.campaign}/discussion/link`, { url: url.trim(), caption: caption.trim() }); }, { pending: 'Posting your link…', done: 'Link posted on the campaign.' });
    if (ok) { setUrl(''); setCaption(''); }
    reload();
  };
  const remove = async (n: number): Promise<void> => {
    await run('Remove link', async () => { await api(`/campaign/${t.campaign}/discussion/unlink`, { n }); }, { pending: 'Removing the link…', done: 'Link removed.' });
    reload();
  };

  return (
    <div className="made">
      <h4>What the creator made</h4>
      <p className="muted small made-note">Posted by the creator for backers to see. Not checked, and never used for payouts: payouts follow new buyers who came through the creator’s link.</p>
      {t.links.length === 0 && <p className="muted small">{mine ? 'Nothing posted yet. Share your video or post below.' : 'The creator hasn’t posted anything yet.'}</p>}
      <ul className="made-list">
        {t.links.map((l) => (
          <li key={l.n}>
            <a href={l.url} target="_blank" rel="nofollow noopener noreferrer">{l.caption || host(l.url)}</a>
            <span className="muted small"> {l.caption ? `${host(l.url)} · ` : ''}by <Acct a={l.by} /> · {ago(l.at)}</span>
            {mine && l.by === account && <button className="link small" disabled={!!busy} onClick={() => void remove(l.n)}>Remove</button>}
          </li>
        ))}
      </ul>
      {mine && t.writes && t.linksOpen && (
        <form className="made-form" onSubmit={(e) => { e.preventDefault(); if (!urlErr && url.trim()) void add(); }}>
          <label className="small" htmlFor={`made-url-${t.campaign}`}>Link to your video or post</label>
          <input id={`made-url-${t.campaign}`} type="url" inputMode="url" value={url} maxLength={t.limits.url} placeholder="https://" aria-invalid={!!urlErr} onChange={(e) => setUrl(e.target.value)} />
          {urlErr && <p className="bad-text small">{urlErr}</p>}
          <label className="small" htmlFor={`made-cap-${t.campaign}`}>Caption (optional)</label>
          <input id={`made-cap-${t.campaign}`} value={caption} maxLength={t.limits.caption} placeholder="e.g. Launch video on YouTube" onChange={(e) => setCaption(e.target.value)} />
          <div className="row">
            <button className="primary small" type="submit" disabled={!!busy || !url.trim() || !!urlErr}>Post link</button>
            <span className="muted small">{t.limits.caption - [...caption].length} characters left in the caption</span>
          </div>
        </form>
      )}
    </div>
  );
}
