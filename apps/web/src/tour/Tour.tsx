import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { useApp } from '../ui.tsx';
import { complete, firstVia, pathById, type Path, type Step, type Via, type X } from './paths.tsx';
import { shown } from './Checklist.tsx';
import { tourStore, useTour } from './state.ts';

// The hands-on tour: a ring over the real element for the current step and a card beside it (a sheet at the bottom
// on phones). Clicks go straight through to the page: the ring only dims around the element. A step with `done`
// ticks itself when real state changes (signed in, bought, voted…), shows what to look for, then moves on.

const AUTO_NEXT_MS = 7000;
const PAD = 6;

type Box = { top: number; left: number; width: number; height: number };
type Found = { mode: 'target' | 'via' | 'none'; box: Box | null; via: Via | null };

const pathOf = (route: string): string => route.split('?')[0];

function visible(el: Element | null): el is HTMLElement {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/** The first visible match (campaign cards repeat hooks: the open one wins). */
function find(sel: string): HTMLElement | null {
  for (const el of Array.from(document.querySelectorAll(sel))) if (visible(el)) return el as HTMLElement;
  return null;
}

/** Follows the step's element (or its `via`) every frame while the step is on screen. */
function useFound(step: Step): Found {
  const [f, setF] = useState<Found>({ mode: 'none', box: null, via: null });
  const last = useRef('');
  useEffect(() => {
    let raf = 0;
    const loop = (): void => {
      const t = step.target ? find(step.target) : null;
      const fv = !t ? firstVia(step.via, find) : null;
      const v = fv?.el ?? null;
      const el = t ?? v;
      const r = el?.getBoundingClientRect();
      const box = r ? { top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height) } : null;
      const mode = t ? 'target' : v ? 'via' : 'none';
      const key = `${mode}:${box ? `${box.top},${box.left},${box.width},${box.height}` : ''}`;
      const k2 = `${key}:${fv?.via.sel ?? ''}`;
      if (k2 !== last.current) { last.current = k2; setF({ mode, box, via: fv?.via ?? null }); }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [step]);
  return f;
}

type Ring = { style: CSSProperties; via: boolean } | null;

export function Tour({ x }: { x: X }) {
  const t = useTour();
  // the ring outlives each step's card, so it glides from one element to the next
  const [ring, setRing] = useState<Ring>(null);
  const on = !!t.tour;
  useEffect(() => { if (!on) setRing(null); }, [on]);
  if (!t.tour) return null;
  const path = pathById(t.tour.path);
  const index = Math.min(Math.max(t.tour.index, 0), path.steps.length - 1);
  return (
    <>
      {ring && <div className={`tour-ring${ring.via ? ' via' : ''}`} style={ring.style} aria-hidden="true" />}
      <TourStep key={`${path.id}:${index}`} path={path} index={index} x={x} seen={t.seen} setRing={setRing} />
    </>
  );
}

function TourStep({ path, index, x, seen, setRing }: { path: Path; index: number; x: X; seen: string[]; setRing: (r: Ring) => void }) {
  const { go } = useApp();
  const step = path.steps[index];
  const found = useFound(step);
  const done = step.done ? step.done(x) : false;
  const wasDone = useRef(done);
  const [justDone, setJustDone] = useState(false);
  const [stay, setStay] = useState(false);
  /** what the view was last brought to: the fallback, then the real element once it shows up */
  const scrolled = useRef<'via' | 'target' | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const [cardH, setCardH] = useState(220);
  const narrow = typeof window !== 'undefined' && window.innerWidth < 720;
  const route = step.route?.(x);
  const offRoute = !!route && location.pathname !== pathOf(route);

  const advance = (): void => {
    const steps = path.steps;
    const s = tourStore.get().seen;
    let j = index + 1;
    while (j < steps.length && complete(steps[j], x, s)) j++;
    if (j >= steps.length) { tourStore.set({ tour: null }); return; }
    tourStore.set({ tour: { path: path.id, index: j } });
  };

  // go where the step happens when it starts; if the session loads a moment later and the place changes (your own
  // startup instead of /launch), follow it, unless the visitor has already moved on
  const auto = useRef<{ route: string | null; at: number }>({ route: null, at: Date.now() });
  useEffect(() => {
    if (!route) return;
    const a = auto.current;
    const first = a.route === null;
    const follow = !first && route !== a.route && Date.now() - a.at < 6000 && location.pathname === pathOf(a.route!);
    if (first || follow) {
      auto.current = { route, at: a.at };
      if (offRoute) go(route);
    }
  }, [route]); // eslint-disable-line react-hooks/exhaustive-deps

  // bring the element into view the first time it shows up (again when a tab or card opens onto the real one)
  useEffect(() => {
    if (found.mode === 'none' || !found.box || scrolled.current === 'target' || scrolled.current === found.mode) return;
    scrolled.current = found.mode;
    const el = (found.mode === 'target' && step.target && find(step.target)) || firstVia(step.via, find)?.el;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const head = 70;
    const room = narrow ? window.innerHeight - cardH - head - 16 : window.innerHeight - head - 24;
    const y = r.height > room ? r.top - head - 8 : r.top - head - Math.max(0, (room - r.height) / 2);
    if (r.top < head || r.bottom > head + room) window.scrollBy({ top: y, behavior: 'smooth' });
  }, [found.mode, found.box, step, narrow, cardH]);

  // a step for a feature this build doesn't have: move on quietly once its page has had time to render
  useEffect(() => {
    const req = step.requires;
    if (!req || tourStore.get().features.includes(req)) return;
    const id = setTimeout(() => {
      if (document.querySelector(req)) tourStore.hasFeature(req);
      else advance();
    }, 2500);
    return () => clearTimeout(id);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // the user did it: say what to look for, then move on
  useEffect(() => {
    if (done && !wasDone.current) setJustDone(true);
    wasDone.current = done;
  }, [done]);
  useEffect(() => {
    if (!justDone || stay) return;
    const id = setTimeout(advance, AUTO_NEXT_MS);
    return () => clearTimeout(id);
  }, [justDone, stay]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => { if (card.current) setCardH(card.current.offsetHeight); });

  const box = found.box;
  const ring: { top: number; left: number; width: number; height: number } | null = box ? (() => {
    const top = Math.max(box.top - PAD, 4);
    const bottom = Math.min(box.top + box.height + PAD, window.innerHeight - 4);
    return { top, left: box.left - PAD, width: box.width + PAD * 2, height: Math.max(bottom - top, 24) };
  })() : null;
  const ringKey = ring && found.mode !== 'none' ? `${found.mode}:${ring.top},${ring.left},${ring.width},${ring.height}` : '';
  const born = useRef(Date.now());
  useEffect(() => {
    if (ring && found.mode !== 'none') { setRing({ style: ring, via: found.mode === 'via' }); return; }
    // a new step's element may take a frame or a page change to appear: keep the old ring briefly so it can glide
    const id = setTimeout(() => setRing(null), Math.max(0, 600 - (Date.now() - born.current)));
    return () => clearTimeout(id);
  }, [ringKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const pos = placeCard(box, narrow, cardH);
  const wait = !done && step.wait ? step.wait(x) : null;
  // count only the steps this build has (a step for a missing feature is skipped)
  const counted = path.steps.filter((s, k) => k === index || shown(s, seen));
  const total = counted.length;
  const n = counted.indexOf(step) + 1;

  return (
    <>
      <div ref={card} className={`tour-card${narrow ? ' sheet' : ''}${!box ? ' free' : ''}`} style={pos} role="dialog" aria-modal="false" aria-labelledby="tour-title">
        <div className="tour-top">
          <span className="tour-path">{path.title} · step {n} of {total}</span>
          <button className="tour-x" onClick={() => tourStore.set({ tour: null })} aria-label="Pause the tour (Get started resumes it)">×</button>
        </div>
        <div className="tour-bar" aria-hidden="true">{counted.map((s) => <span key={s.id} className={s === step ? 'now' : complete(s, x, seen) ? 'done' : ''} />)}</div>
        <h3 id="tour-title">{done && <span className="tour-tick" aria-label="done">✓</span>}{step.title}</h3>
        {found.mode === 'via' && found.via && !done && <p className="tour-via">{found.via.text}</p>}
        {offRoute && found.mode === 'none' && route && (
          <p className="tour-via">This happens on another page. <button className="link" onClick={() => go(route)}>Take me there</button></p>
        )}
        {(!done || !step.after) && <div className="tour-body">{step.body(x)}</div>}
        {wait && <p className="tour-wait"><Clock /> <span>{wait}</span></p>}
        {done && step.after && <div className="tour-after"><strong>Done.</strong> Look for: {step.after(x)}</div>}
        <p className="tour-cost"><strong>Cost</strong> {step.cost}</p>
        <div className="tour-actions">
          {index > 0 && <button className="ghost small" onClick={() => tourStore.set({ tour: { path: path.id, index: index - 1 } })}>Back</button>}
          <span className="tour-grow" />
          {justDone && !stay && <button className="ghost small" onClick={() => setStay(true)}>Stay here</button>}
          {step.done && !done && <button className="ghost small" onClick={advance}>Skip</button>}
          {(!step.done || done) && (
            <button className={`primary small${justDone ? ' pulse' : ''}`} onClick={() => { if (!step.done) tourStore.see(step.id); advance(); }}>
              {n === total ? 'Finish' : 'Next'}
            </button>
          )}
        </div>
      </div>
    </>
  );
}

/** Beside the element where there's room (right, left, below, above); a sheet on phones; bottom right otherwise. */
function placeCard(box: Box | null, narrow: boolean, h: number): CSSProperties {
  if (narrow) return {};
  const W = 340;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const gap = 16;
  if (!box) return { right: 24, bottom: 24 };
  const clampTop = (t: number): number => Math.min(Math.max(t, 72), vh - h - 12);
  const clampLeft = (l: number): number => Math.min(Math.max(l, 12), vw - W - 12);
  if (vw - (box.left + box.width) >= W + gap * 2) return { left: box.left + box.width + gap, top: clampTop(box.top) };
  if (box.left >= W + gap * 2) return { left: box.left - W - gap, top: clampTop(box.top) };
  if (vh - (box.top + box.height) >= h + gap * 2) return { left: clampLeft(box.left), top: box.top + box.height + gap };
  if (box.top - 72 >= h + gap * 2) return { left: clampLeft(box.left), top: box.top - h - gap };
  return { right: 24, bottom: 24 };
}

const Clock = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M8 4.6V8l2.4 1.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
);
