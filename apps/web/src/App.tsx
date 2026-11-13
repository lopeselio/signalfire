import { useCallback, useEffect, useRef, useState } from 'react';
import { api, txUrl, type Me, type State } from './api.ts';
import { AccountMenu } from './AccountMenu.tsx';
import { Creators } from './Creators.tsx';
import { Dashboard } from './Dashboard.tsx';
import { Discover } from './Discover.tsx';
import { Landing } from './Landing.tsx';
import { Launch } from './Launch.tsx';
import { Plan } from './Plan.tsx';
import { HowItWorks, Onboarding, seenOnboarding } from './tour/Onboarding.tsx';
import { StartupPage } from './Startup.tsx';
import { friendly } from './copy.ts';
import { Ctx, Flame, shortAcct, type AppCtx, type RunCopy } from './ui.tsx';
import { signIn as walletSignIn, signOut } from './wallet.ts';
import { Waiting } from './Waiting.tsx';

// The shell: routing by path (/, /discover, /s/:id, /creators, /dashboard, /launch, /plan, /how), the header, polling and toasts.

type Route = { page: 'home' } | { page: 'startup'; id: string } | { page: 'creators' } | { page: 'discover' } | { page: 'dashboard' } | { page: 'launch' } | { page: 'plan' } | { page: 'how' };
function parse(): Route {
  const p = location.pathname;
  const m = /^\/s\/([a-z0-9]{2,8})\/?$/.exec(p);
  if (m) return { page: 'startup', id: m[1] };
  if (p.startsWith('/creators')) return { page: 'creators' };
  if (p.startsWith('/discover')) return { page: 'discover' };
  if (p.startsWith('/dashboard')) return { page: 'dashboard' };
  if (p.startsWith('/launch')) return { page: 'launch' };
  if (p.startsWith('/plan')) return { page: 'plan' };
  if (p.startsWith('/how')) return { page: 'how' };
  return { page: 'home' };
}

interface Toast { id: number; kind: 'ok' | 'bad' | 'info'; text: string; tx?: string; title?: string }

export function App() {
  const [route, setRoute] = useState<Route>(parse());
  const [state, setState] = useState<State | null>(null);
  const [stateError, setStateError] = useState<string | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [busyCopy, setBusyCopy] = useState<RunCopy | null>(null);
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
    if (!location.hash) window.scrollTo({ top: 0 });
  }, []);

  const signIn = useCallback(async () => {
    try {
      const a = await walletSignIn();
      setAccount(a);
      refreshMe();
      toast({ kind: 'ok', text: `You're signed in as ${shortAcct(a)}.`, title: a });
    } catch (e) { const m = (e as Error).message; toast({ kind: 'bad', text: friendly(m), title: m }); }
  }, [refreshMe, toast]);

  const run: AppCtx['run'] = useCallback(async (label, fn, copy) => {
    setBusy(label);
    setBusyCopy(copy ?? null);
    const title = copy?.action ? `${label} (${copy.action})` : label;
    try {
      const r = await fn();
      const done = copy?.done ?? `${label}: done.`;
      toast({ kind: 'ok', text: `${done}${r && r.gasless ? ' Free: Signalfire covered the network fee.' : ''}`, tx: r ? r.tx : undefined, title: r && r.gasless ? `${title}: gasless, Signalfire's relayer paid the gas` : title });
      setTimeout(() => { loadState(); refreshMe(); }, 1500);
      return true;
    } catch (e) {
      const m = (e as Error).message;
      toast({ kind: 'bad', text: `${label} didn't go through: ${friendly(m)}`, title: `${title}: ${m}` });
      console.warn(`${title}:`, m);
      return false;
    } finally { setBusy(null); setBusyCopy(null); }
  }, [toast, loadState, refreshMe]);

  const ctx: AppCtx = { state, stateError, me, account, go, signIn, refreshMe, run, busy };
  const link = (path: string, text: string, active: boolean) => (
    <a href={path} className={active ? 'on' : ''} aria-current={active ? 'page' : undefined} onClick={(e) => { e.preventDefault(); go(path); }}>{text}</a>
  );

  return (
    <Ctx.Provider value={ctx}>
      <header className="top">
        <div className="top-in">
          <a href="/" className="brand" onClick={(e) => { e.preventDefault(); go('/'); }}><Flame /> Signalfire</a>
          <span className="testnet" title="Everything here runs on NEAR's test network. No real money.">testnet</span>
          <nav className={`nav${menu ? ' open' : ''}`}>
            {link('/discover', 'Discover', route.page === 'discover' || route.page === 'startup')}
            {link('/creators', 'Creators', route.page === 'creators')}
            {link('/dashboard', 'Dashboard', route.page === 'dashboard')}
            {account && link('/launch', 'Launch', route.page === 'launch')}
            {link('/how', 'How it works', route.page === 'how')}
          </nav>
          <div className="who">
            <button className="ghost round" data-tour="help" onClick={() => setHelp(true)} aria-label="Get started: pick your path">?</button>
            {account ? (
              <AccountMenu account={account} me={me} state={state} go={go} onSignOut={() => void signOut().then(() => { setAccount(null); setMe(null); })} />
            ) : (
              <button className="primary small" data-tour="sign-in" onClick={() => void signIn()}>Sign in</button>
            )}
            <button className="ghost round burger" onClick={() => setMenu((m) => !m)} aria-label="Menu" aria-expanded={menu}>
              <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.6" /></svg>
            </button>
          </div>
        </div>
      </header>
      <main>
        {!state && !stateError && <div className="loading"><Waiting lines={['Loading live numbers from NEAR…']} /></div>}
        {!state && stateError && <div className="error-box" title={stateError}>Signalfire isn’t responding right now. We’ll keep trying every few seconds.</div>}
        {state && route.page === 'home' && <Landing />}
        {state && route.page === 'startup' && <StartupPage id={route.id} />}
        {state && route.page === 'discover' && <Discover />}
        {state && route.page === 'creators' && <Creators />}
        {state && route.page === 'dashboard' && <Dashboard />}
        {state && route.page === 'launch' && <Launch />}
        {state && route.page === 'plan' && <Plan />}
        {state && route.page === 'how' && <HowItWorks />}
      </main>
      <footer className="foot">
        <p>Signalfire runs on NEAR’s test network. Attention tokens are not equity and not a claim on revenue. <a href={`https://testnet.nearblocks.io/address/${state?.hub ?? 'signalfire.testnet'}`} target="_blank" rel="noreferrer" title={`The hub contract, ${state?.hub ?? 'signalfire.testnet'}`}>See Signalfire’s contract on NEAR</a></p>
      </footer>
      <Onboarding open={help} onOpen={() => setHelp(true)} onClose={() => setHelp(false)} />
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`} title={t.title}>
            {t.text}
            {t.tx && <> <a href={txUrl(t.tx)} target="_blank" rel="noreferrer" title="The public transaction on nearblocks">View on NEAR</a></>}
          </div>
        ))}
      </div>
      {busy && <div className="busy" role="status" title={busyCopy?.action ? `${busy} (${busyCopy.action})` : busy}>{busyCopy?.pending ?? `${busy}…`}{busyCopy?.wallet === false ? '' : ' Confirm in your wallet if it asks.'}</div>}
    </Ctx.Provider>
  );
}
