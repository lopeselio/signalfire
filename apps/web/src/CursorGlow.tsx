import { useEffect } from 'react';

// A soft warm glow that follows the pointer, behind the page's content, and the header flame leaning toward the
// pointer when it comes near. Visual only. Off on touch screens (coarse pointers) and under prefers-reduced-motion.
// One pointermove listener, throttled to animation frames; it only writes CSS variables, so there's no layout work.
export function CursorGlow() {
  useEffect(() => {
    if (!matchMedia('(hover: hover) and (pointer: fine)').matches || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const root = document.documentElement;
    root.classList.add('glow-on');
    let x = 0, y = 0, frame = 0;
    const paint = (): void => {
      frame = 0;
      root.style.setProperty('--mx', `${x}px`);
      root.style.setProperty('--my', `${y}px`);
      const flame = document.querySelector<HTMLElement>('.brand .fm');
      if (flame) {
        const r = flame.getBoundingClientRect();
        const dx = x - (r.left + r.width / 2), dy = y - (r.top + r.height / 2);
        const near = Math.max(0, 1 - Math.hypot(dx, dy) / 260); // 0 far away … 1 on top of it
        root.style.setProperty('--lean', `${(Math.max(-1, Math.min(1, dx / 160)) * 12 * near).toFixed(2)}deg`);
        root.style.setProperty('--near', near.toFixed(3));
      }
    };
    const move = (e: PointerEvent): void => { x = e.clientX; y = e.clientY; if (!frame) frame = requestAnimationFrame(paint); };
    const leave = (): void => root.classList.add('glow-out');
    const enter = (): void => root.classList.remove('glow-out');
    addEventListener('pointermove', move, { passive: true });
    document.addEventListener('pointerleave', leave);
    document.addEventListener('pointerenter', enter);
    return () => {
      removeEventListener('pointermove', move);
      document.removeEventListener('pointerleave', leave);
      document.removeEventListener('pointerenter', enter);
      if (frame) cancelAnimationFrame(frame);
      root.classList.remove('glow-on', 'glow-out');
    };
  }, []);
  return <div className="cursor-glow" aria-hidden="true" />;
}
