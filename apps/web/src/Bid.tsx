import { useRef, useState } from 'react';
import {
  BID_BOND, bidStage, credible, fmtNear, fmtTusd, openingMatches, parseNear, score, sealBid, walletRefusal, type BidOpening,
} from '@signalfire/core';
import { api, type Campaign, type Startup } from './api.ts';
import { Acct, Chip, Near, Tx, fmtLeft, useApp, useNow } from './ui.tsx';
import { call } from './wallet.ts';

// A person's sealed bid, the same commit-reveal the creator agents use (packages/core seals it, the hub checks it):
// the browser draws the salt, hashes price + pitch + salt, keeps that opening in localStorage (and offers it as a
// file), and sends only the hash with commit_bid. In the reveal window one click sends the opening with reveal_bid;
// then the server publishes it so `pnpm verify` can check it. Both calls take no deposit, so they go gasless.

export interface SavedOpening extends BidOpening { hub: string; savedAt: number; committedTx?: string; revealedTx?: string }

const KEY = 'signalfire:openings';

export function loadOpenings(): SavedOpening[] {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]') as SavedOpening[]; } catch { return []; }
}
function storeOpenings(list: SavedOpening[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(-200))); } catch { /* private mode: the file download is the copy */ }
}
/** Adds or updates an opening (keyed by its commitment hash). */
function keepOpening(o: SavedOpening): void {
  storeOpenings([...loadOpenings().filter((x) => x.hash !== o.hash), o]);
}

function download(name: string, data: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const fileName = (o: BidOpening): string => `signalfire-bid-${o.campaign}-${o.creator}.json`;

function randomSalt(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export function MyBid({ c, s }: { c: Campaign; s: Startup }) {
  const { state, me, account, run, busy } = useApp();
  const now = useNow(1000);
  const [price, setPrice] = useState('');
  const [pitch, setPitch] = useState('');
  const [importErr, setImportErr] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  if (!account || !state) return null;
  const hub = state.hub;
  const mine = c.bids.find((b) => b.creator === account);
  const admitted = !!me?.creator && !me.creator.creator.revoked;
  if (!mine && !admitted) return null;

  const stage = bidStage(c, now);
  const minBps = s.constraints.min_bid_bps;
  const budget = BigInt(c.budget);
  const floor = (budget * BigInt(minBps)) / 10_000n;
  const saved = loadOpenings().filter((o) => o.hub === hub && o.campaign === c.id && o.creator === account);
  const opening = mine ? saved.find((o) => o.hash === mine.hash) : undefined;
  const published = !!c.pitches[account];

  // ---------- no bid yet ----------
  if (!mine) {
    if (stage !== 'commit') return null;
    let yocto: bigint | null = null;
    try { yocto = price ? parseNear(price) : null; } catch { yocto = null; }
    const rep = me?.creator?.rep_bps ?? 0;
    const inRange = yocto !== null && credible(yocto, budget, minBps);
    const refusal = walletRefusal(me?.wallet ?? null, BID_BOND, now);
    const short = refusal !== null && /no wallet|not enough/.test(refusal);
    const ready = inRange && pitch.trim().length > 0 && refusal === null && c.commit_ends_ms - now > 5000;
    const seal = (): void => {
      const o: SavedOpening = { ...sealBid(c.id, account, yocto!, pitch.trim(), randomSalt()), hub, savedAt: Date.now() };
      keepOpening(o); // saved before it's sent: a commit that lands while the page reloads can still be revealed
      void run(`Seal a bid on #${c.id}`, async () => {
        const r = await call(hub, 'commit_bid', { campaign_id: c.id, hash: o.hash });
        keepOpening({ ...o, committedTx: r.tx });
        return r;
      }).then((ok) => { if (ok) { setPrice(''); setPitch(''); } });
    };
    return (
      <div className="mybid">
        <h4>Your sealed bid</h4>
        <p className="small">Your price and pitch stay in this browser; only their hash goes onchain, with a 0.02 NEAR bond from your Signalfire wallet that comes back when you reveal. Credible prices for this brief: <Near y={floor} d={4} /> to <Near y={budget} d={4} />. The lowest price after your reputation discount ({rep >= 0 ? '+' : ''}{rep / 100}%) wins.</p>
        <label className="field"><span>Your price (NEAR)</span>
          <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} aria-invalid={!!price && !inRange} placeholder={fmtNear(budget / 2n, 3)} />
        </label>
        {price && !inRange && <p className="bad-text small">Outside the credible range: the hub would still take the bid, but it can’t win.</p>}
        {inRange && <p className="muted small">Scored as {fmtNear(score(yocto!, rep), 4)} NEAR after your reputation.</p>}
        <label className="field"><span>Your pitch (sealed with the price, published at the reveal; max 400 characters)</span>
          <textarea maxLength={400} value={pitch} onChange={(e) => setPitch(e.target.value)} placeholder="What you will make and where. No promises of returns." />
        </label>
        {refusal && <p className="bad-text small">Your wallet can’t post the bond: {refusal}.</p>}
        <div className="row">
          {short && <button className="ghost small" disabled={!!busy} onClick={() => void run('Fund wallet', () => call(hub, 'fund_wallet', { account }, BID_BOND))}>Fund wallet with 0.02 NEAR</button>}
          <button className="primary small" disabled={!ready || !!busy} onClick={seal}>Seal bid (0.02 NEAR bond)</button>
        </div>
        <p className="muted small">Bids close in {fmtLeft(c.commit_ends_ms - now)}. Keep this browser’s storage or download the opening after you seal: without it you can’t reveal, and an unrevealed bond goes to the treasury.</p>
      </div>
    );
  }

  // ---------- committed: reveal, then the result ----------
  const reveal = (o: SavedOpening): void => {
    void run(`Reveal your bid on #${c.id}`, async () => {
      const r = await call(hub, 'reveal_bid', { campaign_id: c.id, price: o.price, pitch_hash: o.pitchHash, salt: o.salt });
      keepOpening({ ...o, revealedTx: r.tx });
      await publish(o);
      return r;
    });
  };
  const publish = async (o: BidOpening): Promise<void> => {
    // the chain may need a moment to show the reveal to the server's RPC
    for (let k = 0; k < 5; k++) {
      try { await api('/opening', { campaign: o.campaign, creator: o.creator, price: o.price, pitch: o.pitch, salt: o.salt }); return; } catch { await new Promise((r) => setTimeout(r, 2000)); }
    }
  };
  const importFile = async (f: File): Promise<void> => {
    setImportErr(null);
    try {
      const data = JSON.parse(await f.text()) as SavedOpening | SavedOpening[];
      const list = (Array.isArray(data) ? data : [data]).filter((o) => o && openingMatches(o));
      const hit = list.find((o) => o.campaign === c.id && o.creator === account && o.hash === mine.hash);
      if (!hit) { setImportErr('That file has no opening that matches your sealed bid on this campaign.'); return; }
      keepOpening({ ...hit, hub, savedAt: hit.savedAt ?? Date.now() });
      setTick((t) => t + 1);
    } catch { setImportErr('Not an opening file.'); }
  };

  const settled = c.phase !== 'bidding';
  const won = c.winner === account;
  const steps = [
    { k: 'committed', on: true },
    { k: 'revealed', on: mine.revealed },
    { k: won ? 'won' : settled && c.winner ? 'lost' : settled ? 'no winner' : 'settled', on: settled },
  ];
  return (
    <div className="mybid">
      <h4>Your sealed bid</h4>
      <ol className="timeline small-steps" aria-label="Your bid">
        {steps.map((x, i) => <li key={x.k} className={x.on && (i === steps.length - 1 || !steps[i + 1].on) ? 'now' : x.on ? 'past' : ''}>{x.k}</li>)}
      </ol>
      <p className="small">Commitment onchain <code title={mine.hash}>{mine.hash.slice(0, 16)}…</code>{opening?.committedTx && <> · <Tx h={opening.committedTx} label="commit tx" /></>}{opening?.revealedTx && <> · <Tx h={opening.revealedTx} label="reveal tx" /></>}</p>
      {!mine.revealed && (
        opening ? (
          <>
            <p className="small">Sealed: <Near y={opening.price} /> with your pitch “{opening.pitch.slice(0, 120)}{opening.pitch.length > 120 ? '…' : ''}”</p>
            {stage === 'commit' && <p className="muted small">The reveal window opens in {fmtLeft(c.commit_ends_ms - now)} and lasts until {new Date(c.reveal_ends_ms).toLocaleTimeString()}. Come back then: one click reveals.</p>}
            {stage === 'reveal' && (
              <div className="row">
                <button className="primary small" disabled={!!busy} onClick={() => reveal(opening)}>Reveal my bid</button>
                <span className="muted small">closes in {fmtLeft(c.reveal_ends_ms - now)}</span>
              </div>
            )}
            {(stage === 'settle' || stage === 'closed') && <p className="bad-text small">Not revealed in time: the 0.02 NEAR bond went to {s.id.toUpperCase()}’s marketing treasury.</p>}
            <button className="ghost small" onClick={() => download(fileName(opening), opening)}>Download the opening</button>
          </>
        ) : (
          <>
            <p className="bad-text small">This browser doesn’t have the opening for this bid. Import the file you downloaded when you sealed it.</p>
            <input ref={fileRef} type="file" accept="application/json,.json" onChange={(e) => { const f = e.target.files?.[0]; if (f) void importFile(f); }} aria-label="Import the opening file" />
            {importErr && <p className="bad-text small">{importErr}</p>}
          </>
        )
      )}
      {mine.revealed && (
        <p className="small">Revealed at <Near y={mine.price!} />: <Chip kind={mine.credible ? 'ok' : 'bad'}>{mine.credible ? 'credible' : 'outside the credible range'}</Chip> reputation {mine.rep >= 0 ? '+' : ''}{mine.rep / 100}%.
          {!published && opening && <> <button className="link" onClick={() => void publish(opening).then(() => setTick((t) => t + 1))}>Publish the opening</button> so anyone can check it.</>}
        </p>
      )}
      {mine.revealed && stage === 'settle' && (
        <div className="row">
          <span className="muted small">The reveal window is over. Anyone may settle the auction (the operator does it within a minute).</span>
          <button className="ghost small" disabled={!!busy} onClick={() => void run(`Settle #${c.id}`, () => call(hub, 'settle_auction', { campaign_id: c.id }))}>Settle now</button>
        </div>
      )}
      {settled && (
        won ? (
          <p className="ok-text small">
            You won at <Near y={c.price} />. {c.phase === 'voting' || c.phase === 'proposing' ? 'The holders are voting on funding it in the DAO.' : c.phase === 'funded' ? `Funded: ${c.results}/${c.target} buyers so far, ${c.milestones_paid}/3 milestones paid (${fmtTusd(c.paid_tusd)} tUSD to you). Share your link: ${location.origin}/s/${s.id}?ref=c${c.id}` : c.phase === 'done' ? `Done: ${fmtTusd(c.paid_tusd)} tUSD paid to you, receipt NFT ${c.receipt ?? ''}.` : c.phase === 'expired' ? 'It expired before reaching the target; the unpaid part went back to the treasury.' : c.phase}
          </p>
        ) : (
          <p className="small">{c.winner ? <>Lost to <Acct a={c.winner} /> at <Near y={c.price} />.</> : 'No credible bid won.'} {mine.revealed ? 'Your bond is back in your wallet.' : ''}</p>
        )
      )}
    </div>
  );
}
