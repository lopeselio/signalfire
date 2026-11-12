import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { fmtNear } from '@signalfire/core';
import { acctUrl, txUrl, type Me, type State } from './api.ts';

// Shared bits: the app context, links, amounts, chips, countdowns.

export interface AppCtx {
  state: State | null;
  stateError: string | null;
  me: Me | null;
  account: string | null;
  go: (path: string) => void;
  signIn: () => Promise<void>;
  refreshMe: () => void;
  /** run a wallet action with a busy flag and a toast; returns true on success */
  run: (label: string, fn: () => Promise<{ tx: string; gasless: boolean } | void>) => Promise<boolean>;
  busy: string | null;
}
export const Ctx = createContext<AppCtx | null>(null);
export const useApp = (): AppCtx => useContext(Ctx)!;

export const shortAcct = (a: string, hub?: string): string => (hub && a.endsWith(`.${hub}`) ? a.slice(0, -hub.length - 1) : a);

export function Acct({ a, full }: { a: string; full?: boolean }) {
  const { state } = useApp();
  return <a className="acct" href={acctUrl(a)} target="_blank" rel="noreferrer" title={a}>{full ? a : shortAcct(a, state?.hub)}</a>;
}

export function Tx({ h, label }: { h: string; label?: string }) {
  return <a className="tx" href={txUrl(h)} target="_blank" rel="noreferrer" title={h}>{label ?? `${h.slice(0, 8)}…`}</a>;
}

export function Near({ y, d = 4 }: { y: string | bigint; d?: number }) {
  return <span className="amt">{fmtNear(y, d)}<small> NEAR</small></span>;
}

export function Chip({ kind, children }: { kind?: string; children: ReactNode }) {
  return <span className={`chip ${kind ?? ''}`}>{children}</span>;
}

/** The colour of an audit outcome or flag. */
export function flagKind(f: string): string {
  if (f === 'paid' || f === 'admitted' || f === 'committed' || f === 'returned' || f === 'set') return 'ok';
  if (f.startsWith('held') || f === 'rejected' || f === 'lookalike' || f.startsWith('failed') || f === 'over_cap' || f === 'rate_limit' || f === 'revoked') return 'bad';
  if (f === 'burst' || f === 'to_treasury') return 'warn';
  return '';
}

export function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

export function fmtLeft(ms: number): string {
  if (ms <= 0) return 'now';
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function ago(t: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function TeeBadge({ signed, model }: { signed: boolean; model?: string }) {
  if (model === 'creator') return <span className="tee off" title="A person wrote this pitch and sealed it in their browser; no model was involved">written by the creator</span>;
  if (!signed) return <span className="tee off" title="Written without NEAR AI (fallback text, unsigned)">unsigned</span>;
  return (
    <span className="tee" title={`Signed inside the NEAR AI Cloud TEE${model ? ` (${model})` : ''}; check it with pnpm verify`}>
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5 13.5 4v4c0 3.2-2.3 5.6-5.5 6.5C4.8 13.6 2.5 11.2 2.5 8V4z" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="m5.5 8 1.8 1.8L10.8 6.3" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
      signed by NEAR AI TEE
    </span>
  );
}

export function Flame({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="flame">
      <path d="M12 2.5c2.3 3.2 5.2 5.3 5.2 9.6A5.2 5.2 0 0 1 6.8 12.1c0-2.7 2-4.2 3-6.6 1.2 1.5 1.5 2.7 1.5 3.9C12.9 7 12.6 4.6 12 2.5z" fill="currentColor" />
      <rect x="4" y="19" width="16" height="2" rx="1" fill="var(--smoke)" />
    </svg>
  );
}

export function SignInHint({ what }: { what: string }) {
  const { signIn, account } = useApp();
  if (account) return null;
  return <p className="hint">Browsing as a guest. <button className="link" onClick={() => void signIn()}>Sign in with a NEAR wallet</button> to {what}.</p>;
}

export function Terms({ compact }: { compact?: boolean }) {
  const { state } = useApp();
  return (
    <aside className={`terms${compact ? ' compact' : ''}`} role="note">
      <strong>Not equity. Not a claim on revenue or the treasury. Testnet only.</strong>
      {!compact && <span> {(state?.terms ?? '').split('. ').slice(1).join('. ') || 'Its trading fees can only fund marketing campaigns chosen by holders.'}</span>}
    </aside>
  );
}
