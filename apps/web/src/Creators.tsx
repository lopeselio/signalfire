import { useEffect, useState } from 'react';
import { fmtNear, fmtTusd, parseNear } from '@signalfire/core';
import { CashOut } from './CashOut.tsx';
import { api, type CreatorDetail, type CreatorRec, type Nft } from './api.ts';
import { Acct, Chip, Info, Near, SignInHint, TeeBadge, useApp } from './ui.tsx';
import { call } from './wallet.ts';
import { PrivateInputs, ReceiptCheck, emptyPrivate, hasPrivate, submitPrivate, type PrivateFields } from './PrivateApply.tsx';
import { NextAction } from './NextAction.tsx';

// Creators: who may bid on campaigns, their records (from the hub and their NFTs), the scout's vetting
// reports, and how to apply.

export function Creators() {
  const { state } = useApp();
  const creators = [...state!.creators].sort((a, b) => b.creator.completed - a.creator.completed || b.rep_bps - a.rep_bps);
  return (
    <div className="creators">
      <section className="page-head">
        <p className="eyebrow">Creators</p>
        <h1>Get paid for every new customer you bring</h1>
        <p className="lede">
          Pitch on a startup’s brief, win it, and earn in three payouts as new buyers arrive through your link. People and
          AI agents both take part; an AI scout reviews each new creator within a minute.
        </p>
        <details className="tech">
          <summary>How creators are reviewed</summary>
          <p className="muted small">
            The AI scout reviews each applicant with private AI on NEAR AI Cloud and records a fingerprint of its report on
            NEAR. Fixed rules decide who gets in, not the AI: the review fee is paid and the name doesn’t copy an approved
            creator. Every approved creator gets a creator badge (an NFT that can’t be transferred) whose record updates as
            they work.
          </p>
        </details>
        <NextAction page="creators" />
      </section>
      <div className="grid-creators" data-tour="creators">
        {creators.length === 0 && <p className="muted">No creators yet. Be the first: apply below, and the AI scout replies within a minute.</p>}
        {creators.map((c) => <CreatorCard key={c.creator.account} c={c} />)}
      </div>
      <CashOut />
      <Apply />
    </div>
  );
}

/** The contract writes tUSD in raw units ("452034 tUSD (6 dp)"); show it as 0.45 tUSD. */
const tidy = (t?: string | null): string => (t ?? '').replace(/(\d+) tUSD \(6 dp\)/g, (_, n: string) => `${fmtTusd(n)} tUSD`);

function parseExtra(n: Nft): Record<string, unknown> {
  try { return JSON.parse(n.metadata?.extra ?? '{}') as Record<string, unknown>; } catch { return {}; }
}

function CreatorCard({ c }: { c: CreatorRec }) {
  const [detail, setDetail] = useState<CreatorDetail | null>(null);
  const [open, setOpen] = useState(false);
  const cr = c.creator;
  useEffect(() => {
    if (!open || detail) return;
    api<CreatorDetail>(`/creator/${cr.account}`).then(setDetail).catch(() => setDetail({ creator: null, nfts: [], vetting: null, campaigns: [] }));
  }, [open, detail, cr.account]);
  const isAgent = /^creator-/.test(cr.account);
  const badge = detail?.nfts.find((n) => n.token_id.startsWith('creator:'));
  const receipts = detail?.nfts.filter((n) => n.token_id.startsWith('receipt:')) ?? [];
  let report: { summary?: string; strengths?: string[]; risks?: string[]; fit?: number } | null = null;
  try { report = detail?.vetting ? JSON.parse(/\{[\s\S]*\}/.exec(detail.vetting.report.replace(/\n\nprivate_verdict: [\s\S]*$/, ''))?.[0] ?? 'null') : null; } catch { report = null; }
  return (
    <article className={`creator${cr.revoked ? ' revoked' : ''}`}>
      <header>
        <div className="avatar" aria-hidden="true">{cr.name.slice(0, 1)}</div>
        <div>
          <h3>{cr.name} {isAgent && <Chip kind="smoke">AI agent</Chip>}{cr.revoked && <Chip kind="bad">removed</Chip>}</h3>
          <Acct a={cr.account} />
        </div>
        <div className="rep" title="Track record (reputation): +5% per completed campaign, −10% per miss, between −20% and +30%. A better track record makes the creator’s offer count as lower.">
          <span className="n">{c.rep_bps >= 0 ? '+' : ''}{c.rep_bps / 100}%</span>
          <span className="l">track record</span>
        </div>
      </header>
      <p className="small">{cr.profile}</p>
      <dl className="record">
        <div><dt>won</dt><dd>{cr.won}</dd></div>
        <div><dt>completed</dt><dd>{cr.completed}</dd></div>
        <div><dt>missed</dt><dd>{cr.missed}</dd></div>
        <div><dt>buyers</dt><dd>{cr.results}</dd></div>
      </dl>
      <p className="small">Earned <strong>{fmtTusd(c.tusd)} tUSD</strong> (holds now) · paid <Near y={cr.paid} d={3} /> from treasuries{c.wallet && <> · wallet <Near y={c.wallet.balance} d={3} /></>}</p>
      <button className="ghost small" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Hide record' : 'Record and review'}</button>
      {open && !detail && <p className="muted small">Loading the record…</p>}
      {open && detail && (
        <div className="c-detail">
          {badge && (
            <div className="nft badge">
              <span className="nft-kind">Creator NFT, soulbound, <code>{badge.token_id.split(':')[0]}</code></span>
              <strong>{badge.metadata?.title}</strong>
              <p className="small">{tidy(badge.metadata?.description)}</p>
              <p className="muted small">Its metadata is computed from the hub’s state each time it is read.</p>
            </div>
          )}
          {receipts.map((r) => {
            const x = parseExtra(r);
            return (
              <div key={r.token_id} className="nft receipt">
                <span className="nft-kind">Campaign receipt <code>{r.token_id}</code></span>
                <strong>{r.metadata?.title}</strong>
                <p className="small">{String(x.results ?? '?')} buyers for {fmtNear(String(x.spend_yocto ?? '0'), 3)} NEAR ({fmtTusd(String(x.spend_tusd ?? '0'))} tUSD) · cost per buyer {fmtNear(String(x.cost_per_result_yocto ?? '0'), 4)} NEAR</p>
              </div>
            );
          })}
          {detail.vetting ? (
            <div className="vetting">
              <h4 data-tour="vetting">AI scout’s review <TeeBadge signed={detail.vetting.signed} model={detail.vetting.model} src={{ kind: 'vetting', account: cr.account }} what="vetting report" /></h4>
              {report?.summary ? (
                <>
                  <p className="small">{report.summary}</p>
                  {!!report.strengths?.length && <p className="small"><strong>Strengths:</strong> {report.strengths.join('; ')}</p>}
                  {!!report.risks?.length && <p className="small"><strong>Risks:</strong> {report.risks.join('; ')}</p>}
                </>
              ) : <p className="small pre">{detail.vetting.report}</p>}
              {detail.vetting.privateCommitment && (
                <div className="private-box small">
                  <strong>Private application</strong> <TeeBadge signed model={detail.vetting.model} src={{ kind: 'private', account: cr.account }} what="private verdict" />
                  <p>The applicant also sent private details (audience, past results, contact), sealed in their browser to the
                  model’s attested key. <strong>Only the AI in the TEE saw them</strong>; Signalfire’s server carried ciphertext it
                  can’t read and deleted it after the call. The note above was written from the public name and profile only.</p>
                  {detail.vetting.privateVerdict && <p>The AI’s verdict on the private details (a score and fixed phrases only): <strong>fit {detail.vetting.privateVerdict.fit}/5</strong>, the details <strong>{detail.vetting.privateVerdict.private_details}</strong>, concern: <strong>{detail.vetting.privateVerdict.concern}</strong>.</p>}
                  <p>Commitment to the private details (sha256 with the applicant’s salt): <code>{detail.vetting.privateCommitment.slice(0, 24)}…</code></p>
                  <ReceiptCheck account={cr.account} commitment={detail.vetting.privateCommitment} />
                </div>
              )}
              {detail.vetting.privateDropped && <p className="muted small">Private details were sent but couldn’t reach the model; they were deleted unread and this report is from the public profile only.</p>}
              <p className="muted small">sha256 of this report, onchain: <code>{detail.vetting.reportHash.slice(0, 20)}…</code>. Advice only: admission is the contract’s rule.</p>
            </div>
          ) : <p className="muted small">No vetting report on file.</p>}
          {detail.campaigns.length > 0 && (
            <ul className="plain small">
              {detail.campaigns.map((x) => <li key={x.id}>#{x.id} {x.title}: {x.won ? 'won' : 'bid'}, {x.phase}{x.won ? `, ${x.results} buyers` : ''}</li>)}
            </ul>
          )}
        </div>
      )}
    </article>
  );
}

function Apply() {
  const { state, me, account, run, busy, refreshMe } = useApp();
  const [name, setName] = useState('');
  const [profile, setProfile] = useState('');
  const [queued, setQueued] = useState(false);
  const [priv, setPriv] = useState<PrivateFields>(emptyPrivate);
  const [step, setStep] = useState<string | null>(null);
  const admitted = !!me?.creator;
  const applied = !!me?.application;
  const wallet = me?.wallet ? BigInt(me.wallet.balance) : 0n;
  const fee = parseNear('0.01');
  return (
    <section className="panel apply" data-tour="apply">
      <h2>Become a creator</h2>
      <p className="small">Approved creators can send offers on any startup’s campaigns and are paid in tUSD (test dollars) as new buyers arrive. Applying costs a 0.01 NEAR review fee, paid to the AI scout from your Signalfire balance. Each offer needs a 0.02 NEAR deposit from the same balance, returned when you open your offer.</p>
      <SignInHint what="apply" />
      {account && admitted && <p className="ok-text">You’re an approved creator. Open a startup’s Marketing fund and campaigns tab: each campaign taking offers shows <strong>Your sealed offer</strong>.</p>}
      {account && !admitted && (
        <ol className="apply-steps">
          <li className={wallet >= fee || applied ? 'done' : ''}>
            <strong>Add 0.03 NEAR to your Signalfire balance</strong> (the review fee plus one offer deposit). Your Signalfire balance<Info text="A balance held for you inside Signalfire’s contract (your hub wallet), with spending caps." />: <Near y={wallet} d={3} />.
            {wallet < fee && !applied && <button className="primary small" disabled={!!busy} onClick={() => void run('Add NEAR to your Signalfire balance', () => call(state!.hub, 'fund_wallet', { account }, parseNear('0.03')), { pending: 'Adding NEAR to your Signalfire balance…', done: 'Your Signalfire balance is topped up.', action: 'fund_wallet' })}>Add 0.03 NEAR</button>}
          </li>
          <li className={applied ? 'done' : ''}>
            <strong>Apply</strong>: your name and what you make.
            {!applied && (
              <div className="apply-form">
                <input placeholder="Name" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} aria-label="Creator name" />
                <textarea placeholder="What you make and for whom (max 400 characters)" maxLength={400} value={profile} onChange={(e) => setProfile(e.target.value)} aria-label="Profile" />
                {state!.nearAi && <PrivateInputs f={priv} set={setPriv} />}
                {step && <p className="muted small">{step}</p>}
                <button className="primary small" disabled={!!busy || !name.trim() || wallet < fee} onClick={() => void run('Apply as a creator', async () => {
                  if (hasPrivate(priv)) {
                    // sealed and queued before the onchain application, so the scout has it when it vets
                    try { await submitPrivate(account, state!.nearAiModel, priv, setStep); } finally { setStep(null); }
                    setStep('Your receipt file was downloaded. Keep it: it proves exactly what the AI saw. Now confirm the application in your wallet.');
                  }
                  const r = await call(state!.hub, 'apply_creator', { name: name.trim(), profile: profile.trim() });
                  await api('/applied', {}).catch(() => undefined);
                  setQueued(true);
                  refreshMe();
                  return r;
                }, { pending: 'Sending your application to the AI scout…', done: 'Application sent. The AI scout usually reviews it within a minute.', action: 'apply_creator' })}>Apply</button>
              </div>
            )}
          </li>
          <li className={queued || applied ? 'now' : ''}>
            <strong>The AI scout reviews you</strong> within a minute: it files a report, and fixed rules decide whether you’re in.
            {applied && !queued && <button className="ghost small" onClick={() => void api('/applied', {}).then(() => setQueued(true)).catch(() => undefined)}>Remind the AI scout</button>}
          </li>
        </ol>
      )}
    </section>
  );
}
