// A small signal-fire burst at a point: an expanding warm ring and a few rising ember sparks, ~650 ms, then gone.
// Used when a main action button is clicked and when its success message appears. pointer-events: none, transforms
// and opacity only. Under prefers-reduced-motion it's a single soft fade with no sparks.

export function signalBurst(x: number, y: number, size = 1): void {
  if (typeof document === 'undefined') return;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const el = document.createElement('div');
  el.className = `sf-burst${reduced ? ' still' : ''}`;
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.style.setProperty('--s', String(size));
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = '<i class="sf-ring"></i>' + (reduced ? '' : Array.from({ length: 7 }, (_, i) => {
    const a = -90 + (i - 3) * 22 + (Math.random() * 10 - 5);
    const d = 34 + Math.random() * 30;
    return `<i class="sf-spark" style="--a:${a}deg;--d:${d}px;--t:${(380 + Math.random() * 260).toFixed(0)}ms"></i>`;
  }).join(''));
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 900);
}
