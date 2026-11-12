import { useState } from 'react';
import { SUPPLY, fmtNear, fmtTokens, priceAt } from '@signalfire/core';
import type { Trade } from './api.ts';

// The price chart, two ways:
// - On the curve (default): the bonding curve itself (price against circulating supply), every trade as a dot where
//   it left the supply, and the shaded reserve up to today. Big trades sit further out on the same straight line
//   instead of towering over everything.
// - Trade by trade: price after each trade, newest right. When a few trades are far above the rest, the scale is
//   set by the others and those trades are drawn at the top edge with their value, so nothing is hidden.

const W = 640, H = 230, padL = 58, padR = 12, padT = 18, padB = 34;
const near = (y: bigint): number => Number(y) / 1e24;
const fmtP = (p: number): string => (p >= 0.01 ? p.toFixed(4) : p.toFixed(6));

export function PriceChart({ trades, circulating }: { trades: Trade[]; circulating: string }) {
  const [mode, setMode] = useState<'curve' | 'trades'>('curve');
  return (
    <figure className="chart">
      <div className="chart-tabs" role="radiogroup" aria-label="Chart view">
        <button role="radio" aria-checked={mode === 'curve'} className={`pill${mode === 'curve' ? ' on' : ''}`} onClick={() => setMode('curve')}>On the curve</button>
        <button role="radio" aria-checked={mode === 'trades'} className={`pill${mode === 'trades' ? ' on' : ''}`} onClick={() => setMode('trades')}>Trade by trade</button>
      </div>
      {mode === 'curve' ? <Curve trades={trades} circulating={circulating} /> : <Series trades={trades} circulating={circulating} />}
    </figure>
  );
}

function Curve({ trades, circulating }: { trades: Trade[]; circulating: string }) {
  const circ = BigInt(circulating);
  const xs = trades.map((t) => BigInt(t.circulating_after));
  let maxX = [circ, ...xs].reduce((a, b) => (b > a ? b : a), 0n);
  maxX = maxX === 0n ? SUPPLY / 100n : (maxX * 115n) / 100n;
  const pLo = near(priceAt(0n)), pHi = near(priceAt(maxX));
  const base = pLo * 0.97;
  const x = (v: bigint): number => padL + (Number(v) / Number(maxX)) * (W - padL - padR);
  const y = (p: number): number => padT + (1 - (p - base) / (pHi - base || 1)) * (H - padT - padB);
  const now = near(priceAt(circ));
  const reserve = `M${x(0n)},${H - padB} L${x(0n)},${y(pLo)} L${x(circ)},${y(now)} L${x(circ)},${H - padB} Z`;
  const ticksY = [pLo, (pLo + pHi) / 2, pHi];
  const ticksX = [0n, maxX / 2n, maxX];
  const labelLeft = x(circ) > W - 170;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Bonding curve: price now ${fmtP(now)} NEAR at ${fmtTokens(circ, 0)} tokens circulating; ${trades.length} trades marked`}>
      {ticksY.map((p) => <g key={p}><line x1={padL} x2={W - padR} y1={y(p)} y2={y(p)} className="grid" /><text x={padL - 6} y={y(p) + 3} textAnchor="end" className="axis">{fmtP(p)}</text></g>)}
      {ticksX.map((v) => <text key={String(v)} x={x(v)} y={H - padB + 14} textAnchor={v === 0n ? 'start' : v === maxX ? 'end' : 'middle'} className="axis">{fmtTokens(v, 0)}</text>)}
      <path d={reserve} className="reserve" />
      <line x1={x(0n)} y1={y(pLo)} x2={x(maxX)} y2={y(pHi)} className="pline" />
      {trades.map((t) => {
        const v = BigInt(t.circulating_after);
        return <circle key={t.n} cx={x(v)} cy={y(near(priceAt(v)))} r={3.2} className={t.side === 'sell' ? 'sell' : 'buy'}><title>{`${t.side} ${fmtTokens(t.tokens)} for ${fmtNear(t.near)} NEAR, supply after ${fmtTokens(t.circulating_after, 0)}`}</title></circle>;
      })}
      <circle cx={x(circ)} cy={y(now)} r={6} className="now" />
      <text x={labelLeft ? x(circ) - 10 : x(circ) + 10} y={y(now) - 10} textAnchor={labelLeft ? 'end' : 'start'} className="axis strong">now {fmtP(now)} NEAR</text>
      <text x={W - padR} y={H - 3} textAnchor="end" className="axis">circulating supply (tokens) · shaded: the curve reserve</text>
      <text x={4} y={11} className="axis">NEAR per token</text>
    </svg>
  );
}

function Series({ trades, circulating }: { trades: Trade[]; circulating: string }) {
  const pts = [...trades].reverse().map((t) => ({ p: near(priceAt(BigInt(t.circulating_after))), t: t as Trade | null }));
  if (pts.length === 0) pts.push({ p: near(priceAt(BigInt(circulating))), t: null });
  // scale from the bulk of the trades; anything far above it is an outlier, drawn at the top edge with its value
  const sorted = pts.map((q) => q.p).sort((a, b) => a - b);
  const q80 = sorted[Math.floor((sorted.length - 1) * 0.8)];
  const min = sorted[0];
  const span = Math.max(q80 - min, min * 0.05);
  const cap = sorted.length >= 6 && sorted[sorted.length - 1] > q80 + span * 1.5 ? q80 + span * 0.6 : sorted[sorted.length - 1];
  const lo = min - span * 0.15, hi = cap + span * 0.15;
  const x = (i: number): number => padL + (pts.length === 1 ? (W - padL - padR) / 2 : (i / (pts.length - 1)) * (W - padL - padR));
  const y = (p: number): number => padT + (1 - (Math.min(p, hi) - lo) / (hi - lo || 1)) * (H - padT - padB);
  const line = pts.map((q, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(q.p).toFixed(1)}`).join(' ');
  const area = `${line} L${x(pts.length - 1).toFixed(1)},${H - padB} L${x(0).toFixed(1)},${H - padB} Z`;
  const clipped = pts.filter((q) => q.p > hi).length;
  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Price after each of the last ${trades.length} trades${clipped ? `; ${clipped} above the scale, labelled` : ''}`}>
        <defs>
          <linearGradient id="price-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--ember)" stopOpacity="0.18" />
            <stop offset="1" stopColor="var(--ember)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[lo + (hi - lo) * 0.1, (lo + hi) / 2, hi - (hi - lo) * 0.1].map((p) => <g key={p}><line x1={padL} x2={W - padR} y1={y(p)} y2={y(p)} className="grid" /><text x={padL - 6} y={y(p) + 3} textAnchor="end" className="axis">{fmtP(p)}</text></g>)}
        {clipped > 0 && <line x1={padL} x2={W - padR} y1={padT} y2={padT} className="clip" />}
        <path d={area} fill="url(#price-fill)" />
        <path d={line} className="pline" />
        {pts.map((q, i) => {
          if (!q.t) return null;
          const out = q.p > hi;
          return (
            <g key={q.t.n}>
              {out
                ? <path d={`M${x(i) - 5},${padT + 7} L${x(i) + 5},${padT + 7} L${x(i)},${padT - 1} Z`} className="out" />
                : <circle cx={x(i)} cy={y(q.p)} r={pts.length > 60 ? 1.8 : 3} className={q.t.side === 'sell' ? 'sell' : 'buy'} />}
              {out && <text x={x(i)} y={padT + 20} textAnchor="middle" className="axis strong">{fmtP(q.p)}</text>}
              <title>{`${q.t.side} ${fmtTokens(q.t.tokens)} for ${fmtNear(q.t.near)} NEAR; price after ${fmtP(q.p)} NEAR`}</title>
            </g>
          );
        })}
        <text x={W - padR} y={H - 8} textAnchor="end" className="axis">{trades.length} trades, newest right</text>
        <text x={4} y={11} className="axis">NEAR per token</text>
      </svg>
      {clipped > 0 && <figcaption className="muted small">{clipped} trade{clipped > 1 ? 's' : ''} moved the price far above the rest (large buys). They are drawn at the top edge, each labelled with its price.</figcaption>}
    </>
  );
}
