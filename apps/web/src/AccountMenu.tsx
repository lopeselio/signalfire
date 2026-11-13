import { useEffect, useRef, useState } from 'react';
import { fmtNear, fmtTokens, fmtTusd } from '@signalfire/core';
import type { Me, State } from './api.ts';
import { shortAcct } from './ui.tsx';

/**
 * The signed-in account in the header: the account and its Signalfire wallet balance (what offers' bonds and
 * wallet buys come from); click for every token you hold, the wallet, test dollars, and Sign out.
 */
export function AccountMenu({ account, me, state, go, onSignOut }: {
  account: string; me: Me | null; state: State | null; go: (path: string) => void; onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent): void => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);

  const mine = me?.accountId === account ? me : null;
  const held = (mine?.tokens ?? []).filter((t) => BigInt(t.balance) > 0n);
  const name = (id: string): string => state?.startups.find((s) => s.id === id)?.name ?? id.toUpperCase();
  const wallet = mine?.wallet ? BigInt(mine.wallet.balance) : null;
  const near = mine?.near ? BigInt(mine.near) : null;
  const tusd = mine ? BigInt(mine.tusd || '0') : 0n;

  return (
    <span className="me acct-menu" ref={box}>
      <button className="ghost small acct-chip" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="true" title={account}>
        <span className="me-acct">{shortAcct(account)}</span>
        {near !== null && <span className="me-bal" title="Your NEAR balance">{fmtNear(near, 2)} NEAR</span>}
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="acct-pop" role="menu">
          <p className="acct-id" title={account}>{account}</p>
          <div className="acct-near">
            <span className="acct-near-n">{near !== null ? fmtNear(near, 4) : '…'}</span> <span>NEAR</span>
            <span className="hint"> in your wallet (testnet)</span>
          </div>
          <h4>Your attention tokens</h4>
          {held.length === 0
            ? <p className="hint">None yet. Buy tokens on any startup’s page.</p>
            : (
              <ul>
                {held.map((t) => (
                  <li key={t.startup}>
                    <a href={`/s/${t.startup}`} onClick={(e) => { e.preventDefault(); setOpen(false); go(`/s/${t.startup}`); }}>
                      {fmtTokens(t.balance)} {t.startup.toUpperCase()}
                    </a>
                    <span className="hint"> {name(t.startup)}{t.founder ? ' · you founded it' : t.holder ? ' · holder' : ''}</span>
                  </li>
                ))}
              </ul>
            )}
          <h4>Signalfire wallet</h4>
          <p className="hint">
            {wallet === null ? 'Not opened yet. Creators add NEAR to it on the Creators page.' : <>{fmtNear(wallet, 4)} NEAR: offer bonds and wallet buys come from here.</>}
          </p>
          {tusd > 0n && <p className="hint">{fmtTusd(tusd)} test dollars (tUSD) from campaign payouts.</p>}
          <button className="ghost small" onClick={() => { setOpen(false); onSignOut(); }}>Sign out</button>
        </div>
      )}
    </span>
  );
}
