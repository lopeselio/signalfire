import { useEffect, useState } from 'react';
import { useApp } from '../ui.tsx';
import { PATHS, complete, pathById, type Step, type X } from './paths.tsx';
import { tourStore, useTour, type PathId } from './state.ts';
import { startPath } from './useX.ts';

// "Get started": each path's steps with a tick for what the visitor has really done (session, balances, council
// seats, votes, bids, launches), so a returning visitor sees where they are and can jump back into the tour.

/** A step that needs a feature counts only once this build was seen to have it (or the step was seen). */
export function shown(s: Step, seen: string[]): boolean {
  if (!s.requires) return true;
  return seen.includes(s.id) || tourStore.get().features.includes(s.requires) || !!document.querySelector(s.requires);
}

export function progress(path: PathId, x: X, seen: string[]): { done: number; total: number } {
  const steps = pathById(path).steps.filter((s) => shown(s, seen));
  return { done: steps.filter((s) => complete(s, x, seen)).length, total: steps.length };
}

export function Checklist({ x, onWelcome }: { x: X; onWelcome: () => void }) {
  const t = useTour();
  const { go } = useApp();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<PathId>(t.path ?? 'explore');
  useEffect(() => { if (t.path) setTab(t.path); }, [t.path]);
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [open]);
  if (!t.welcomed || t.tour || t.hideList) return null;

  const current = t.path ?? 'explore';
  const p = progress(current, x, t.seen);
  const path = pathById(tab);
  const steps = path.steps.map((s, i) => ({ s, i })).filter(({ s }) => shown(s, t.seen));
  const pp = progress(tab, x, t.seen);
  const finished = pp.done === pp.total;
  return (
    <>
      <button className={`gs-pill${p.done === p.total ? ' all' : ''}`} onClick={() => setOpen(!open)} aria-expanded={open} aria-controls="gs-panel">
        <span className="gs-ring" style={{ ['--p' as string]: `${(p.done / Math.max(p.total, 1)) * 100}%` }} aria-hidden="true" />
        Get started <span className="gs-n">{p.done}/{p.total}</span>
      </button>
      {open && (
        <section id="gs-panel" className="gs-panel" aria-label="Get started checklist">
          <header className="gs-head">
            <strong>Get started</strong>
            <button className="tour-x" onClick={() => setOpen(false)} aria-label="Close the checklist">×</button>
          </header>
          <div className="gs-tabs" role="tablist">
            {PATHS.map((q) => {
              const r = progress(q.id, x, t.seen);
              return (
                <button key={q.id} role="tab" aria-selected={tab === q.id} className={tab === q.id ? 'on' : ''} onClick={() => setTab(q.id)}>
                  {q.title}<small>{r.done}/{r.total}</small>
                </button>
              );
            })}
          </div>
          <p className="gs-blurb">{path.blurb}{path.wallet && !x.account && ' Needs a NEAR testnet wallet.'}</p>
          <ol className="gs-steps">
            {steps.map(({ s, i }) => {
              const ok = complete(s, x, t.seen);
              const waiting = !ok && s.wait ? s.wait(x) : null;
              return (
                <li key={s.id} className={ok ? 'ok' : ''}>
                  <button onClick={() => { setOpen(false); startPath(tab, x, i); }}>
                    <span className="gs-mark" aria-hidden="true">{ok ? '✓' : ''}</span>
                    <span className="gs-t">{s.title}{waiting && <small className="gs-wait">waiting</small>}</span>
                  </button>
                </li>
              );
            })}
          </ol>
          {finished && <p className="gs-done">All done on this path. Pick another, or read <a href="/how" onClick={(e) => { e.preventDefault(); setOpen(false); go('/how'); }}>How it works</a> end to end.</p>}
          <footer className="gs-foot">
            <button className="primary small" onClick={() => { setOpen(false); startPath(tab, x); }}>{t.path === tab && pp.done > 0 && !finished ? 'Resume tour' : 'Start tour'}</button>
            <button className="ghost small" onClick={() => { setOpen(false); onWelcome(); }}>Change path</button>
            <span className="tour-grow" />
            <button className="link small" onClick={() => { setOpen(false); tourStore.set({ hideList: true }); }}>Hide</button>
          </footer>
        </section>
      )}
    </>
  );
}
