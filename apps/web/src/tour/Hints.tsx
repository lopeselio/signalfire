import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useApp } from '../ui.tsx';
import type { X } from './paths.tsx';
import { live, nameOf, tourStore, useTour, whenNext } from './state.ts';

// First-time "what's this?" hints, pinned to the real UI by data-tour hooks (no page edits), dismissible for good;
// and notes that teach in empty and waiting states, slotted into the page next to the panel they explain.

interface Hint { id: string; sel: string; title: string; body: ReactNode; more: string }

const HINTS: Hint[] = [
  {
    id: 'curve', sel: '[data-tour="price"]', title: 'The bonding curve', more: 'curve',
    body: <>The price per token is 0.0001 NEAR plus 0.01 NEAR × the share of the supply in circulation: it rises as people buy and falls as they sell. The curve’s reserve always equals the area under that line, so every token can be sold back. 2% of each trade goes to the marketing treasury.</>,
  },
  {
    id: 'policy', sel: '[data-tour="constraints"]', title: 'The spend policy', more: 'policy',
    body: <>Money leaves the treasury one way only: a milestone payout to the winning creator of a campaign the holders funded. The contract checks the payee, the campaign’s price, these caps and the hourly limit; a payout over a cap is <em>held</em>, and every attempt is written to the audit log. The founder can change these numbers within hard limits, never move the money.</>,
  },
  {
    id: 'sealed', sel: '[data-tour="bid-book"]', title: 'Sealed bids', more: 'auction',
    body: <>Creators first post only a hash of their price, pitch and a secret salt, with a 0.02 NEAR bond. Nobody can see or copy a price until the reveal, when each creator opens their bid and the contract checks it against the hash. The lowest price after a reputation discount wins; a bid that isn’t revealed loses its bond to the treasury.</>,
  },
  {
    id: 'dao', sel: '[data-tour="dao-vote"]', title: 'The holders’ vote', more: 'dao',
    body: <>Settling the auction files a proposal in the startup’s Sputnik DAO: “call <code>fund_campaign</code> on the hub”. Holders vote, one holder one vote; at a majority the DAO calls the hub, which reserves the winning price. Nobody in the DAO may propose or approve a transfer.</>,
  },
  {
    id: 'milestones', sel: '[data-tour="milestones"]', title: 'Milestones', more: 'milestones',
    body: <>A result is a first buy of at least 0.05 NEAR through the campaign’s referral link by someone new to the token. Each third of the target unlocks a milestone paying a third of the price, in tUSD (a labelled test stablecoin). The last one mints a receipt NFT to the creator.</>,
  },
  {
    id: 'privateai', sel: '[data-tour="vetting"]', title: 'The Private AI badge', more: 'privateai',
    body: <>The scout’s report and the AI creators’ pitches come from a model running in a TEE on NEAR AI Cloud, signed inside the enclave. Your browser picks a fresh nonce, fetches the model’s attestation, checks the Intel TDX quote, the GPUs’ NVIDIA verdict and the reply’s signature itself. Click the badge for every check. It proves where the text came from, not that it is wise, and the model decides nothing.</>,
  },
];

function useAnchor(sel: string): DOMRect | null {
  const [r, setR] = useState<DOMRect | null>(null);
  useEffect(() => {
    const tick = (): void => {
      const el = document.querySelector(sel);
      const b = el?.getBoundingClientRect();
      setR((old) => (b && b.width > 0 ? (old && old.top === b.top && old.left === b.left && old.width === b.width ? old : b) : null));
    };
    tick();
    const id = setInterval(tick, 300);
    window.addEventListener('scroll', tick, { passive: true });
    window.addEventListener('resize', tick);
    return () => { clearInterval(id); window.removeEventListener('scroll', tick); window.removeEventListener('resize', tick); };
  }, [sel]);
  return r;
}

function HintChip({ h }: { h: Hint }) {
  const { go } = useApp();
  const r = useAnchor(h.sel);
  const [open, setOpen] = useState(false);
  const pop = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent): void => { if (pop.current && !pop.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false); };
    setTimeout(() => window.addEventListener('mousedown', away), 0);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('mousedown', away); window.removeEventListener('keydown', esc); };
  }, [open]);
  if (!r) return null;
  const vw = document.documentElement.clientWidth;
  const top = r.top + window.scrollY;
  const right = Math.max(8, vw - (r.right + window.scrollX));
  const popW = Math.min(320, vw - 24);
  const popLeft = Math.min(Math.max(12, r.right + window.scrollX - popW), vw - popW - 12);
  return createPortal(
    <>
      <button className="hint-chip" style={{ top: top + 4, right: right + 4 }} onClick={() => setOpen(!open)} aria-expanded={open} aria-label={`What’s this? ${h.title}`}>
        <span aria-hidden="true">?</span> What’s this?
      </button>
      {open && (
        <div ref={pop} className="hint-pop" role="dialog" aria-label={h.title} style={{ top: top + 34, left: popLeft, width: popW }}>
          <strong>{h.title}</strong>
          <p>{h.body}</p>
          <div className="tour-actions">
            <button className="link small" onClick={() => { setOpen(false); go(`/how#${h.more}`); }}>More in How it works</button>
            <span className="tour-grow" />
            <button className="primary small" onClick={() => { setOpen(false); tourStore.dismissHint(h.id); }}>Got it</button>
          </div>
        </div>
      )}
    </>,
    document.body,
  );
}

export function Hints() {
  const t = useTour();
  if (t.tour) return null; // the tour card already explains whatever it points at
  return <>{HINTS.filter((h) => !t.hints.includes(h.id)).map((h) => <HintChip key={h.id} h={h} />)}</>;
}

// ---------- notes in empty and waiting states ----------

/** Renders children into a host slotted after `sel`'s heading (or before `sel` itself), while `sel` is on the page. */
function Slot({ sel, place, children }: { sel: string; place: 'after-heading' | 'before'; children: ReactNode }) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    let h: HTMLElement | null = null;
    const tick = (): void => {
      const el = document.querySelector(sel);
      if (h && el && h.isConnected && (place === 'before' ? h.nextElementSibling === el : h.parentElement === el)) return;
      h?.remove();
      h = null;
      if (el) {
        h = document.createElement('div');
        h.className = 'tour-note-host';
        if (place === 'before') el.before(h);
        else (el.querySelector(':scope > h2') ?? el.firstElementChild)?.after(h);
      }
      setHost(h);
    };
    tick();
    const id = setInterval(tick, 500);
    return () => { clearInterval(id); h?.remove(); };
  }, [sel, place]);
  return host ? createPortal(children, host) : null;
}

export function Notes({ x }: { x: X }) {
  const { go } = useApp();
  const m = /^\/s\/([a-z0-9]{2,8})\/?$/.exec(location.pathname);
  const how = <a href="/how#auction" onClick={(e) => { e.preventDefault(); go('/how#auction'); }}>How a campaign works</a>;
  const l = live(x.state, x.now);
  if (m) {
    const id = m[1];
    const st = x.state.startups.find((s) => s.id === id);
    if (!st) return null;
    const active = x.state.campaigns.some((c) => c.startup === id && ['bidding', 'proposing', 'voting', 'funded', 'propose_failed'].includes(c.phase));
    if (active) return null;
    const isMine = st.founder === x.account;
    const ops = st.founder === x.state.operator;
    const elsewhere = l.bidding[0] ?? l.reveal[0] ?? l.voting[0];
    return (
      <Slot sel='[data-tour="campaigns"]' place="after-heading">
        <div className="tour-note" role="note">
          <strong>No campaign is open on {st.name} right now.</strong>{' '}
          {isMine ? 'Post a brief from your Founder’s desk above whenever the treasury has free NEAR.' : ops ? whenNext(x.state, x.now) : 'Its founder posts briefs when the treasury has enough in it.'}
          {elsewhere && elsewhere.startup !== id && <> Meanwhile campaign #{elsewhere.id} on <a href={`/s/${elsewhere.startup}?tab=treasury`} onClick={(e) => { e.preventDefault(); go(`/s/${elsewhere.startup}?tab=treasury`); }}>{nameOf(x.state, elsewhere.startup)}</a> is open.</>}
          <span className="tour-note-sub">When a brief opens: about 90 s of sealed bids, 60 s to reveal, then the holders vote in the DAO, and milestones pay the creator as new buyers arrive. {how}.</span>
        </div>
      </Slot>
    );
  }
  if (location.pathname.startsWith('/discover')) {
    const c = l.bidding[0] ?? l.reveal[0] ?? l.voting[0] ?? l.funded[0];
    const what = c && (l.bidding.includes(c) ? 'is taking sealed bids' : l.reveal.includes(c) ? 'is in its reveal window' : l.voting.includes(c) ? 'is waiting for its holders’ vote' : 'is running: its referral link pays per new buyer');
    return (
      <Slot sel='[data-tour="startups"]' place="before">
        <div className="tour-note" role="note">
          {c ? <><strong>Right now:</strong> campaign #{c.id} on <a href={`/s/${c.startup}?tab=treasury`} onClick={(e) => { e.preventDefault(); go(`/s/${c.startup}?tab=treasury`); }}>{nameOf(x.state, c.startup)}</a> {what}.</>
            : <><strong>No campaign is open right now.</strong> {whenNext(x.state, x.now)}</>}
          <span className="tour-note-sub">Each startup runs one campaign at a time: sealed bids, a reveal, the holders’ vote, then milestone payouts. {how}.</span>
        </div>
      </Slot>
    );
  }
  return null;
}
