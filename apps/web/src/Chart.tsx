import { fmtNear, fmtTokens, priceAt } from '@signalfire/core';
import type { Trade } from './api.ts';

// The price chart: one point per trade (price at the circulating supply after it), newest on the right.
// Prices follow the curve exactly, so this is the curve walked by real trades.

export function PriceChart({ trades, circulating }: { trades: Trade[]; circulating: string }) {
  const pts = [...trades].reverse().map((t) => ({ p: Number(priceAt(BigInt(t.circulating_after))) / 1e24, side: t.side, t }));
  if (pts.length === 0) pts.push({ p: Number(priceAt(BigInt(circulating))) / 1e24, side: 'buy', t: null as unknown as Trade });
  const W = 640, H = 220, padL = 8, padR = 8, padT = 14, padB = 22;
  const min = Math.min(...pts.map((x) => x.p)), max = Math.max(...pts.map((x) => x.p));
  const lo = min - (max - min || min) * 0.15, hi = max + (max - min || min) * 0.15;
  const x = (i: number): number => padL + (pts.length === 1 ? (W - padL - padR) / 2 : (i / (pts.length - 1)) * (W - padL - padR));
  const y = (p: number): number => padT + (1 - (p - lo) / (hi - lo || 1)) * (H - padT - padB);
  const line = pts.map((q, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(q.p).toFixed(1)}`).join(' ');
  const area = `${line} L${x(pts.length - 1).toFixed(1)},${H - padB} L${x(0).toFixed(1)},${H - padB} Z`;
  const last = pts[pts.length - 1];
  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`GLOW price over the last ${trades.length} trades, now ${last.p.toFixed(6)} NEAR`}>
        <defs>
          <linearGradient id="glow-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--ember)" stopOpacity="0.28" />
            <stop offset="1" stopColor="var(--ember)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((f) => <line key={f} x1={padL} x2={W - padR} y1={padT + f * (H - padT - padB)} y2={padT + f * (H - padT - padB)} className="grid" />)}
        <path d={area} fill="url(#glow-fill)" />
        <path d={line} className="pline" />
        {pts.map((q, i) => q.t && <circle key={i} cx={x(i)} cy={y(q.p)} r={pts.length > 60 ? 1.6 : 2.6} className={q.side === 'sell' ? 'sell' : 'buy'}><title>{`${q.side} ${fmtTokens(q.t.tokens)} for ${fmtNear(q.t.near)} NEAR`}</title></circle>)}
        <text x={W - padR} y={H - 6} textAnchor="end" className="axis">{trades.length} trades, newest right</text>
        <text x={padL} y={H - 6} className="axis">{lo.toFixed(6)}–{hi.toFixed(6)} NEAR per token</text>
      </svg>
    </figure>
  );
}
