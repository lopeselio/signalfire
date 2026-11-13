import { useEffect, useState } from 'react';
import { fmtTusd } from '@signalfire/core';
import { acctUrl, api } from './api.ts';
import { ago } from './ui.tsx';

// The keyless treasury agent (Chain Signatures). It holds tUSD for payouts in an account whose only key is derived by
// NEAR's MPC network for the hub contract: no person or server holds that key, and the hub asks for a signature only
// for a payout its spend policy approved. Everything here can be checked with `pnpm verify <campaign>`.

interface Info {
  desk: { account: string; public_key: string; signer: string; path: string; enabled: boolean; tusd_free: string; actions: number; created_ms: number } | null;
  tusdBalance?: string | null;
  derivedKey?: string | null;
  keys?: { publicKey: string; fullAccess: boolean }[];
  actions?: { id: number; campaign: number; milestone: number; receiver: string; tusd: string; status: string; created_ms: number; signs: number; txHash: string | null; txUrl: string | null }[];
}

const STATUS: Record<string, string> = {
  approved: 'approved, waiting for NEAR’s signature',
  signing: 'NEAR’s signing network is signing',
  signed: 'signed, on its way',
  delivering: 'on its way',
  paid: 'paid',
  fallback: 'paid directly by Signalfire’s contract (the agent was late)',
  'failed:transfer': 'failed and undone',
};

/** tUSD with enough decimals that a small payout doesn't read as 0. */
const small = (raw: string): string => (BigInt(raw) < 10_000n ? (Number(raw) / 1e6).toFixed(4) : fmtTusd(raw));

export function KeylessAgent({ startup }: { startup?: string }) {
  const [info, setInfo] = useState<Info | null>(null);
  useEffect(() => {
    const load = (): void => void api<Info>('/agent').then(setInfo).catch(() => undefined);
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, []);
  if (!info?.desk) return null;
  const d = info.desk;
  const keys = info.keys ?? [];
  const onlyMpcKey = keys.length === 1 && keys[0].publicKey === d.public_key && info.derivedKey === d.public_key;
  const actions = info.actions ?? [];
  return (
    <section className="panel keyless" data-startup={startup}>
      <h2>Keyless payout agent <span className="chip ok">no person holds its key</span></h2>
      <p className="small">
        Creators are paid in tUSD by an account that no person or server holds a key to. Only NEAR’s signing network can
        sign for it, and only when Signalfire’s contract asks, which it does only for a payout the spend limits approved,
        with the amount and the creator fixed. Every payment is checked again, so each payout lands exactly once.
      </p>
      <details className="tech">
      <summary>How the key works</summary>
      <p className="small">
        Creator payouts in tUSD are sent by <a href={acctUrl(d.account)} target="_blank" rel="noreferrer"><code>{d.account.slice(0, 10)}…{d.account.slice(-6)}</code></a>,
        a NEAR account whose only key is derived by NEAR’s MPC network (Chain Signatures) for the hub contract. The agent
        acts only when the hub asks the MPC network for a signature, and the hub asks only for a payout its spend policy
        approved, with the transaction’s content (amount, payee, action) fixed by the contract. The hub checks every
        delivery again and refunds a second one, so a payout lands once.
      </p>
      <dl className="facts small">
        <div><dt>Key</dt><dd><code title={d.public_key}>{d.public_key.slice(0, 22)}…</code></dd></div>
        <div><dt>Derived by</dt><dd><a href={acctUrl(d.signer)} target="_blank" rel="noreferrer">{d.signer}</a>, path <code>{d.path}</code>, Ed25519</dd></div>
        <div><dt>Access keys</dt><dd className={onlyMpcKey ? 'ok-text' : 'bad-text'}>{onlyMpcKey ? '1, the MPC-derived key (checked just now)' : `${keys.length}: check failed`}</dd></div>
      </dl>
      <p className="muted small">Next step, not built: Shade Agents (the agent’s own code running in a TEE, holding its key). Here the agent has no code of its own; the hub contract is its brain. Check it: <code>pnpm verify &lt;campaign&gt;</code>.</p>
      </details>
      <dl className="facts small">
        <div><dt>Who can sign</dt><dd className={onlyMpcKey ? 'ok-text' : 'bad-text'}>{onlyMpcKey ? 'NEAR’s signing network only (checked just now)' : 'Check failed: this account has other keys'}</dd></div>
        <div><dt>Holds</dt><dd>{info.tusdBalance ? `${fmtTusd(info.tusdBalance)} tUSD` : '…'} ({fmtTusd(d.tusd_free)} available for new payouts)</dd></div>
        <div><dt>Payouts</dt><dd>{d.enabled ? 'on' : 'off: Signalfire’s contract pays creators directly'} · {d.actions} so far</dd></div>
      </dl>
      {actions.length > 0 && (
        <ul className="plain small keyless-actions">
          {actions.slice(0, 6).map((a) => (
            <li key={a.id}>
              #{a.campaign} payout {a.milestone} of 3: {small(a.tusd)} tUSD to {a.receiver.split('.')[0]} · {STATUS[a.status] ?? a.status} · {ago(a.created_ms)}
              {a.txUrl && <> · <a href={a.txUrl} target="_blank" rel="noreferrer" title="The agent’s transaction">view</a></>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

