import { useState } from 'react';
import { normalizeTarget, parseNear } from '@signalfire/core';
import { api } from './api.ts';
import { SignInHint, Terms, useApp } from './ui.tsx';
import { call } from './wallet.ts';
import { NextAction } from './NextAction.tsx';

// Launch a startup: one call creates its attention token (fixed supply, all on the curve) and its DAO.

export function Launch() {
  const { state, account, run, busy, go } = useApp();
  const [symbol, setSymbol] = useState('');
  const [name, setName] = useState('');
  const [pitch, setPitch] = useState('');
  const [gh, setGh] = useState('');
  const [x, setX] = useState('');
  const ghT = gh.trim() ? normalizeTarget('github', gh) : null;
  const xT = x.trim() ? normalizeTarget('x', x) : null;
  const linksOk = (!gh.trim() || !!ghT) && (!x.trim() || !!xT);
  const taken = state!.startups.some((s) => s.id === symbol);
  const okSym = /^[a-z0-9]{2,8}$/.test(symbol) && symbol !== 'tusd' && !taken;
  return (
    <div className="launch">
      <section className="page-head">
        <h1>Launch a startup</h1>
        <p className="lede">
          One step creates your attention token and its holders’ council. All 1,000,000 tokens go on sale at automatic
          prices; you get none. Trading fees fill a marketing fund you can’t withdraw from. As founder, you post campaign
          briefs and set the spend limits.
        </p>
        <details className="tech">
          <summary>What gets created on NEAR</summary>
          <p className="muted small">Token <code>{symbol || 'sym'}.{state!.hub}</code> and Sputnik DAO <code>{symbol || 'sym'}-dao.{state!.hub}</code>.</p>
        </details>
        <NextAction page="launch" />
      </section>
      <SignInHint what="launch a startup" />
      {account && (
        <section className="panel launch-form" data-tour="launch">
          <label className="field"><span>Symbol (2–8 lowercase letters or digits)</span>
            <input value={symbol} onChange={(e) => setSymbol(e.target.value.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8))} aria-invalid={!!symbol && !okSym} />
          </label>
          {taken && <p className="bad-text small">That symbol is taken.</p>}
          <label className="field"><span>Name</span><input maxLength={40} value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label className="field"><span>Pitch (max 280 characters)</span><textarea maxLength={280} value={pitch} onChange={(e) => setPitch(e.target.value)} /></label>
          <fieldset className="ev-launch" data-tour="launch-links">
            <legend>Your GitHub and X (optional, recommended)</legend>
            <p className="muted small">Backers see an Evidence tab and a research brief about you. Linked accounts show as “claimed” until you prove them from the Founder’s desk: your wallet signs a short note, and you post it from that account.</p>
            <label className="field"><span>GitHub username, organization, or owner/repository</span><input value={gh} onChange={(e) => setGh(e.target.value)} aria-invalid={!!gh.trim() && !ghT} /></label>
            <label className="field"><span>X handle</span><input value={x} onChange={(e) => setX(e.target.value)} aria-invalid={!!x.trim() && !xT} placeholder="@handle" /></label>
          </fieldset>
          <p className="small">The holders’ council starts with you; anyone holding 100 tokens can join. Launching costs 1 NEAR, which pays to set up the token and the holders’ council on NEAR.</p>
          <button className="primary" disabled={!okSym || !name.trim() || !linksOk || !!busy} onClick={() => void run(`Launch ${symbol.toUpperCase()}`, () =>
            call(state!.hub, 'launch_startup', { symbol, name: name.trim(), pitch: pitch.trim(), council: [account], constraints: null }, parseNear('1')),
            { pending: `Launching ${symbol.toUpperCase()}…`, done: `${symbol.toUpperCase()} is live. Taking you to its page…`, action: 'launch_startup' }).then(async (ok) => {
              if (!ok) return;
              // the claims, to prove from the Founder's desk
              for (const [kind, target] of [['github', ghT], ['x', xT]] as const) if (target) await api(`/evidence/${symbol}/links`, { kind, target }).catch(() => undefined);
              setTimeout(() => go(ghT || xT ? `/s/${symbol}?tab=treasury#links` : `/s/${symbol}`), 2500);
            })}>
            Launch {symbol ? symbol.toUpperCase() : 'it'} with 1 NEAR
          </button>
          <Terms />
        </section>
      )}
    </div>
  );
}
