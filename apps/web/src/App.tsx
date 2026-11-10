import { useCallback, useEffect, useRef, useState } from 'react';
import { fmtTokens } from '@signalfire/core';
import { api, txUrl, type Me, type State } from './api.ts';
import { Creators } from './Creators.tsx';
import { Dashboard } from './Dashboard.tsx';
import { Landing } from './Landing.tsx';
import { Launch } from './Launch.tsx';
import { Onboarding, seenOnboarding } from './Onboarding.tsx';
import { StartupPage } from './Startup.tsx';
import { Ctx, Flame, shortAcct, type AppCtx } from './ui.tsx';
import { signIn as walletSignIn, signOut } from './wallet.ts';

// The shell: routing by path (/, /s/:id, /creators, /dashboard, /launch), the header, polling and toasts.

type Route = { page: 'home' } | { page: 'startup'; id: string } | { page: 'creators' } | { page: 'dashboard' } | { page: 'launch' };
function parse(): Route {
  const p = location.pathname;
  const m = /^\/s\/([a-z0-9]{2,8})\/?$/.exec(p);
  if (m) return { page: 'startup', id: m[1] };
  if (p.startsWith('/creators')) return { page: 'creators' };
  if (p.startsWith('/dashboard')) return { page: 'dashboard' };
  if (p.startsWith('/launch')) return { page: 'launch' };
  return { page: 'home' };
}

interface Toast { id: number; kind: 'ok' | 'bad' | 'info'; text: string; tx?: string }

export function App() {
  const [route, setRoute] = useState<Route>(parse());
  const [state, setState] = useState<State | null>(null);
  const [stateError, setStateError] = useState<string | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [help, setHelp] = useState(() => !seenOnboarding());
  const [menu, setMenu] = useState(false);

  const toast = useCallback((t: Omit<Toast, 'id'>) => {
    const id = Date.now() + Math.random();
    setToasts((l) => [...l.slice(-3), { ...t, id }]);
    setTimeout(() => setToasts((l) => l.filter((x) => x.id !== id)), t.kind === 'bad' ? 12000 : 8000);
  }, []);

  const inflight = useRef(false);
  const loadState = useCallback(() => {
    if (inflight.current) return; // a slow read is still running: don't stack polls
    inflight.current = true;
    api<State>('/state').then((s) => { setState(s); setStateError(null); }).catch((e: Error) => setStateError(e.message)).finally(() => { inflight.current = false; });
  }, []);
  const refreshMe = useCallback(() => {
    api<Me>('/me').then((m) => { setMe(m); setAccount(m.accountId); }).catch(() => { setMe(null); setAccount(null); });
  }, []);

  useEffect(() => {
    loadState();
    refreshMe();
    const t = setInterval(loadState, 5000);
    const t2 = setInterval(refreshMe, 15000);
    const pop = (): void => setRoute(parse());
    window.addEventListener('popstate', pop);
    return () => { clearInterval(t); clearInterval(t2); window.removeEventListener('popstate', pop); };
  }, [loadState, refreshMe]);

  const go = useCallback((path: string) => {
    history.pushState(null, '', path);
    setRoute(parse());
    setMenu(false);
    window.scrollTo({ top: 0 });
  }, []);

  const signIn = useCallback(async () => {
    try {
      const a = await walletSignIn();
      setAccount(a);
      refreshMe();
      toast({ kind: 'ok', text: `Signed in as ${a}` });
    } catch (e) { toast({ kind: 'bad', text: (e as Error).message }); }
  }, [refreshMe, toast]);

  const run: AppCtx['run'] = useCallback(async (label, fn) => {
    setBusy(label);
    try {
      const r = await fn();
      toast({ kind: 'ok', text: r ? `${label}: done${r.gasless ? ' (gasless, our relayer paid the gas)' : ''}` : `${label}: done`, tx: r ? r.tx : undefined });
      setTimeout(() => { loadState(); refreshMe(); }, 1500);
      return true;
    } catch (e) {
      toast({ kind: 'bad', text: `${label}: ${(e as Error).message}` });
      return false;
    } finally { setBusy(null); }
  }, [toast, loadState, refreshMe]);

  const demo = state?.demo ?? 'glow';
  const demoBal = me?.tokens.find((t) => t.startup === demo);
  const ctx: AppCtx = { state, stateError, me, account, go, signIn, refreshMe, run, busy };
  const link = (path: string, text: string, active: boolean) => (
    <a href={path} className={active ? 'on' : ''} aria-current={active ? 'page' : undefined} onClick={(e) => { e.preventDefault(); go(path); }}>{text}</a>
  );

  return (
    <Ctx.Provider value={ctx}>
      <header className="top">
        <div className="top-in">
          <a href="/" className="brand" onClick={(e) => { e.preventDefault(); go('/'); }}><Flame /> Signalfire</a>
          <span className="testnet" title="Everything here runs on NEAR testnet. No real money.">testnet</span>
          <nav className={`nav${menu ? ' open' : ''}`}>
            {link(`/s/${demo}`, demo.toUpperCase(), route.page === 'startup')}
            {link('/creators', 'Creators', route.page === 'creators')}
            {link('/dashboard', 'Dashboard', route.page === 'dashboard')}
            {account && link('/launch', 'Launch', route.page === 'launch')}
          </nav>
          <div className="who">
            <button className="ghost round" onClick={() => setHelp(true)} aria-label="How Signalfire works">?</button>
            {account ? (
              <span className="me">
                <span className="me-acct" title={account}>{shortAcct(account)}</span>
                {demoBal && <span className="me-bal">{fmtTokens(demoBal.balance)} {demo.toUpperCase()}</span>}
                <button className="ghost small" onClick={() => void signOut().then(() => { setAccount(null); setMe(null); })}>Sign out</button>
              </span>
            ) : (
              <button className="primary small" onClick={() => void signIn()}>Sign in</button>
            )}
            <button className="ghost round burger" onClick={() => setMenu((m) => !m)} aria-label="Menu" aria-expanded={menu}>
              <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.6" /></svg>
            </button>
          </div>
        </div>
      </header>
      <main>
        {!state && !stateError && <div className="loading">Reading the chain…</div>}
        {!state && stateError && <div className="error-box">Couldn’t reach the Signalfire server ({stateError}). It retries every 5 seconds.</div>}
        {state && route.page === 'home' && <Landing />}
        {state && route.page === 'startup' && <StartupPage id={route.id} />}
        {state && route.page === 'creators' && <Creators />}
        {state && route.page === 'dashboard' && <Dashboard />}
        {state && route.page === 'launch' && <Launch />}
      </main>
      <footer className="foot">
        <p>Signalfire runs on NEAR testnet. The hub contract is <a href={`https://testnet.nearblocks.io/address/${state?.hub ?? 'signalfire.testnet'}`} target="_blank" rel="noreferrer">{state?.hub ?? 'signalfire.testnet'}</a>. Attention tokens are not equity and not a claim on revenue.</p>
      </footer>
      {help && <Onboarding onClose={() => setHelp(false)} />}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
            {t.tx && <> <a href={txUrl(t.tx)} target="_blank" rel="noreferrer">View transaction</a></>}
          </div>
        ))}
      </div>
      {busy && <div className="busy" role="status">{busy}… check your wallet</div>}
    </Ctx.Provider>
  );
}
