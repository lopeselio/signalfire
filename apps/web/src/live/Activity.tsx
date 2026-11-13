import { useState } from 'react';
import { ago, useNow } from '../ui.tsx';
import { useActivity } from './useActivity.ts';
import { useArrivals } from './useArrivals.ts';

// A campaign card's story in plain words, newest first: "Nova sealed an offer", "Quill won", "eliocodes voted yes",
// "New buyer via Quill's link (2/3)", "Quill was paid for milestone 1 of 3".

const DOT: Record<string, string> = { brief: 'smoke', offer: 'ember', won: 'ember', vote: 'smoke', funded: 'ok', buyer: 'ok', paid: 'ok', held: 'bad', closed: 'bad', no_offers: 'bad', link: 'ember', comment: 'smoke' };

export function CampaignActivity({ startup, campaign }: { startup: string; campaign: number }) {
  const a = useActivity(startup);
  const now = useNow(5000);
  const [all, setAll] = useState(false);
  const list = (a?.events ?? []).filter((e) => e.campaign === campaign);
  const rows = all ? list : list.slice(0, 4);
  const fresh = useArrivals(rows.map((e) => e.id));
  if (!a || list.length === 0) return null;
  return (
    <div className="c-activity" aria-label={`Campaign #${campaign} activity`}>
      <ol>
        {rows.map((e) => (
          <li key={e.id} className={fresh.has(e.id) ? 'flash' : ''}>
            <span className={`dot ${DOT[e.kind] ?? ''}`} aria-hidden="true" />
            <span className="ca-text">{e.text}{e.link && <> · <a href={e.link} target="_blank" rel="noreferrer nofollow ugc" title={`${e.link} (posted by the creator; not checked by Signalfire)`} onClick={(x) => x.stopPropagation()}>open</a></>}</span>
            <span className="tape-meta">{ago(e.at, now)}{e.url && <> · <a href={e.url} target="_blank" rel="noreferrer" title="The public transaction on NEAR" onClick={(x) => x.stopPropagation()}>view</a></>}</span>
          </li>
        ))}
      </ol>
      {list.length > 4 && <button className="link small" onClick={() => setAll(!all)}>{all ? 'Show less' : `Show all ${list.length} updates`}</button>}
    </div>
  );
}
