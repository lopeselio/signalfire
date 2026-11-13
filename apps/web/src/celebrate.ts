import { useEffect, useRef } from 'react';
import { reducedMotion } from './motion.tsx';

// A light burst of confetti for the good moments (your campaign is funded, a payout lands, you win an offer, you're
// admitted as a creator). A small canvas, no library; nothing at all under prefers-reduced-motion; each event at
// most once per browser.

const KEY = 'signalfire.celebrated';
const COLORS = ['#f26b1d', '#ffc93c', '#16834a', '#ff8fb1', '#5b8def', '#fff3c4'];

function seen(id: string): boolean {
  try { return (JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[]).includes(id); } catch { return false; }
}
function remember(id: string): void {
  try {
    const l = JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[];
    localStorage.setItem(KEY, JSON.stringify([...l, id].slice(-200)));
  } catch { /* private window: once per page load is still true */ }
}

let running = false;
/** Throw confetti once (if motion is allowed). */
export function confetti(): void {
  if (running || reducedMotion() || typeof document === 'undefined') return;
  running = true;
  const c = document.createElement('canvas');
  c.className = 'confetti';
  c.setAttribute('aria-hidden', 'true');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = window.innerWidth, h = window.innerHeight;
  c.width = w * dpr; c.height = h * dpr;
  document.body.appendChild(c);
  const g = c.getContext('2d');
  if (!g) { c.remove(); running = false; return; }
  g.scale(dpr, dpr);
  // a fixed spread (no randomness needed): pieces fan out from two points near the top corners
  const n = 90;
  const ps = Array.from({ length: n }, (_, i) => {
    const left = i % 2 === 0;
    const k = i / n;
    const ang = (left ? -60 : -120) + ((i * 37) % 50) - 25;
    const sp = 9 + ((i * 53) % 7);
    return {
      x: left ? w * 0.15 : w * 0.85, y: h * 0.35,
      vx: Math.cos((ang * Math.PI) / 180) * sp, vy: Math.sin((ang * Math.PI) / 180) * sp,
      r: (i * 29) % 360, vr: ((i * 17) % 20) - 10, s: 6 + ((i * 13) % 6), col: COLORS[i % COLORS.length], round: k > 0.7,
    };
  });
  const t0 = performance.now();
  const step = (now: number): void => {
    const t = now - t0;
    g.clearRect(0, 0, w, h);
    for (const p of ps) {
      p.vy += 0.32; p.vx *= 0.985; p.vy *= 0.985;
      p.x += p.vx; p.y += p.vy; p.r += p.vr;
      g.save();
      g.globalAlpha = Math.max(0, 1 - Math.max(0, t - 1300) / 500);
      g.translate(p.x, p.y); g.rotate((p.r * Math.PI) / 180); g.fillStyle = p.col;
      if (p.round) { g.beginPath(); g.arc(0, 0, p.s / 2, 0, Math.PI * 2); g.fill(); } else g.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2);
      g.restore();
    }
    if (t < 1800) requestAnimationFrame(step);
    else { c.remove(); running = false; }
  };
  requestAnimationFrame(step);
}

/** Celebrate `id` (e.g. "won:12") once per browser. */
export function celebrateOnce(id: string): void {
  if (seen(id)) return;
  remember(id);
  confetti();
}

/**
 * Celebrates when `level` rises while the page is open: e.g. admitted 0 → 1, payouts 1 → 2. The first value seen is
 * the starting point, so events that happened before this visit don't throw confetti. Pass `undefined` while the
 * data is still loading. Each (id, level) celebrates at most once per browser.
 */
export function useCelebrate(id: string | null, level: number | undefined): void {
  const base = useRef<{ id: string | null; level: number } | null>(null);
  useEffect(() => {
    if (id === null || level === undefined) return;
    if (!base.current || base.current.id !== id) { base.current = { id, level }; return; }
    if (level > base.current.level) {
      base.current.level = level;
      celebrateOnce(`${id}:${level}`);
    }
  }, [id, level]);
}
