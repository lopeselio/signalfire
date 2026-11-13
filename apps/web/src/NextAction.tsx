import { live, nameOf, focusStartup, tourStore, useTour, type PathId } from './tour/state.ts';
import { startPath, useX } from './tour/useX.ts';
import type { X } from './tour/paths.tsx';
import { useApp } from './ui.tsx';

// One line per page saying what you can do here, and the one next step for the visitor's role, read from the same
// signals the guided tour ticks on (tour/state.ts). Nothing here replaces a flow: the button only takes you to the
// existing panel (and opens the right tab), and "What can I do here?" starts the matching tour path.

export type Page = 'home' | 'discover' | 'startup' | 'creators' | 'dashboard' | 'launch';

const LINE: Record<Page, (sym?: string) => string> = {
  home: () => 'See where trading fees go, then pick a startup to back, a campaign to work on, or launch your own.',
  discover: () => 'Compare startups by their marketing fund and evidence, then open one to buy, vote or send an offer.',
  startup: (sym) => `Here you can buy or sell ${sym ?? 'its token'}, join its holders’ council and vote, or send a sealed offer on its campaigns.`,
  creators: () => 'Apply to become a creator, see each creator’s record, and cash out tUSD you’ve earned.',
  dashboard: () => 'See where every startup’s trading fees went, and the evidence for why this runs on NEAR.',
  launch: () => 'Launch your own attention token: you post briefs and set spend limits, and holders decide what gets funded.',
};

const TOUR_FOR: Record<Page, PathId> = { home: 'explore', discover: 'explore', startup: 'back', creators: 'create', dashboard: 'explore', launch: 'found' };

/** Where a next step leads: a route, the startup tab to open, and the panel to scroll to. */
interface Action { label: string; path?: string; tab?: 'market' | 'treasury' | 'evidence'; sel?: string; signIn?: boolean; why?: string }

type Role = 'found' | 'create' | 'back';

/** The visitor's role: what they have done first, then the tour path they picked, else a backer. */
function roleOf(x: X): Role {
  if (x.sig.mine) return 'found';
  if (x.sig.applied || x.sig.admitted) return 'create';
  const picked = tourStore.get().path;
  if (picked === 'found' || picked === 'create' || picked === 'back') return picked;
  return 'back';
}

function founderAction(x: X): Action {
  const m = x.sig.mine;
  if (!m) return { label: 'Launch a startup', path: '/launch', sel: '[data-tour="launch"]' };
  const sym = m.id.toUpperCase();
  const vote = live(x.state, x.now).voting.find((c) => c.startup === m.id && !(x.account && c.proposal?.votes[x.account]));
  if (vote) return { label: `Vote on #${vote.id}`, path: `/s/${m.id}`, tab: 'treasury', sel: '[data-tour="campaigns"]', why: `Your holders’ council is voting on funding #${vote.id}.` };
  if (!x.sig.filled) return { label: 'Fill the marketing fund', path: `/s/${m.id}`, tab: 'market', sel: '[data-tour="trade"]', why: `${sym}’s marketing fund fills from trading fees: buy some ${sym} or share the page.` };
  const running = x.state.campaigns.some((c) => c.startup === m.id && ['bidding', 'proposing', 'voting', 'funded', 'propose_failed'].includes(c.phase));
  if (!running) return { label: 'Post a brief', path: `/s/${m.id}`, tab: 'treasury', sel: '[data-tour="founder-brief"]', why: `${sym} has no campaign running.` };
  return { label: `Open ${m.name}’s campaign`, path: `/s/${m.id}`, tab: 'treasury', sel: '[data-tour="campaigns"]', why: `${m.name} has a campaign under way.` };
}

function creatorAction(x: X, here?: string): Action {
  if (!x.sig.applied) return { label: 'Apply as a creator', path: '/creators', sel: '[data-tour="apply"]' };
  if (!x.sig.admitted) return { label: 'Check your application', path: '/creators', sel: '[data-tour="apply"]', why: 'The AI scout reviews new applicants within a minute.' };
  const l = live(x.state, x.now);
  const me = x.account;
  // a privately scored offer needs no opening, so this only says where to look: the panel shows the one button there is
  const toOpen = l.reveal.find((c) => c.bids.some((b) => b.creator === me && !b.revealed));
  if (toOpen) return { label: `Check your offer on #${toOpen.id}`, path: `/s/${toOpen.startup}`, tab: 'treasury', sel: '[data-tour="campaigns"]', why: `Offers on #${toOpen.id} are being opened now.` };
  const open = l.bidding.filter((c) => !c.bids.some((b) => b.creator === me)).sort((a, b) => (a.startup === here ? -1 : b.startup === here ? 1 : 0))[0];
  if (open) return { label: `Seal an offer on #${open.id}`, path: `/s/${open.startup}`, tab: 'treasury', sel: '[data-tour="campaigns"]', why: `${nameOf(x.state, open.startup)} is taking sealed offers now.` };
  return { label: 'Find a campaign', path: '/discover', why: 'No campaign is taking offers right now.' };
}

function backerAction(x: X, here?: string): Action {
  const l = live(x.state, x.now);
  const first = <T extends { startup: string }>(list: T[]): T | undefined => list.find((c) => c.startup === here) ?? list[0];
  const vote = first(l.voting.filter((c) => x.sig.holderOf.includes(c.startup) && !(x.account && c.proposal?.votes[x.account])));
  if (vote) return { label: `Vote on #${vote.id}`, path: `/s/${vote.startup}`, tab: 'treasury', sel: '[data-tour="campaigns"]', why: `${nameOf(x.state, vote.startup)}’s holders are voting on funding #${vote.id}.` };
  const join = [here, ...x.sig.holdsEnough].find((id) => id && x.sig.holdsEnough.includes(id) && !x.sig.holderOf.includes(id));
  if (join) return { label: 'Join the holders', path: `/s/${join}`, tab: 'treasury', sel: '[data-tour="holders"]', why: `You hold enough ${join.toUpperCase()} to vote on its campaigns.` };
  const target = here ?? (x.sig.holds[0] ?? focusStartup(x.state, x.now));
  return { label: here || x.sig.holds.length === 0 ? `Buy ${target.toUpperCase()} tokens` : 'Buy tokens', path: `/s/${target}`, tab: 'market', sel: '[data-tour="trade"]' };
}

/** Scrolls to a panel once it has rendered (a route change or a tab switch takes a moment). */
function scrollTo(sel: string): void {
  let k = 0;
  const t = setInterval(() => {
    const el = document.querySelector(sel);
    if (el || ++k > 20) { clearInterval(t); el?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  }, 150);
}

export function NextAction({ page, startup }: { page: Page; startup?: string }) {
  const { go, signIn } = useApp();
  const x = useX();
  useTour(); // re-render when the visitor picks a path
  if (!x) return null;
  const sym = startup?.toUpperCase();
  const role = roleOf(x);
  const a: Action = !x.account
    ? { label: page === 'creators' ? 'Sign in to apply' : page === 'launch' ? 'Sign in to launch' : page === 'startup' ? `Sign in to buy ${sym}` : 'Sign in to take part', signIn: true }
    // the page's own purpose first (Creators: apply or bid; Launch: launch), then the visitor's role
    : page === 'launch' && !x.sig.mine ? { label: 'Fill in the form below', sel: '[data-tour="launch"]' }
      : page === 'creators' ? creatorAction(x)
        : role === 'found' && !(page === 'startup' && startup !== x.sig.mine?.id) ? founderAction(x)
          : role === 'create' ? creatorAction(x, startup) : backerAction(x, startup);
  const act = (): void => {
    if (a.signIn) { void signIn(); return; }
    const here = location.pathname === a.path;
    if (a.path && !here) go(a.tab ? `${a.path}?tab=${a.tab}` : a.path);
    if (a.tab) window.dispatchEvent(new CustomEvent('signalfire:tab', { detail: a.tab }));
    if (a.sel) scrollTo(a.sel);
  };
  return (
    <div className="next-action" role="region" aria-label="What you can do here">
      <p className="na-line">{LINE[page](sym)}</p>
      <div className="na-row">
        <button className="primary small" onClick={act}>{a.label}</button>
        {a.why && <span className="muted small">{a.why}</span>}
        <button className="link small na-help" onClick={() => startPath(x.account && TOUR_FOR[page] === 'explore' ? role : TOUR_FOR[page], x)}>What can I do here?</button>
      </div>
    </div>
  );
}
