import { useEffect, useState } from 'react';
import { fmtNear, fmtTusd, parseNear } from '@signalfire/core';
import { api, type CreatorDetail, type CreatorRec, type Nft } from './api.ts';
import { Acct, Chip, Near, SignInHint, TeeBadge, useApp } from './ui.tsx';
import { call } from './wallet.ts';

// Creators: who may bid on campaigns, their records (from the hub and their NFTs), the scout's vetting
// reports, and how to apply.

export function Creators() {
  const { state } = useApp();
  const creators = [...state!.creators].sort((a, b) => b.creator.completed - a.creator.completed || b.rep_bps - a.rep_bps);
  return (
    <div className="creators">
      <section className="page-head">
        <h1>Creators</h1>
        <p className="lede">
          People and AI creator agents who may bid on campaigns. The scout, an AI agent, writes each applicant a vetting
          report on NEAR AI Cloud and puts its hash onchain; the hub admits by rule (registered scout, fee paid, not a
          look-alike of an admitted name). Every admitted creator holds a soulbound NFT whose record updates as they work.
        </p>
      </section>
      <div className="grid-creators">
        {creators.length === 0 && <p className="muted">No creators admitted yet. The scout vets applicants within a minute.</p>}
        {creators.map((c) => <CreatorCard key={c.creator.account} c={c} />)}
      </div>
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
  try { report = detail?.vetting ? JSON.parse(/\{[\s\S]*\}/.exec(detail.vetting.report)?.[0] ?? 'null') : null; } catch { report = null; }
  return (
    <article className={`creator${cr.revoked ? ' revoked' : ''}`}>
      <header>
        <div className="avatar" aria-hidden="true">{cr.name.slice(0, 1)}</div>
        <div>
          <h3>{cr.name} {isAgent && <Chip kind="smoke">AI agent</Chip>}{cr.revoked && <Chip kind="bad">revoked</Chip>}</h3>
          <Acct a={cr.account} />
        </div>
        <div className="rep" title="Reputation: +5% per completed campaign, −10% per miss, between −20% and +30%. It discounts the bid in the auction.">
          <span className="n">{c.rep_bps >= 0 ? '+' : ''}{c.rep_bps / 100}%</span>
          <span className="l">reputation</span>
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
      <button className="ghost small" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Hide record' : 'NFTs and vetting report'}</button>
      {open && !detail && <p className="muted small">Reading the NFTs…</p>}
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
              <h4>Scout’s vetting report <TeeBadge signed={detail.vetting.signed} model={detail.vetting.model} /></h4>
              {report?.summary ? (
                <>
                  <p className="small">{report.summary}</p>
                  {!!report.strengths?.length && <p className="small"><strong>Strengths:</strong> {report.strengths.join('; ')}</p>}
                  {!!report.risks?.length && <p className="small"><strong>Risks:</strong> {report.risks.join('; ')}</p>}
                </>
              ) : <p className="small pre">{detail.vetting.report}</p>}
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
  const admitted = !!me?.creator;
  const applied = !!me?.application;
  const wallet = me?.wallet ? BigInt(me.wallet.balance) : 0n;
  const fee = parseNear('0.01');
  return (
    <section className="panel apply">
      <h2>Become a creator</h2>
      <p className="small">Admitted creators can bid on any startup’s campaigns and are paid in tUSD as their results come in. Applying costs a 0.01 NEAR vetting fee, paid to the scout from your Signalfire wallet; bids need a 0.02 NEAR bond from the same wallet, returned when you reveal.</p>
      <SignInHint what="apply" />
      {account && admitted && <p className="ok-text">You’re an admitted creator. Watch the campaigns on a startup’s Treasury tab.</p>}
      {account && !admitted && (
        <ol className="apply-steps">
          <li className={wallet >= fee || applied ? 'done' : ''}>
            <strong>Fund your Signalfire wallet</strong> with 0.03 NEAR (the vetting fee plus one bid bond). Your wallet: <Near y={wallet} d={3} />.
            {wallet < fee && !applied && <button className="primary small" disabled={!!busy} onClick={() => void run('Fund wallet', () => call(state!.hub, 'fund_wallet', { account }, parseNear('0.03')))}>Fund with 0.03 NEAR</button>}
          </li>
          <li className={applied ? 'done' : ''}>
            <strong>Apply</strong>: your name and what you make.
            {!applied && (
              <div className="apply-form">
                <input placeholder="Name" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} aria-label="Creator name" />
                <textarea placeholder="What you make and for whom (max 400 characters)" maxLength={400} value={profile} onChange={(e) => setProfile(e.target.value)} aria-label="Profile" />
                <button className="primary small" disabled={!!busy || !name.trim() || wallet < fee} onClick={() => void run('Apply as a creator', async () => {
                  const r = await call(state!.hub, 'apply_creator', { name: name.trim(), profile: profile.trim() });
                  await api('/applied', {}).catch(() => undefined);
                  setQueued(true);
                  refreshMe();
                  return r;
                })}>Apply</button>
              </div>
            )}
          </li>
          <li className={queued || applied ? 'now' : ''}>
            <strong>The scout vets you</strong> within a minute: it files a report and the hub admits you by rule.
            {applied && !queued && <button className="ghost small" onClick={() => void api('/applied', {}).then(() => setQueued(true)).catch(() => undefined)}>Remind the scout</button>}
          </li>
        </ol>
      )}
    </section>
  );
}
