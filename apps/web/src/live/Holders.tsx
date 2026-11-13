import { useState } from 'react';
import { fmtTokens } from '@signalfire/core';
import type { Startup } from '../api.ts';
import { Info, ago, useApp, useNow } from '../ui.tsx';
import { useActivity } from './useActivity.ts';
import { useArrivals } from './useArrivals.ts';

// Who holds the token (share of the fixed supply), who sits on the holders' council (✓), and the council's recent
// votes. Read live from /api/s/:id/activity.

const pctText = (p: number): string => (p === 0 ? '0%' : p < 0.01 ? '<0.01%' : `${p.toFixed(2)}%`);

export function HoldersPanel({ s }: { s: Startup }) {
  const a = useActivity(s.id);
  const { account } = useApp();
  const now = useNow(5000);
  const [all, setAll] = useState(false);
  const sym = s.id.toUpperCase();
  const list = a?.holders.list ?? [];
  const rows = all ? list : list.slice(0, 8);
  const votes = (a?.votes ?? []).slice(0, 5);
  const freshVotes = useArrivals(votes.map((v) => v.id));
  return (
    <section className="panel holders-live" data-tour="holders-live">
      <h2>Holders</h2>
      <p className="muted small">
        Share of the fixed 1,000,000 {sym}. <span className="council-mark" aria-hidden="true">✓</span> on the holders’ council: one member, one vote on which campaigns get paid.
        <Info text={`Anyone holding at least ${fmtTokens(a?.holders.minToJoin ?? s.constraints.min_holder_tokens, 0)} ${sym} can join the council from the Marketing fund tab. Holding tokens is not equity and not a claim on revenue.`} />
      </p>
      {!a && <p className="muted small">Loading holders…</p>}
      {a && list.length === 0 && <p className="muted small">No holders yet.</p>}
      {rows.length > 0 && (
        <ol className="holders-list">
          {rows.map((h) => (
            <li key={h.account} className={h.account === account ? 'me' : ''}>
              <span className="h-name">
                <a href={`https://testnet.nearblocks.io/address/${h.account}`} target="_blank" rel="noreferrer" title={h.account}>{h.name}</a>
                {h.account === account && <span className="tag you">you</span>}
                {h.tag && <span className={`tag${h.tag.startsWith('AI') ? ' ai' : ''}`}>{h.tag}</span>}
                {h.council && <span className="council-mark" title="On the holders’ council" aria-label="on the holders’ council">✓</span>}
              </span>
              <span className="h-bal">{fmtTokens(h.balance, 0)} {sym}</span>
              <span className="h-pct">{pctText(h.pct)}</span>
              <span className="h-bar" aria-hidden="true"><i style={{ width: `${Math.min(100, (h.pct / Math.max(list[0]?.pct ?? 1, 0.0001)) * 100)}%` }} /></span>
            </li>
          ))}
        </ol>
      )}
      {list.length > 8 && <button className="link small" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${list.length}`}</button>}
      <h3 className="h-votes-title">Recent votes</h3>
      {a && votes.length === 0 && <p className="muted small">No council votes yet. A vote opens when a campaign has a winning offer.</p>}
      <ul className="votes-live">
        {votes.map((v) => (
          <li key={v.id} className={`${v.vote}${freshVotes.has(v.id) ? ' flash' : ''}`}>
            <span>{v.text}</span>
            <span className="tape-meta">{ago(v.at, now)}{v.url && <> · <a href={v.url} target="_blank" rel="noreferrer" title="The public transaction on NEAR">view</a></>}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
