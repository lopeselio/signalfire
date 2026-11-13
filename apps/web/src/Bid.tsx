import { useRef, useState } from 'react';
import {
  BID_BOND, bidStage, credible, fmtNear, fmtTusd, openingMatches, parseNear, score, sealBid, walletRefusal, type BidOpening,
} from '@signalfire/core';
import { api, type Campaign, type Startup } from './api.ts';
import { refusalText } from './copy.ts';
import { Acct, Chip, Info, Near, Tx, fmtLeft, useApp, useNow } from './ui.tsx';
import { lib } from './Attest.tsx';
import { sealKey, useSealed } from './Sealed.tsx';
import { call } from './wallet.ts';

// A person's sealed bid, the same commit-reveal the creator agents use (packages/core seals it, the hub checks it):
// the browser draws the salt, hashes price + pitch + salt, keeps that opening in localStorage (and offers it as a
// file), and sends only the hash with commit_bid. In the reveal window one click sends the opening with reveal_bid;
// then the server publishes it so `pnpm verify` can check it. Both calls take no deposit, so they go gasless.

export interface SavedOpening extends BidOpening { hub: string; savedAt: number; committedTx?: string; revealedTx?: string; sealedFor?: 'outlayer' }

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
  const sealedInfo = useSealed(c);
  if (!account || !state) return null;
  // a brief scored by OutLayer: the bid is also encrypted to the scorer's key, and is never revealed
  const teeKey = sealKey(c, sealedInfo);
  const tee = !!sealedInfo?.book;
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
      void run(`Seal your offer on #${c.id}`, async () => {
        const r = teeKey
          ? await call(hub, 'commit_sealed_bid', { campaign_id: c.id, hash: o.hash, ciphertext: (await lib()).sealBid(teeKey, hub, c.id, account, { price: o.price, pitch_hash: o.pitchHash, salt: o.salt }) })
          : await call(hub, 'commit_bid', { campaign_id: c.id, hash: o.hash });
        keepOpening({ ...o, committedTx: r.tx, ...(teeKey ? { sealedFor: 'outlayer' as const } : {}) });
        return r;
      }, {
        pending: 'Sealing your offer…',
        done: teeKey ? 'Offer sealed for private scoring. Only the winning offer is ever opened.' : 'Offer sealed. Nobody can see your price until offers are opened.',
        action: teeKey ? 'commit_sealed_bid' : 'commit_bid',
      }).then((ok) => { if (ok) { setPrice(''); setPitch(''); } });
    };
    return (
      <div className="mybid" data-tour="my-bid">
        <h4>Your sealed offer</h4>
        {teeKey && <p className="small"><strong>Scored privately.</strong> Your browser encrypts your price so only Signalfire’s scoring program, running in secure hardware (OutLayer), can read it. You don’t need to open your offer: when offers close, the program picks the winner and opens only the winning offer. If you lose, nobody ever sees your price, including us. Your deposit comes back once scoring is done.<Info text="Sealed bid encrypted to a key only Signalfire's scorer can derive inside an OutLayer TEE (commit_sealed_bid)." /></p>}
        <p className="small">Your price and pitch stay in this browser. Only a sealed fingerprint{teeKey ? ' and an encrypted copy go' : ' goes'} on NEAR, with a 0.02 NEAR deposit from your Signalfire balance{teeKey ? '' : ', returned when you open your offer'}. Offers for this brief must be between <Near y={floor} d={4} /> and <Near y={budget} d={4} />. The lowest price wins, after your track-record bonus ({rep >= 0 ? '+' : ''}{rep / 100}%).</p>
        <label className="field"><span>Your price (NEAR)</span>
          <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} aria-invalid={!!price && !inRange} placeholder={fmtNear(budget / 2n, 3)} />
        </label>
        {price && !inRange && <p className="bad-text small">Out of range: you can still send it, but it can’t win.</p>}
        {inRange && <p className="muted small">Counts as {fmtNear(score(yocto!, rep), 4)} NEAR after your track-record bonus.</p>}
        <label className="field"><span>Your pitch (sealed with your price and shown when offers are opened; up to 400 characters)</span>
          <textarea maxLength={400} value={pitch} onChange={(e) => setPitch(e.target.value)} placeholder="What you’ll make and where. No promises about price or profit." />
        </label>
        {refusal && <p className="bad-text small">Your Signalfire balance can’t cover the deposit: <span title={refusal}>{refusalText(refusal)}</span>.</p>}
        <div className="row">
          {short && <button className="ghost small" disabled={!!busy} onClick={() => void run('Add NEAR to your Signalfire balance', () => call(hub, 'fund_wallet', { account }, BID_BOND), { pending: 'Adding NEAR to your Signalfire balance…', done: 'Your Signalfire balance is topped up.', action: 'fund_wallet' })}>Add 0.02 NEAR to my Signalfire balance</button>}
          <button className="primary small" disabled={!ready || !!busy} onClick={seal}>Seal my offer (0.02 NEAR deposit)</button>
        </div>
        <p className="muted small">Offers close in {fmtLeft(c.commit_ends_ms - now)}. {teeKey ? 'Privately scored offers don’t need opening: nothing more to do.' : 'After you seal, download your offer file as a backup. Without it you can’t open your offer, and an unopened offer’s deposit goes to the marketing fund.'}</p>
      </div>
    );
  }

  // ---------- committed: reveal, then the result ----------
  const reveal = (o: SavedOpening): void => {
    void run(`Open your offer on #${c.id}`, async () => {
      const r = await call(hub, 'reveal_bid', { campaign_id: c.id, price: o.price, pitch_hash: o.pitchHash, salt: o.salt });
      keepOpening({ ...o, revealedTx: r.tx });
      await publish(o);
      return r;
    }, { pending: 'Opening your offer…', done: 'Your offer is open, and your deposit is back in your Signalfire balance.', action: 'reveal_bid' });
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
      if (!hit) { setImportErr('That file doesn’t match your sealed offer on this campaign.'); return; }
      keepOpening({ ...hit, hub, savedAt: hit.savedAt ?? Date.now() });
      setTick((t) => t + 1);
    } catch { setImportErr('That isn’t a Signalfire offer file.'); }
  };

  const settled = c.phase !== 'bidding';
  const won = c.winner === account;
  const steps = [
    { k: 'sealed', on: true },
    { k: tee ? 'scored privately' : 'opened', on: tee ? settled : mine.revealed },
    { k: won ? 'won' : settled && c.winner ? 'lost' : settled ? 'no winner' : 'winner picked', on: settled },
  ];
  return (
    <div className="mybid" data-tour="my-bid">
      <h4>Your sealed offer</h4>
      <ol className="timeline small-steps" aria-label="Your offer">
        {steps.map((x, i) => <li key={x.k} className={x.on && (i === steps.length - 1 || !steps[i + 1].on) ? 'now' : x.on ? 'past' : ''}>{x.k}</li>)}
      </ol>
      <p className="small">Sealed on NEAR.</p>
      <details className="tech">
        <summary>Proof</summary>
        <p className="muted small">Fingerprint (commitment) <code>{mine.hash}</code>{opening?.committedTx && <> · <Tx h={opening.committedTx} label="sealing transaction" /></>}{opening?.revealedTx && <> · <Tx h={opening.revealedTx} label="opening transaction" /></>}</p>
      </details>
      {!mine.revealed && tee && (
        <p className="small">
          {!settled ? 'Encrypted for private scoring. Nothing more to do: when offers close, every sealed offer is scored and only the winner’s is opened.' : 'Your offer was never opened. Your price exists only in encrypted form, and nobody (including us) has seen it.'}
          {opening && <> You sealed <Near y={opening.price} />.</>}
        </p>
      )}
      {!mine.revealed && !tee && (
        opening ? (
          <>
            <p className="small">Sealed: <Near y={opening.price} /> with your pitch “{opening.pitch.slice(0, 120)}{opening.pitch.length > 120 ? '…' : ''}”</p>
            {stage === 'commit' && <p className="muted small">Offers open in {fmtLeft(c.commit_ends_ms - now)}, and you’ll have until {new Date(c.reveal_ends_ms).toLocaleTimeString()} to open yours. Come back then: it’s one click.</p>}
            {stage === 'reveal' && (
              <div className="row">
                <button className="primary small" disabled={!!busy} onClick={() => reveal(opening)}>Open my offer</button>
                <span className="muted small">{fmtLeft(c.reveal_ends_ms - now)} left to open it</span>
              </div>
            )}
            {(stage === 'settle' || stage === 'closed') && <p className="bad-text small">Not opened in time: the 0.02 NEAR deposit went to {s.id.toUpperCase()}’s marketing fund.</p>}
            <button className="ghost small" onClick={() => download(fileName(opening), opening)}>Download my offer file</button>
          </>
        ) : (
          <>
            <p className="bad-text small">This browser doesn’t have the file that opens this offer. Choose the offer file you downloaded when you sealed it.</p>
            <input ref={fileRef} type="file" accept="application/json,.json" onChange={(e) => { const f = e.target.files?.[0]; if (f) void importFile(f); }} aria-label="Choose your offer file" />
            {importErr && <p className="bad-text small">{importErr}</p>}
          </>
        )
      )}
      {mine.revealed && (
        <p className="small">{tee ? 'Opened by private scoring as the winning offer' : 'Opened'} at <Near y={mine.price!} />: <Chip kind={mine.credible ? 'ok' : 'bad'}>{mine.credible ? 'in range' : 'out of range'}</Chip> · track record {mine.rep >= 0 ? '+' : ''}{mine.rep / 100}%.
          {!published && opening && <> <button className="link" onClick={() => void publish(opening).then(() => setTick((t) => t + 1))}>Publish your offer</button> so anyone can check it.</>}
        </p>
      )}
      {mine.revealed && !tee && stage === 'settle' && (
        <div className="row">
          <span className="muted small">Offers are open. The winner is picked automatically within a minute, or you can do it now.</span>
          <button className="ghost small" disabled={!!busy} onClick={() => void run(`Pick the winner of #${c.id}`, () => call(hub, 'settle_auction', { campaign_id: c.id }), { pending: 'Picking the winning offer…', done: 'Winner picked. Holders are voting on it now.', action: 'settle_auction' })}>Pick the winner now</button>
        </div>
      )}
      {settled && (
        won ? (
          <p className="ok-text small">
            You won at <Near y={c.price} />. {c.phase === 'voting' || c.phase === 'proposing' ? 'Holders are voting on funding it…' : c.phase === 'funded' ? `Funded. Your creator link is live: ${c.results}/${c.target} new buyers so far, ${c.milestones_paid} of 3 payouts made (${fmtTusd(c.paid_tusd)} tUSD to you). Share your link: ${location.origin}/s/${s.id}?ref=c${c.id}` : c.phase === 'done' ? `Done: ${fmtTusd(c.paid_tusd)} tUSD paid to you, plus a completion certificate (NFT${c.receipt ? ` ${c.receipt}` : ''}).` : c.phase === 'expired' ? 'The deadline passed before enough new buyers arrived; the unpaid budget went back to the marketing fund.' : c.phase}
          </p>
        ) : (
          <p className="small">{c.winner ? <><Acct a={c.winner} /> won at <Near y={c.price} />.</> : 'No offer in range, so nobody won.'} {mine.revealed || tee ? 'Your deposit is back in your Signalfire balance.' : ''}
            {(() => {
              // why a higher price can win: offers are compared after each creator's track-record bonus
              const w = c.bids.find((b) => b.creator === c.winner);
              if (!c.winner || !w || !w.rep) return null;
              const myPrice = mine.revealed ? mine.price : opening?.price;
              const myRep = mine.revealed ? mine.rep : 0;
              return <> Offers are compared after each creator’s track-record bonus: the winner’s +{w.rep / 100}% makes its price count as <Near y={score(BigInt(c.price), w.rep)} d={4} />{myPrice ? <>, and yours counted as <Near y={score(BigInt(myPrice), myRep)} d={4} /></> : null}. Deliver campaigns to earn your own bonus.</>;
            })()}
          </p>
        )
      )}
    </div>
  );
}
