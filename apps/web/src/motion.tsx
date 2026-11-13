import { useEffect, useRef, useState, type RefObject } from 'react';

// Signalfire's motion language. One easing, three durations (CSS: --ease, --dur-1/2/3 in style.css); the tour uses
// the same tokens. Everything here stands still under prefers-reduced-motion.

export const EASE = 'cubic-bezier(0.2, 0.7, 0.1, 1)';
export const DUR = { quick: 160, base: 320, slow: 640 } as const;
export const reducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const ease = (t: number): number => 1 - Math.pow(1 - t, 3);

/**
 * A number that counts up to its value the first time it scrolls into view, and glides to a new value when the
 * chain data changes. `value` is the formatted number ("0.987", "12", "1,204"); its decimals and commas are kept.
 */
export function Count({ value }: { value: string }) {
  const clean = value.replace(/,/g, '');
  const target = Number(clean);
  const decimals = clean.includes('.') ? clean.length - clean.indexOf('.') - 1 : 0;
  const ref = useRef<HTMLSpanElement>(null);
  const from = useRef(0);
  const [shown, setShown] = useState(target);
  const seen = useRef(false);

  useEffect(() => {
    if (!Number.isFinite(target) || reducedMotion() || !ref.current) { setShown(target); return; }
    let raf = 0;
    const run = (): void => {
      const a = from.current, t0 = performance.now(), ms = seen.current ? DUR.slow : 1200;
      seen.current = true;
      const step = (now: number): void => {
        const k = Math.min(1, (now - t0) / ms);
        const v = a + (target - a) * ease(k);
        from.current = v;
        setShown(v);
        if (k < 1) raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    };
    if (seen.current) { run(); return () => cancelAnimationFrame(raf); }
    setShown(0);
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { io.disconnect(); run(); } }, { rootMargin: '0px 0px -5% 0px' });
    io.observe(ref.current);
    return () => { io.disconnect(); cancelAnimationFrame(raf); };
  }, [target]);

  if (!Number.isFinite(target)) return <span>{value}</span>;
  const text = shown.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: value.includes(',') });
  return <span ref={ref}><span aria-hidden="true">{text}</span><span className="sr-only">{value}</span></span>;
}

/** Sections marked `.rv` inside the returned element rise in as they scroll into view (CSS does the motion). */
export function useReveal<T extends HTMLElement>(): RefObject<T | null> {
  const ref = useRef<T>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const items = [...root.querySelectorAll<HTMLElement>('.rv')];
    if (reducedMotion() || typeof IntersectionObserver !== 'function') { items.forEach((x) => x.classList.add('in')); return; }
    const io = new IntersectionObserver((es) => {
      for (const e of es) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    }, { rootMargin: '0px 0px -8% 0px' });
    items.forEach((x) => io.observe(x));
    return () => io.disconnect();
  }, []);
  return ref;
}

/**
 * Whether the returned element has scrolled into view yet (true from then on). Under prefers-reduced-motion, or
 * without IntersectionObserver, it is true at once, so anything keyed on it shows its final state immediately. React
 * owns the class it drives (`in`), so data reloads never hide what has been shown, and items added later animate on
 * mount inside a container that is already in view.
 */
export function useSeen<T extends HTMLElement>(margin = '0px 0px -10% 0px'): [RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(() => reducedMotion() || typeof IntersectionObserver !== 'function');
  useEffect(() => {
    const el = ref.current;
    if (seen || !el) return;
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setSeen(true); io.disconnect(); } }, { rootMargin: margin });
    io.observe(el);
    return () => io.disconnect();
  });
  return [ref, seen];
}
