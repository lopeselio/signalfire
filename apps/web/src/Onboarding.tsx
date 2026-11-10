import { useState } from 'react';

// First-visit cards explaining the loop. Remembered in localStorage (which may be unavailable).

const KEY = 'signalfire.onboarded';
export function seenOnboarding(): boolean {
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}
function markSeen(): void {
  try { localStorage.setItem(KEY, '1'); } catch { /* private window */ }
}

const CARDS = [
  { title: 'A startup launches an attention token', body: 'Anyone can buy or sell it on a bonding curve: the price rises as more is bought. All 1,000,000 tokens sit on the curve; the founders get none. It is not equity and not a claim on revenue.' },
  { title: 'Every trade feeds a marketing treasury', body: '2% of each trade lands in the startup’s marketing treasury, a ledger in the hub contract. There is no method that sends it to the founders. It can only pay creators for campaigns.' },
  { title: 'Creators bid, holders choose', body: 'Vetted creators (people and AI agents) seal bids on a campaign brief, then reveal them. The contract picks the lowest reputation-weighted price. Token holders approve or reject it in the startup’s Sputnik DAO.' },
  { title: 'Paid only for results', body: 'The creator gets a referral link. As first-time buyers come through it, three milestones pay out in tUSD, each checked by the spend policy and written to the audit log. The last one mints a receipt NFT.' },
];

export function Onboarding({ onClose }: { onClose: () => void }) {
  const [i, setI] = useState(0);
  const close = (): void => { markSeen(); onClose(); };
  const c = CARDS[i];
  return (
    <div className="modal-bg" role="dialog" aria-modal="true" aria-labelledby="ob-title" onClick={close}>
      <div className="modal onboard" onClick={(e) => e.stopPropagation()}>
        <div className="ob-steps" aria-hidden="true">{CARDS.map((_, k) => <span key={k} className={k <= i ? 'on' : ''} />)}</div>
        <p className="ob-n">Step {i + 1} of {CARDS.length}</p>
        <h2 id="ob-title">{c.title}</h2>
        <p>{c.body}</p>
        <div className="row end">
          <button className="ghost" onClick={close}>Skip</button>
          {i > 0 && <button className="ghost" onClick={() => setI(i - 1)}>Back</button>}
          {i < CARDS.length - 1 ? <button className="primary" onClick={() => setI(i + 1)}>Next</button> : <button className="primary" onClick={close}>Start exploring</button>}
        </div>
      </div>
    </div>
  );
}
