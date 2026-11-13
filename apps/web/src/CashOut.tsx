import { useCallback, useEffect, useState } from 'react';
import { b64encode, cashOutIntents, fmtNear, fmtTusd, intentsMessage, intentsNonce, nearForTusd } from '@signalfire/core';
import { api, txUrl } from './api.ts';
import { useApp } from './ui.tsx';
import { call, signMessage } from './wallet.ts';
import { friendly } from './copy.ts';

// A signed-in creator cashes tUSD earnings out for NEAR through the NEAR Intents Verifier.
// Three wallet steps, then the desk settles: deposit tUSD into the Verifier for your own account; register your
// wallet's key with the Verifier (once); sign the cash-out intent (−tUSD, +NEAR at 1 NEAR = 3 tUSD, paid to you).
// The server checks the signed message is exactly that before the desk signs its side (cashout.ts).

interface Info { enabled: boolean; verifier: string; tusd: string; wnear: string; desk: string; tusdPerNear: number; salt: string | null; deposited: string; keyRegistered: boolean | null }

const random15 = (): Uint8Array => crypto.getRandomValues(new Uint8Array(15));

export function CashOut() {
  const { me, account, refreshMe } = useApp();
  const [info, setInfo] = useState<Info | null>(null);
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ tx: string; near: string } | null>(null);
  const load = useCallback(() => { api<Info>('/intents/info').then(setInfo).catch(() => setInfo(null)); }, []);
  useEffect(() => { if (account) load(); }, [account, load]);
  if (!account || !me) return null;
  const wallet = BigInt(me.tusd ?? '0');
  const deposited = BigInt(info?.deposited ?? '0');
  const total = wallet + deposited;
  if (total === 0n && !done) return null;

  const run = async (): Promise<void> => {
    if (!info) return;
    setError(null);
    try {
      if (wallet > 0n) {
        setStep('1 of 3: Moving your tUSD to the exchange (confirm in your wallet)');
        await call(info.tusd, 'ft_transfer_call', { receiver_id: info.verifier, amount: wallet.toString(), msg: account }, 1n);
      }
      setStep('2 of 3: Approving the exchange: give tUSD, get NEAR (your wallet shows exactly that)');
      const fresh = await api<Info>('/intents/info');
      const amount = BigInt(fresh.deposited);
      if (amount === 0n) throw new Error('Your tUSD hasn’t reached the exchange yet. Try again in a few seconds.');
      const deadline = Date.now() + 5 * 60_000;
      const message = intentsMessage(account, deadline, cashOutIntents({ tusd: info.tusd, wnear: info.wnear, amount, receiver: account }));
      const nonce = intentsNonce(fresh.salt ?? '', deadline, random15());
      const signed = await signMessage(message, info.verifier, nonce);
      const reg = await api<Info>(`/intents/info?publicKey=${encodeURIComponent(signed.publicKey)}`);
      if (!reg.keyRegistered) {
        setStep('One-time setup: letting the exchange recognise your wallet (confirm in your wallet)');
        await call(info.verifier, 'add_public_key', { public_key: signed.publicKey }, 1n);
      }
      setStep('3 of 3: Signalfire’s exchange desk is completing the swap. Both sides happen together or not at all.');
      const r = await api<{ tx: string; near: string }>('/intents/cashout', { amount: amount.toString(), message, nonce: b64encode(nonce), recipient: info.verifier, publicKey: signed.publicKey, signature: signed.signature });
      setDone(r);
      refreshMe();
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStep(null);
    }
  };

  return (
    <section className="panel cashout" data-tour="cashout">
      <h2>Cash out your tUSD through NEAR Intents</h2>
      <p className="small">
        Campaign payouts arrive as tUSD (a labelled test stablecoin). Swap them for NEAR at the hub’s fixed test rate,
        1 NEAR = {info?.tusdPerNear ?? 3} tUSD, settled by the NEAR Intents Verifier: you sign one intent in your wallet (give tUSD, get NEAR),
        the desk signs the other side, and the Verifier executes both or neither.
      </p>
      <dl className="facts">
        <div><dt>tUSD in your wallet</dt><dd>{fmtTusd(wallet)} tUSD</dd></div>
        {deposited > 0n && <div><dt>tUSD already in the Verifier</dt><dd>{fmtTusd(deposited)} tUSD</dd></div>}
        <div className="strong"><dt>You receive</dt><dd>{fmtNear(nearForTusd(total), 4)} NEAR</dd></div>
      </dl>
      {info && !info.enabled && <p className="bad-text small">Cash-outs are switched off on this server (no desk key).</p>}
      <button className="primary" disabled={!info?.enabled || !!step || total === 0n} onClick={() => void run()}>Cash out {fmtTusd(total)} tUSD</button>
      {step && <p className="small clock">{step}…</p>}
      {error && <p className="bad-text small" title={error}>{friendly(error)}</p>}
      {done && <p className="ok-text small">Received {fmtNear(done.near, 4)} NEAR. <a href={txUrl(done.tx)} target="_blank" rel="noreferrer">execute_intents on the Verifier</a></p>}
      <p className="muted small">
        Testnet only. NEAR Intents (<code>intents.near</code>) runs on mainnet; on testnet Signalfire deploys its own instance of the
        open-source <a href="https://github.com/near/intents" target="_blank" rel="noreferrer">near/intents</a> Verifier at <code>{info?.verifier ?? 'signalfire-intents.testnet'}</code>.
        The desk (<code>{info?.desk ?? 'signalfire-desk.testnet'}</code>) is the counterparty, not a solver network.
      </p>
    </section>
  );
}
