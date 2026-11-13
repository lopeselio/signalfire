import { useEffect, useRef, useState } from 'react';
import { api, type State, type WireItem } from './api.ts';

// Pump.fun-style live alerts: the moment something happens on Signalfire (an AI fan buys through a creator's link, a
// creator seals an offer, holders vote, a creator gets paid, a founder posts a brief), a small card pops in at the top
// right and the newest one gives a little shake. Read from the same activity feed as "Live activity" (/api/wire).
// People's own wallet trades go through the relayer and show on each startup's trades tape instead.

const KINDS: Record<string, { icon: string; tone: string }> = {
  buy: { icon: '🟢', tone: 'buy' },
  payout: { icon: '💸', tone: 'pay' },
  bid: { icon: '🔒', tone: 'bid' },
  brief: { icon: '📣', tone: 'brief' },
  vote: { icon: '🗳️', tone: 'vote' },
  settle: { icon: '🏆', tone: 'win' },
};
const MUTE_KEY = 'signalfire:alerts-muted';
const SHOW_MS = 6000;
const MAX = 3;

interface Alert { id: string; item: WireItem; at: number }

const readMuted = (): boolean => { try { return localStorage.getItem(MUTE_KEY) === '1'; } catch { return false; } };

export function LiveAlerts({ state, go }: { state: State | null; go: (path: string) => void }) {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [muted, setMuted] = useState<boolean>(readMuted);
  const seen = useRef<Set<string> | null>(null); // null until the first read: old activity never pops up

  useEffect(() => {
    if (muted) return;
    let on = true;
    const load = (): void => {
      if (document.hidden) return;
      api<WireItem[]>('/wire').then((items) => {
        if (!on) return;
        const key = (w: WireItem): string => `${w.at}|${w.who}|${w.what}`;
        if (seen.current === null) { seen.current = new Set(items.map(key)); return; }
        const fresh = items.filter((w) => !seen.current!.has(key(w)) && KINDS[w.kind]).sort((a, b) => a.at - b.at);
        items.forEach((w) => seen.current!.add(key(w)));
        if (fresh.length === 0) return;
        const now = Date.now();
        setAlerts((cur) => [...fresh.slice(-MAX).reverse().map((w, i) => ({ id: `${key(w)}|${now}|${i}`, item: w, at: now })), ...cur].slice(0, MAX));
      }).catch(() => undefined);
    };
    load();
    const t = setInterval(load, 3000);
    return () => { on = false; clearInterval(t); };
  }, [muted]);

  useEffect(() => {
    if (alerts.length === 0) return;
    const t = setInterval(() => setAlerts((cur) => cur.filter((a) => Date.now() - a.at < SHOW_MS)), 500);
    return () => clearInterval(t);
  }, [alerts.length]);

  const toggle = (): void => {
    const next = !muted;
    setMuted(next);
    if (next) setAlerts([]);
    seen.current = null;
    try { localStorage.setItem(MUTE_KEY, next ? '1' : '0'); } catch { /* storage blocked: this visit only */ }
  };
  const startupOf = (c?: number): string | null => (c === undefined ? null : state?.campaigns.find((x) => x.id === c)?.startup ?? null);

  return (
    <div className="live-alerts" aria-live="polite">
      {alerts.map((a, i) => {
        const k = KINDS[a.item.kind];
        const st = startupOf(a.item.campaign);
        return (
          <button key={a.id} className={`la-card la-${k.tone}${i === 0 ? ' la-new' : ''}`}
            onClick={() => (st ? go(`/s/${st}`) : a.item.url ? window.open(a.item.url, '_blank', 'noopener') : undefined)}
            title={st ? `Open ${st.toUpperCase()}` : 'Open the transaction'}>
            <span className="la-icon" aria-hidden="true">{k.icon}</span>
            <span className="la-text"><strong>{a.item.who}</strong> {a.item.what}</span>
          </button>
        );
      })}
      <button className="la-mute ghost small" onClick={toggle} aria-pressed={muted} title={muted ? 'Live alerts are off' : 'Live alerts are on'}>
        {muted ? '🔕 Alerts off' : '🔔 Live'}
      </button>
    </div>
  );
}
