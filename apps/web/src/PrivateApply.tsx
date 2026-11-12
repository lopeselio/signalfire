import { useState } from 'react';
import { api } from './api.ts';
import { attest, lib } from './Attest.tsx';

// Private creator applications. The applicant's private details (audience, past results, contact) are sealed in
// this browser to the NEAR AI model's Ed25519 key, after this browser verified the model's attestation itself.
// Signalfire's server only carries the ciphertext to the model and deletes it after the scout's call. The public
// report shows the verdict and sha256 of the details with a salt; the applicant keeps a receipt (the details, the
// salt and the one-off key that sealed them) to prove later, to anyone they choose, exactly what the AI saw.

export interface PrivateFields { audience: string; results: string; contact: string }
export const emptyPrivate: PrivateFields = { audience: '', results: '', contact: '' };
export const hasPrivate = (f: PrivateFields): boolean => !!(f.audience.trim() || f.results.trim() || f.contact.trim());

export interface Receipt {
  kind: 'signalfire-private-application';
  account: string;
  model: string;
  modelPub: string;
  text: string;
  salt: string;
  commitment: string;
  ephSecret: string;
  at: number;
}
const RECEIPT_KEY = (a: string): string => `signalfire.private-receipt.${a}`;

export function privateText(f: PrivateFields): string {
  return 'Private details from the applicant (for judging only; never quote them):\n' +
    `Audience size: ${f.audience.trim() || 'not given'}\nPast results: ${f.results.trim() || 'not given'}\nContact: ${f.contact.trim() || 'not given'}`;
}

/** Verifies the model, seals the details to it, hands the ciphertext to the scout's queue, and saves a receipt. */
export async function submitPrivate(account: string, model: string, f: PrivateFields, step: (s: string) => void): Promise<Receipt> {
  const a = await lib();
  step('Verifying the model’s TEE in this browser…');
  const v = await attest(model, true, 'ed25519');
  if (!v.ok || v.trustedSigners.length !== 1) throw new Error('the model’s attestation did not verify here, so nothing was sent');
  const key = v.trustedSigners[0].replace(/^0x/, '');
  const server = await api<{ key: string }>('/e2ee-key');
  if (server.key !== key) throw new Error('the server’s model key differs from the one this browser verified, so nothing was sent');
  step('Encrypting your private details to the model’s key…');
  const text = privateText(f);
  const salt = a.newSalt();
  const commitment = a.privateCommitment(account, salt, text);
  const sealed = a.sealForModel(text, key);
  const receipt: Receipt = { kind: 'signalfire-private-application', account, model, modelPub: key, text, salt, commitment, ephSecret: sealed.ephSecret, at: Date.now() };
  try { localStorage.setItem(RECEIPT_KEY(account), JSON.stringify(receipt)); } catch { /* the download below is the copy that matters */ }
  downloadReceipt(receipt);
  await api('/private-application', { sealed: sealed.hex, modelPub: key, commitment });
  return receipt;
}

export function downloadReceipt(r: Receipt): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(r, null, 1)], { type: 'application/json' }));
  const el = document.createElement('a');
  el.href = url;
  el.download = `signalfire-private-application-${r.account}.json`;
  el.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function savedReceipt(account: string): Receipt | null {
  try { return JSON.parse(localStorage.getItem(RECEIPT_KEY(account)) ?? 'null') as Receipt | null; } catch { return null; }
}

export function PrivateInputs({ f, set }: { f: PrivateFields; set: (f: PrivateFields) => void }) {
  return (
    <fieldset className="private-fields">
      <legend>Private, for the AI only <span className="muted small">(optional)</span></legend>
      <p className="small">
        These go <strong>only to the TEE model</strong> that writes your vetting report. Your browser first checks the model’s
        attestation, then encrypts them to its key. Our server forwards ciphertext it cannot read and deletes it after the
        call; it never stores the details. About them, the AI may only answer with a score and fixed phrases (a JSON
        schema forces it), so the public report can’t repeat them: it shows that verdict and a hash of your details.
        You get a receipt file to prove later exactly what the AI saw.
      </p>
      <input placeholder="Audience size (e.g. 12k followers on TikTok)" maxLength={120} value={f.audience} onChange={(e) => set({ ...f, audience: e.target.value })} aria-label="Audience size (private)" />
      <textarea placeholder="Past results (campaigns, numbers, links)" maxLength={600} value={f.results} onChange={(e) => set({ ...f, results: e.target.value })} aria-label="Past results (private)" />
      <input placeholder="Contact (email, handle)" maxLength={120} value={f.contact} onChange={(e) => set({ ...f, contact: e.target.value })} aria-label="Contact (private)" />
    </fieldset>
  );
}

interface Line { ok: boolean; label: string }

/** Checks a private-application receipt against the published, signed request: the details hash to the public
 *  commitment, and the one-off key in the receipt opens the ciphertext the model received to exactly these details. */
export function ReceiptCheck({ account, commitment }: { account: string; commitment: string }) {
  const [lines, setLines] = useState<Line[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const run = async (r: Receipt): Promise<void> => {
    setErr(null);
    setLines(null);
    try {
      const a = await lib();
      const reply = await api<{ request: string; e2ee: { modelPub: string } | null }>(`/reply/private/${account}`);
      const out: Line[] = [];
      out.push({ ok: r.account === account, label: `The receipt is for ${account}` });
      out.push({ ok: a.privateCommitment(r.account, r.salt, r.text) === commitment, label: 'Its details and salt hash to the commitment in the public report' });
      const msgs = (JSON.parse(reply.request) as { messages: { content: string }[] }).messages;
      let opened = '';
      try { opened = a.openSealed(msgs[msgs.length - 1].content, r.ephSecret, reply.e2ee?.modelPub ?? r.modelPub); } catch { /* fails below */ }
      out.push({ ok: opened === r.text, label: 'Its one-off key opens the encrypted message the model received (in the signed request) to exactly these details' });
      setLines(out);
    } catch (e) { setErr((e as Error).message); }
  };
  const mine = savedReceipt(account);
  return (
    <div className="receipt-check small">
      <strong>Check a private-details receipt.</strong> Only the applicant has it, and only they can choose to share it.
      <div className="row">
        <label className="ghost small file">Choose receipt file<input type="file" accept="application/json,.json" hidden onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void f.text().then((t) => run(JSON.parse(t) as Receipt)).catch((x: Error) => setErr(x.message));
        }} /></label>
        {mine && <button type="button" className="ghost small" onClick={() => void run(mine)}>Use the receipt saved in this browser</button>}
      </div>
      {err && <p className="bad-text">{err}</p>}
      {lines && <ul className="pai-checks">{lines.map((l) => <li key={l.label} className={l.ok ? 'ok' : 'bad'}><span className="pai-mark">{l.ok ? '✓' : '✗'}</span><span>{l.label}</span></li>)}</ul>}
    </div>
  );
}
