import { useEffect, useRef, type CSSProperties } from 'react';

// Signalfire's flame: one flat, chunky mark used everywhere a flame appears (the logo, the card flames, the welcome
// card, empty states and the landing fire). Three tones from the theme (--fire outside, --sun inside, a cream core),
// soft rounded tips and a darker bottom lip like the buttons. It idles with a gentle sway and squash-and-stretch and
// "puffs" when something happens. All motion is CSS transforms (style.css, "the flame mark"); it stands still under
// prefers-reduced-motion or with `still`.

// viewBox 0 0 64 80, standing on y = 76: a round belly, a tall leaning tip and two small side tips
export const OUTER = 'M32 76C19.5 76 10 66.5 10 54.5C10 44 13 35 14.6 27.4Q15.6 23.4 18.4 26C20.6 28.2 22 30.6 23.4 33.4'
  + 'C23.6 22.6 28.6 12.4 34.6 4.6Q36.8 2.2 38.2 5.2C41.6 12.8 44.2 19.4 45.2 26.6C46.8 24.6 48.6 22.6 50.6 20.6'
  + 'Q53.8 18 54.4 22.2C55.4 30 56.6 40 55.4 52.4C54.6 66 44.5 76 32 76Z';
export const HEART = 'M32 74C24.3 74 19 68 19 60.5C19 52 25 46.6 29 39.4Q31.6 33.2 33.4 31.2Q35.6 33.4 36.6 38.4C38 45 45 51 45 60.5C45 68 39.7 74 32 74Z';
export const CORE = 'M32 70C28.4 70 26 67.5 26 64.3C26 60.5 29 58 31 54.2Q32.6 51.8 34 54.6C35.5 58 38 60.6 38 64.3C38 67.5 35.6 70 32 70Z';
export const SHINE = 'M15.6 51C15.4 46 16.8 41.6 19.2 38.4';

export interface FireMarkProps {
  size?: number;
  className?: string;
  /** no idle motion and no puffs (a quiet flame) */
  still?: boolean;
  /** muted: an unlit flame (e.g. a card with no open campaign) */
  dim?: boolean;
  /** bump to make it puff once (something happened) */
  puff?: number;
  /** bump to make it flare (something big happened) */
  flare?: number;
  /** an accessible name; without one the mark is decorative */
  label?: string;
  style?: CSSProperties;
}

/** Replays a one-shot CSS animation class on an element (removing it, forcing a style flush, adding it back). */
export function replay(el: Element | null, cls: string): void {
  if (!el) return;
  el.classList.remove(cls);
  void el.getBoundingClientRect();
  el.classList.add(cls);
}

export function FireMark({ size, className, still, dim, puff = 0, flare = 0, label, style }: FireMarkProps) {
  const pop = useRef<SVGGElement>(null);
  useEffect(() => { if (puff && !still) { pop.current?.classList.remove('flare'); replay(pop.current, 'puff'); } }, [puff, still]);
  useEffect(() => { if (flare && !still) { pop.current?.classList.remove('puff'); replay(pop.current, 'flare'); } }, [flare, still]);
  const cls = `fm${still ? ' still' : ''}${dim ? ' dim' : ''}${className ? ` ${className}` : ''}`;
  return (
    <svg className={cls} viewBox="0 0 64 80" width={size ? size * 0.8 : undefined} height={size} style={style}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}>
      <g className="fm-pop" ref={pop} onAnimationEnd={(e) => { if (e.target === e.currentTarget) e.currentTarget.classList.remove('puff', 'flare'); }}>
        <g className="fm-body">
          <g transform="translate(0 2.6)"><path className="fm-edge fm-flick" d={OUTER} /></g>
          <path className="fm-out fm-flick" d={OUTER} />
          <path className="fm-in fm-heart" d={HEART} />
          <path className="fm-core fm-heart" d={CORE} />
          <path className="fm-shine fm-flick" d={SHINE} />
        </g>
      </g>
    </svg>
  );
}
