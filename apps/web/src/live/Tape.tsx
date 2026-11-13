import { useState } from 'react';
import { ago, useNow } from '../ui.tsx';
import { useActivity, useActivityError } from './useActivity.ts';
import { useArrivals } from './useArrivals.ts';

// The live trades tape on a startup's Market tab: newest first, a short flash when a trade arrives, sells in red,
// the simulated buyers tagged "AI fan", buys through a creator's link tagged with that link, each row linked to
// its transaction on nearblocks (or to the account when the transaction isn't known).

export function Tape({ id }: { id: string }) {
  const a = useActivity(id);
  const err = useActivityError(id);
  const now = useNow(1000);
  const [more, setMore] = useState(false);
  const rows = (a?.trades ?? []).slice(0, more ? 60 : 12);
  const fresh = useArrivals(rows.map((t) => t.id));
  return (
    <section className="tape" aria-label="Live trades" data-tour="tape">
      <div className="tape-head">
        <h3>Live trades</h3>
        <span className={`live${err ? ' off' : ''}`} aria-hidden="true" />
        <span className="muted small">{err ? 'reconnecting…' : a?.stale ? 'NEAR is slow to answer; showing the last read' : 'updates every 2 seconds'}</span>
      </div>
      {!a && !err && <p className="muted small">Loading trades…</p>}
      {a && a.trades.length === 0 && <p className="muted small">No trades yet. The first buy sets the price moving.</p>}
      <ol className="tape-list" aria-live="polite">
        {rows.map((t) => (
          <li key={t.id} className={`tape-row ${t.side}${fresh.has(t.id) ? ' flash' : ''}`}>
            <span className="tape-side" aria-hidden="true">{t.side === 'buy' ? '▲' : '▼'}</span>
            <span className="tape-text">
              <span title={t.account}>{t.text}</span>
              {t.tag === 'AI fan' && <span className="tag ai" title="One of Signalfire’s simulated buyers (an AI agent with its own wallet)">AI fan</span>}
              {t.tag && t.tag !== 'AI fan' && <span className="tag">{t.tag}</span>}
              {t.ref !== null && t.side === 'buy' && (
                <span className={`tag ref${t.attributed !== null ? ' counted' : ''}`} title={t.attributed !== null ? 'Counted as a new buyer for this campaign' : 'Bought through the link, but not counted (not a first buy, under 0.05 NEAR, or the campaign wasn’t running)'}>
                  via {t.via ? `${t.via}’s` : 'a creator’s'} link (#{t.ref})
                </span>
              )}
            </span>
            <span className="tape-meta">
              {ago(t.at, now)} · <a href={t.url} target="_blank" rel="noreferrer" title={t.tx ? 'The public transaction on NEAR' : 'This account on NEAR (the transaction isn’t known to Signalfire)'}>{t.tx ? 'view' : 'account'}</a>
            </span>
          </li>
        ))}
      </ol>
      {a && a.trades.length > 12 && <button className="link small" onClick={() => setMore(!more)}>{more ? 'Show fewer' : 'Show more trades'}</button>}
    </section>
  );
}
