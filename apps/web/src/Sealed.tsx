import { useEffect, useState } from 'react';
import type { Check } from '@signalfire/attest';
import { api, txUrl, type Campaign } from './api.ts';
import { lib } from './Attest.tsx';

// Briefs whose bids are scored privately by OutLayer (TEE compute for NEAR). Creators encrypt their bid to a key that
// only Signalfire's scoring program can derive inside an OutLayer TEE; the hub stores ciphertexts, nobody reveals, and
// when bidding closes the TEE opens every bid and returns only the winner's. This panel links the run and checks its
// attestation in the browser: the Intel quote, the task hash (code, input, output), and OutLayer's onchain allowlist.

export interface SealedInfo {
  book: {
    status: string; entries: { creator: string; ciphertext: string }[]; wasm_hash: string; bid_key: string; attempts: number;
    input: string | null; output: string | null; valid: boolean[];
  } | null;
  scorer: { outlayer: string; wasm_url: string; wasm_hash: string; bid_key: string | null } | null;
  runs: { requestId: number | null; tx: string; at: number }[];
  keyRequest: number;
  outlayerApi: string;
}

const cache = new Map<number, SealedInfo>();
/** The sealed-brief record of a campaign (null while loading). Re-read while the brief is still open. */
export function useSealed(c: Campaign): SealedInfo | null {
  const [info, setInfo] = useState<SealedInfo | null>(cache.get(c.id) ?? null);
  const settled = info?.book ? ['scored', 'abandoned'].includes(info.book.status) : c.phase !== 'bidding' && info !== null;
  useEffect(() => {
    if (settled) return;
    let live = true;
    const load = (): void => void api<SealedInfo>(`/campaign/${c.id}/sealed`).then((i) => { cache.set(c.id, i); if (live) setInfo(i); }).catch(() => undefined);
    load();
    const t = c.phase === 'bidding' ? setInterval(load, 10_000) : null;
    return () => { live = false; if (t) clearInterval(t); };
  }, [c.id, c.phase, c.bids.length, settled]);
  return info;
}

/** Whether a new bid on this brief is sealed for the TEE: the scorer's key if so. */
export function sealKey(c: Campaign, info: SealedInfo | null): string | null {
  if (!info?.scorer?.bid_key) return null;
  if (info.book) return info.book.bid_key;
  return c.bids.length === 0 ? info.scorer.bid_key : null;
}

async function approved(register: string, measurements: unknown): Promise<boolean> {
  for (const rpc of ['https://rpc.testnet.fastnear.com', 'https://test.rpc.fastnear.com']) {
    try {
      const j = (await (await fetch(rpc, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'call_function', finality: 'final', account_id: register, method_name: 'is_measurements_approved', args_base64: btoa(JSON.stringify({ measurements })) } }),
      })).json()) as { result?: { result: number[] } };
      if (j.result) return new TextDecoder().decode(Uint8Array.from(j.result.result)) === 'true';
    } catch { /* next RPC */ }
  }
  throw new Error('could not read the allowlist');
}

export function SealedPanel({ c }: { c: Campaign }) {
  const info = useSealed(c);
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const book = info?.book;
  if (!info || !book) return null;
  const run = [...info.runs].reverse().find((r) => r.requestId !== null);
  const out = book.output ? JSON.parse(book.output) as { winner: string | null } : null;
  const losers = book.status === 'scored' ? book.entries.length - (out?.winner ? 1 : 0) : 0;
  const verify = async (): Promise<void> => {
    if (!run?.requestId || !book.input || !book.output) return;
    setBusy(true);
    setErr(null);
    try {
      const a = await lib();
      const att = await a.fetchOutlayerAttestation(run.requestId, info.outlayerApi);
      const r = await a.verifyOutlayerRun(att, { wasmHash: book.wasm_hash, input: book.input, output: book.output, caller: att.caller_account_id ?? '', approved: (m) => approved(`worker.${info.scorer?.outlayer ?? 'outlayer.testnet'}`, m) });
      setChecks(r.checks.filter((k) => k.id !== 'ol.caller'));
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="private-box small sealed-panel" data-tour="sealed-panel">
      <strong>Offers scored privately (OutLayer)</strong>
      <p>
        Each creator encrypted their offer so that only Signalfire’s scoring program, running in secure hardware, can read it.
        Signalfire’s contract holds {book.entries.length} encrypted offer{book.entries.length === 1 ? '' : 's'}; nobody opens them by hand.{' '}
        {book.status === 'open' && 'When offers close, the program scores every offer and opens only the winner’s.'}
        {book.status === 'scoring' && 'Scoring the offers now…'}
        {book.status === 'failed' && 'The last scoring attempt didn’t give a valid answer, so it’s running again.'}
        {book.status === 'abandoned' && 'Scoring didn’t finish in time: every deposit went back and no offer was opened.'}
        {book.status === 'scored' && <>Scoring opened only the winning offer, and Signalfire’s contract checked it matches what the creator sealed. <strong>{losers} losing offer{losers === 1 ? ' was' : 's were'} never opened</strong>, to us or anyone.</>}
      </p>
      <details className="tech">
      <summary>Proof of the scoring run</summary>
      <p className="muted">
        Scorer wasm <code title={book.wasm_hash}>{book.wasm_hash.slice(0, 16)}…</code> (source: <code>outlayer/scorer</code>) · bid key <code title={book.bid_key}>{book.bid_key.slice(0, 16)}…</code>
        {run && <> · <a href={txUrl(run.tx)} target="_blank" rel="noreferrer">scoring tx</a></>}
        {run?.requestId != null && <> · <a href={`${info.outlayerApi}/attestations/by-request/${run.requestId}`} target="_blank" rel="noreferrer">attestation (request {run.requestId})</a></>}
        {' '}· command line: <code>pnpm verify {c.id}</code>
      </p>
      </details>
      {book.status === 'scored' && run?.requestId != null && (
        <p className="row">
          <button type="button" className="ghost small" disabled={busy} onClick={() => void verify()}>{busy ? 'Checking…' : checks ? 'Check again' : 'Check the scoring run from your browser'}</button>
        </p>
      )}
      {err && <p className="bad-text">{err}</p>}
      {checks && <ul className="pai-checks">{checks.map((k) => <li key={k.id} className={k.ok ? 'ok' : 'bad'}><span className="pai-mark">{k.ok ? '✓' : '✗'}</span><span>{k.label}{k.detail && <code className="pai-detail">{k.detail}</code>}</span></li>)}</ul>}
      {checks && <p className="muted">In short: approved secure hardware ran exactly Signalfire’s scoring program on exactly these sealed offers and gave exactly the answer the contract accepted. This proves an approved OutLayer worker, in an Intel TDX TEE, ran exactly that wasm on exactly the onchain ciphertexts and produced exactly the answer the hub accepted. It relies on OutLayer’s keystore to give the bid key only to that wasm when the hub asks.</p>}
    </div>
  );
}
