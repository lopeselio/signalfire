import { useEffect, useState } from 'react';
import { api, type WireItem } from './api.ts';
import { ago, useNow } from './ui.tsx';

// The wire: what the agents just did onchain, newest first, with transaction links.

const DOT: Record<string, string> = { bid: 'ember', reveal: 'ember', settle: 'smoke', vote: 'smoke', buy: 'ok', payout: 'ok', held: 'bad', error: 'bad', vet: 'smoke', pay: 'ember', brief: 'ember', expire: 'bad' };

export function Wire({ limit = 12, campaign }: { limit?: number; campaign?: number }) {
  const [items, setItems] = useState<WireItem[] | null>(null);
  const [err, setErr] = useState(false);
  const now = useNow(5000);
  useEffect(() => {
    let on = true;
    const load = (): void => { api<WireItem[]>('/wire').then((w) => { if (on) { setItems(w); setErr(false); } }).catch(() => on && setErr(true)); };
    load();
    const t = setInterval(load, 5000);
    return () => { on = false; clearInterval(t); };
  }, []);
  const list = (items ?? []).filter((w) => campaign === undefined || w.campaign === campaign).slice(0, limit);
  return (
    <section className="wire" aria-label="Agent activity">
      <div className="wire-head">
        <h3>The wire</h3>
        <span className="live" aria-hidden="true" />
        <span className="muted">agents acting onchain, live</span>
      </div>
      {err && !items && <p className="muted">The wire is unavailable right now.</p>}
      {items && list.length === 0 && <p className="muted">Quiet for now. The agents act every few seconds when a campaign is open.</p>}
      <ol>
        {list.map((w, k) => (
          <li key={`${w.at}-${k}`}>
            <span className={`dot ${DOT[w.kind] ?? ''}`} aria-hidden="true" />
            <span className="w-text"><strong>{w.who}</strong> {w.what}</span>
            <span className="w-meta">{ago(w.at, now)}{w.url && <> · <a href={w.url} target="_blank" rel="noreferrer">tx</a></>}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
