import { useEffect } from 'react';
import { signalBurst } from './burst.ts';

// Torchlight: a warm, flickering glow follows the pointer behind the page's content, like a torch in a cave. In dark
// mode the page edges dim (a cave vignette) and the torch lifts the area around the pointer; in light mode it's a warm
// lamp-on-parchment wash with only a faint edge vignette, so content never darkens. The header flame leans toward the
// pointer. Clicking a main action button sends a small signal-fire burst from the click point.
// Off on touch screens (the click burst stays, smaller) and under prefers-reduced-motion (a still glow, no flicker or
// sparks). One rAF loop writes CSS variables only: no layout work.
export function CursorGlow() {
  useEffect(() => {
    const fine = matchMedia('(hover: hover) and (pointer: fine)').matches;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const root = document.documentElement;
    const click = (e: MouseEvent): void => {
      const b = (e.target as Element | null)?.closest?.('button.primary, button.go, a.primary');
      if (b && !(b as HTMLButtonElement).disabled && e.clientX + e.clientY > 0) signalBurst(e.clientX, e.clientY, fine ? 1 : 0.7);
    };
    document.addEventListener('click', click);
    if (!fine) return () => document.removeEventListener('click', click);

    root.classList.add('glow-on');
    let x = innerWidth / 2, y = -400, frame = 0, live = true;
    const t0 = performance.now();
    const tick = (now: number): void => {
      if (!live) return;
      // a torch's flicker: a few slow sines summed, so it breathes without strobing (radius ±4%, strength ±10%)
      const t = (now - t0) / 1000;
      const f = reduced ? 0 : Math.sin(t * 7.3) * 0.5 + Math.sin(t * 11.9 + 1.7) * 0.3 + Math.sin(t * 3.1 + 0.4) * 0.2;
      root.style.setProperty('--mx', `${x}px`);
      root.style.setProperty('--my', `${y}px`);
      root.style.setProperty('--tr', (1 + f * 0.04).toFixed(3));
      root.style.setProperty('--ta', (1 + f * 0.1).toFixed(3));
      const flame = document.querySelector<HTMLElement>('.brand .fm');
      if (flame) {
        const r = flame.getBoundingClientRect();
        const dx = x - (r.left + r.width / 2), dy = y - (r.top + r.height / 2);
        const near = Math.max(0, 1 - Math.hypot(dx, dy) / 260);
        root.style.setProperty('--lean', `${(Math.max(-1, Math.min(1, dx / 160)) * 12 * near).toFixed(2)}deg`);
        root.style.setProperty('--near', near.toFixed(3));
      }
      frame = reduced ? 0 : requestAnimationFrame(tick);
    };
    const move = (e: PointerEvent): void => { x = e.clientX; y = e.clientY; if (reduced) tick(performance.now()); };
    const leave = (): void => root.classList.add('glow-out');
    const enter = (): void => root.classList.remove('glow-out');
    addEventListener('pointermove', move, { passive: true });
    document.addEventListener('pointerleave', leave);
    document.addEventListener('pointerenter', enter);
    const vis = (): void => { if (document.hidden) { cancelAnimationFrame(frame); frame = 0; } else if (!frame && !reduced) frame = requestAnimationFrame(tick); };
    document.addEventListener('visibilitychange', vis);
    frame = requestAnimationFrame(tick);
    return () => {
      live = false;
      document.removeEventListener('click', click);
      removeEventListener('pointermove', move);
      document.removeEventListener('pointerleave', leave);
      document.removeEventListener('pointerenter', enter);
      document.removeEventListener('visibilitychange', vis);
      cancelAnimationFrame(frame);
      root.classList.remove('glow-on', 'glow-out');
    };
  }, []);
  return <><div className="cave" aria-hidden="true" /><div className="cursor-glow" aria-hidden="true" /></>;
}
