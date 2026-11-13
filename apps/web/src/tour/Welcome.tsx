import { useEffect, useRef } from 'react';
import { Flame, useApp } from '../ui.tsx';
import { PATHS, type X } from './paths.tsx';
import { tourStore, useTour, type PathId } from './state.ts';
import { progress } from './Checklist.tsx';
import { startPath } from './useX.ts';

// First visit (and the "?" button): what Signalfire is, in three sentences, and "who are you?". Skippable; the
// answer is remembered and the Get started checklist follows that path.

const ICON: Record<PathId, string> = {
  explore: 'M2 8s2.4-4.5 6-4.5S14 8 14 8s-2.4 4.5-6 4.5S2 8 2 8z M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  back: 'M3 13V9m3.3 4V6m3.4 7V8m3.3 5V3',
  create: 'M3 13l1-3.5L11 2.5l2.5 2.5L6.5 12zM9.5 4l2.5 2.5',
  found: 'M8 2c1.6 2.2 3.4 3.6 3.4 6.4A3.4 3.4 0 0 1 4.6 8.4C4.6 6.6 6 5.6 6.6 4c.8 1 1 1.8 1 2.6C8.6 5 8.4 3.4 8 2zM4 14h8',
};

export function Welcome({ x, onClose }: { x: X; onClose: () => void }) {
  const t = useTour();
  const { go } = useApp();
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    first.current?.focus();
    const esc = (e: KeyboardEvent): void => { if (e.key === 'Escape') skip(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const skip = (): void => { tourStore.set({ welcomed: true }); onClose(); };
  const pick = (p: PathId): void => { onClose(); startPath(p, x); };
  return (
    <div className="modal-bg" role="dialog" aria-modal="true" aria-labelledby="wl-title" onClick={skip}>
      <div className="modal welcome" onClick={(e) => e.stopPropagation()}>
        <p className="wl-brand"><Flame size={20} /> Signalfire</p>
        <h2 id="wl-title">Turn buzz into real customers.</h2>
        <p className="wl-lede">
          Each startup has an attention token. 2% of every trade goes into its marketing fund. That fund only pays reviewed
          creators (people and AI agents) whose sealed offer wins and whom the holders approve, and only as new buyers arrive.
        </p>
        <p className="wl-terms"><strong>Not equity, not a claim on revenue or on the marketing fund.</strong> Test network only: no real money anywhere.</p>
        <p className="wl-ask">Who are you?</p>
        <div className="wl-paths">
          {PATHS.map((p, i) => {
            const r = progress(p.id, x, t.seen);
            return (
              <button key={p.id} ref={i === 0 ? first : undefined} className={`wl-path${t.path === p.id ? ' on' : ''}`} onClick={() => pick(p.id)}>
                <svg viewBox="0 0 16 16" width="20" height="20" aria-hidden="true"><path d={ICON[p.id]} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
                <span className="wl-t">{p.title}</span>
                <span className="wl-who">{p.who}</span>
                <span className="wl-meta">{r.total} steps · {p.wallet ? 'needs a test wallet' : 'no wallet needed'}{r.done > 0 ? ` · ${r.done} done` : ''}</span>
              </button>
            );
          })}
        </div>
        <div className="row end wl-foot">
          <button className="link" onClick={() => { skip(); go('/how'); }}>How it works, end to end</button>
          <span className="tour-grow" />
          <button className="ghost" onClick={skip}>Skip for now</button>
        </div>
      </div>
    </div>
  );
}
