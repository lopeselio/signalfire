import { useEffect, useRef, useState } from 'react';
import type { Check, ModelVerification, SignedReply } from '@signalfire/attest';
import { api } from './api.ts';

// "Private AI, verified": checks, in this browser, that a vetting report or a pitch was signed by a key that
// lives inside an attested NEAR AI Cloud TEE. The model's attestation is fetched straight from cloud-api.near.ai
// with a nonce this page picks, the Intel quote is verified here (dcap-qvl, collateral from Phala's PCCS), and
// only the GPU evidence goes through our server, because NVIDIA refuses browsers; NVIDIA's answer is signed,
// so it is checked here too. One attestation per model per page load; each reply's signature is checked against it.

export type ReplySource = { kind: 'vetting' | 'private'; account: string } | { kind: 'pitch'; campaign: number; creator: string };

export const lib = () => import('@signalfire/attest');
const runs = new Map<string, Promise<ModelVerification>>();
const nras = async (payloadJson: string): Promise<unknown> => {
  const res = await fetch('/api/nras', { method: 'POST', headers: { 'content-type': 'application/json' }, body: payloadJson });
  if (!res.ok) throw new Error(`relay HTTP ${res.status}`);
  return res.json();
};
export function attest(model: string, fresh = false, algo: 'ecdsa' | 'ed25519' = 'ecdsa'): Promise<ModelVerification> {
  const k = `${model}|${algo}`;
  if (fresh || !runs.has(k)) {
    const p = lib().then((a) => a.attestModel(model, { nras, algo }));
    p.catch(() => runs.delete(k));
    runs.set(k, p);
  }
  return runs.get(k)!;
}

interface Result { verification: ModelVerification | null; error: string | null; reply: SignedReply | null; replyChecks: Check[] }
type Status = 'checking' | 'ok' | 'bad';

function useCheck(src: ReplySource, model: string) {
  const [res, setRes] = useState<Result | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    setRes(null);
    const path = src.kind === 'pitch' ? `/reply/pitch/${src.campaign}/${src.creator}` : `/reply/${src.kind}/${src.account}`;
    void (async () => {
      const a = await lib();
      const reply = await api<SignedReply>(path).catch(() => null);
      let verification: ModelVerification | null = null;
      let error: string | null = null;
      try { verification = await attest(reply?.model ?? model, n > 0, reply?.signingAlgo === 'ed25519' ? 'ed25519' : 'ecdsa'); } catch (e) { error = (e as Error).message; }
      if (live) setRes({ verification, error, reply, replyChecks: reply ? a.replyChecks(reply, verification) : [{ id: 'reply', label: 'The signed reply is published', ok: false }] });
    })();
    return () => { live = false; };
  }, [src.kind, (src as { account?: string }).account, (src as { campaign?: number }).campaign, (src as { creator?: string }).creator, model, n]);
  const status: Status = !res ? 'checking' : res.verification?.ok && res.replyChecks.every((c) => c.ok) ? 'ok' : 'bad';
  return { res, status, again: () => setN((x) => x + 1) };
}

const Shield = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5 13.5 4v4c0 3.2-2.3 5.6-5.5 6.5C4.8 13.6 2.5 11.2 2.5 8V4z" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="m5.5 8 1.8 1.8L10.8 6.3" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
);

export function PrivateAiBadge({ src, model, what }: { src: ReplySource; model: string; what: string }) {
  const { res, status, again } = useCheck(src, model);
  const dlg = useRef<HTMLDialogElement>(null);
  const label = status === 'checking' ? 'Private AI, checking…' : status === 'ok' ? '✓ Private AI, verified' : '✗ Private AI, not verified';
  return (
    <>
      <button type="button" className={`pai pai-${status}`} onClick={() => dlg.current?.showModal()} title="Open the checks this browser ran">
        <Shield /> {label}
      </button>
      <dialog ref={dlg} className="pai-dialog" onClick={(e) => { if (e.target === dlg.current) dlg.current?.close(); }}>
        <Details what={what} res={res} status={status} again={again} close={() => dlg.current?.close()} />
      </dialog>
    </>
  );
}

function Row({ c }: { c: Check }) {
  return (
    <li className={c.ok ? 'ok' : 'bad'}>
      <span className="pai-mark" aria-label={c.ok ? 'passed' : 'failed'}>{c.ok ? '✓' : '✗'}</span>
      <span>{c.label}{c.detail && <code className="pai-detail">{c.detail}</code>}</span>
    </li>
  );
}

function Details({ what, res, status, again, close }: { what: string; res: Result | null; status: Status; again: () => void; close: () => void }) {
  const v = res?.verification;
  const cand = v?.candidates.find((c) => c.signingAddress.toLowerCase() === res?.reply?.signingAddress?.toLowerCase()) ?? v?.candidates[0];
  const m = cand?.measurements;
  return (
    <div className="pai-body">
      <header>
        <h3>{status === 'ok' ? '✓ Private AI, verified' : status === 'checking' ? 'Checking the private AI…' : '✗ Not verified'}</h3>
        <button type="button" className="ghost small" onClick={close} aria-label="Close">Close</button>
      </header>
      <p className="small">
        {res?.reply?.signingAlgo === 'ed25519' && <>The request was <strong>end-to-end encrypted</strong> to the model’s attested Ed25519 key, so the check below uses that key’s report. </>}
        This {what} was written by <strong>{res?.reply?.model ?? v?.model ?? 'the model'}</strong> on NEAR AI Cloud. Your browser just checked it
        itself: it picked a fresh nonce, fetched the model’s attestation from <code>cloud-api.near.ai</code>, verified the Intel TDX quote
        and NVIDIA’s GPU verdict, and checked the {what}’s signature against the attested key. Our server only relayed the GPU evidence to
        NVIDIA (NVIDIA blocks browsers); NVIDIA’s answer is signed, and was checked here.
      </p>
      {!res && <p className="muted small">Fetching the report and Intel’s collateral… (about 300 KB, a few seconds)</p>}
      {res?.error && <p className="bad-text small">Couldn’t check the attestation: {res.error}</p>}
      {v && (
        <>
          <h4>The TEE <span className="muted small">nonce {v.nonce.slice(0, 16)}…</span></h4>
          {v.candidates.length === 0 && <p className="bad-text small">NEAR AI returned no model report.</p>}
          {cand && <ul className="pai-checks">{cand.checks.map((c) => <Row key={c.id} c={c} />)}</ul>}
          {m?.mrTd && (
            <dl className="pai-meas">
              <div><dt>Signing key</dt><dd><code>{cand!.signingAddress}</code></dd></div>
              <div><dt>TCB status</dt><dd>{m.tcbStatus}{m.advisories?.length ? ` (${m.advisories.join(', ')})` : ''}</dd></div>
              <div><dt>MRTD</dt><dd><code>{m.mrTd}</code></dd></div>
              <div><dt>RTMR3</dt><dd><code>{m.rtmr3}</code></dd></div>
              <div><dt>Compose hash</dt><dd><code>{m.composeHash}</code></dd></div>
              {m.appId && <div><dt>App id</dt><dd><code>{m.appId}</code></dd></div>}
              {!!m.gpus?.length && <div><dt>GPUs</dt><dd>{m.gpus.length} × {[...new Set(m.gpus)].join(', ')}</dd></div>}
            </dl>
          )}
        </>
      )}
      {res && (
        <>
          <h4>This {what}</h4>
          <ul className="pai-checks">{res.replyChecks.map((c) => <Row key={c.id} c={c} />)}</ul>
        </>
      )}
      <PaiCopy />
      <p className="row">
        <button type="button" className="ghost small" disabled={!res} onClick={again}>Check again with a new nonce</button>
        <span className="muted small">Same checks from a terminal: <code>pnpm verify &lt;campaign&gt;</code></span>
      </p>
    </div>
  );
}

function PaiCopy() {
  const [t, setT] = useState<{ PROVES: string; DOES_NOT_PROVE: string } | null>(null);
  useEffect(() => { void lib().then((a) => setT({ PROVES: a.PROVES, DOES_NOT_PROVE: a.DOES_NOT_PROVE })); }, []);
  if (!t) return null;
  return (
    <div className="pai-copy small">
      <p><strong>What this proves.</strong> {t.PROVES}</p>
      <p><strong>What it doesn’t.</strong> {t.DOES_NOT_PROVE}</p>
    </div>
  );
}
