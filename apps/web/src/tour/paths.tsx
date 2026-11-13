import type { ReactNode } from 'react';
import { fmtNear, fmtTokens, parseNear, quoteBuy } from '@signalfire/core';
import type { Me, State } from '../api.ts';
import { fmtLeft } from '../ui.tsx';
import { focusStartup, live, nameOf, whenNext, type PathId, type Signals } from './state.ts';

// The four paths and their steps. A step spotlights a real element (a CSS selector, usually a data-tour hook) and
// either ticks itself from real state (`done`) or, for read-only steps, waits for Next. `wait` explains why a step
// can't be done yet (nothing open, the scout still vetting); `after` says what to look for once it is done.
// Copy rule: attention tokens are not equity; never say raise, invest, ownership or returns.

export interface X { state: State; me: Me | null; account: string | null; sig: Signals; now: number }

export interface Step {
  id: string;
  title: string;
  body: (x: X) => ReactNode;
  /** what doing the step costs, said plainly */
  cost: string;
  /** where the step happens; the tour goes there when the step starts */
  route?: (x: X) => string;
  /** the element to spotlight */
  target?: string;
  /** shown instead when the target isn't on the page yet (a card or tab to open first); the first one found wins */
  via?: Via[];
  /** ticks the step from real state; without it the step is read-only and Next ticks it */
  done?: (x: X) => boolean;
  /** why the step can't be done right now, and what happens next */
  wait?: (x: X) => ReactNode | null;
  /** what to look for once it is done */
  after?: (x: X) => ReactNode;
  /** a feature this step needs (a selector seen on its page once it ships); without it the step is skipped */
  requires?: string;
}

export interface Via { sel: string; text: string }
/** The first fallback on the page, if any. */
export const firstVia = (vias: Via[] | undefined, find: (sel: string) => Element | null): { via: Via; el: Element } | null => {
  for (const v of vias ?? []) { const el = find(v.sel); if (el) return { via: v, el }; }
  return null;
};

export interface Path { id: PathId; title: string; who: string; blurb: string; wallet: boolean; steps: Step[] }

const FREE = 'Free: nothing to sign.';
const GASLESS = 'Free: Signalfire covers the network fee. (If your wallet can’t do that, it asks you to pay a tiny fee of a few thousandths of a test NEAR.)';
const VIA_TREASURY = [{ sel: '[data-tour="tab-treasury"]', text: 'First open the Marketing fund and campaigns tab.' }];
const VIA_MARKET = [{ sel: '[data-tour="tab-market"]', text: 'First open the Market tab.' }];
const EVIDENCE_TAB = '[data-tour="evidence-tab"]';
const EVIDENCE = [{ sel: EVIDENCE_TAB, text: 'Open the Evidence tab.' }];
/** inside a campaign card: open the card first, else the tab */
const VIA_CARD = [{ sel: '[data-tour="campaigns"]', text: 'Open the campaign’s card: click Details on the one taking offers or opening them.' }, ...VIA_TREASURY];
/** The way not to wait for the demo's next brief: run your own (founders may bid on and vote on their own campaigns). */
const OWN = <> Don’t want to wait? Take the <strong>Founder</strong> path: launch your own startup and post a brief. The AI creators send offers within seconds, you can seal an offer on it yourself, and you vote as its first holder.</>;

const sym = (id: string): string => id.toUpperCase();
const minHold = (x: X, id: string): string => fmtTokens(x.state.startups.find((s) => s.id === id)?.constraints.min_holder_tokens ?? '0', 0);
/** About how many tokens 0.1 NEAR buys on a startup's curve right now. */
const tenth = (x: X, id: string): string => {
  const s = x.state.startups.find((y) => y.id === id);
  if (!s) return '';
  try { return fmtTokens(quoteBuy(BigInt(s.circulating), parseNear('0.1'), true).tokens, 0); } catch { return ''; }
};

const signIn: Step = {
  id: 'sign-in',
  title: 'Sign in with a NEAR test wallet',
  body: () => <>Click <strong>Sign in</strong> and pick a wallet (Meteor, HOT, Intear, MyNearWallet…). It signs a short “Sign in to this site” note (no payment). Use a <strong>test-network</strong> account: nothing here touches real money.</>,
  cost: 'Free: your wallet signs a note, not a payment.',
  target: '[data-tour="sign-in"]',
  done: (x) => x.sig.signedIn,
  after: (x) => <>You’re signed in as {x.account} (top right). Every action from here goes through your wallet.</>,
};

// ---------- Explore: read-only, no wallet ----------

const explore: Path = {
  id: 'explore', title: 'Explore', who: 'I’m just looking', wallet: false,
  blurb: 'A guided look at a live startup, its marketing fund, a campaign, the creators and the evidence. No wallet needed.',
  steps: [
    {
      id: 'x-fire', title: 'The signal fire', route: () => '/', target: '[data-tour="fire"]', cost: FREE,
      body: () => <>It burns higher the more happens on NEAR: its height follows the AI agents’ and people’s actions in the last 24 hours, a buy through a creator’s link throws sparks, and a milestone payout flares it. Everything below it is read live from NEAR’s test network.</>,
    },
    {
      id: 'x-beacon', title: 'Where every trading fee goes', route: () => '/', target: '[data-tour="beacon"]', cost: FREE,
      body: () => <>2% of every trade of every attention token goes into that startup’s <strong>marketing fund</strong>, held by Signalfire’s contract. This card adds them up: available for campaigns, set aside for approved ones, paid to creators, and <strong>paid to founders: 0</strong>. The contract has no way to pay founders.</>,
    },
    {
      id: 'x-wire', title: 'Live activity: what agents and people do', route: () => '/', target: '[data-tour="wire"]', cost: FREE,
      body: () => <>AI agents post briefs, seal offers, vote and buy here, live. Every line’s <strong>view</strong> link opens the public record on NEAR, so nothing here is a mock-up.</>,
    },
    {
      id: 'x-discover', title: 'Pick a startup', route: () => '/discover', target: '[data-tour="startups"]', cost: FREE,
      body: () => <>Each card is a startup with its own attention token and holders’ council. The big number is its marketing fund right now: budget only creators can earn, by bringing in new buyers. The demo startups and founders are fictional.</>,
    },
    {
      id: 'x-curve', title: 'The price curve', route: (x) => `/s/${focusStartup(x.state, x.now)}`, target: '[data-tour="price"]', via: VIA_MARKET, cost: FREE,
      body: () => <>The price rises in a straight line as tokens are bought and falls as they’re sold back. The buy-back pool always covers selling every token back. Buys tagged <strong>via campaign #N</strong> came through a creator’s link and count as new buyers.</>,
    },
    {
      id: 'x-supply', title: 'Fixed supply, nothing for the founder', target: '[data-tour="supply"]', via: VIA_MARKET, cost: FREE,
      body: () => <>1,000,000 tokens, created once and put on sale. <strong>Tokens for the founder: 0.</strong> The token is attention, not equity and not a claim on revenue: holding it buys a vote on how the marketing budget is spent, nothing more.</>,
    },
    {
      id: 'x-evidence', title: 'Check the evidence', target: '[data-tour="evidence-panel"]', via: EVIDENCE, requires: EVIDENCE_TAB, cost: FREE,
      body: () => <>Who the founder is and what they have shipped: linked accounts (verified or only claimed), their history, public code, the track record on Signalfire, and an AI research brief whose Private AI badge your browser checks.</>,
    },
    {
      id: 'x-ledger', title: 'The marketing fund', target: '[data-tour="ledger"]', via: VIA_TREASURY, cost: FREE,
      body: () => <>Available, set aside for approved campaigns, paid to creators, fees and kept deposits collected. The only way out is a milestone payout to a creator the holders approved, within the <strong>spend limits</strong> (caps, only the winning creator, an hourly limit).</>,
    },
    {
      id: 'x-campaigns', title: 'A campaign, phase by phase', target: '[data-tour="campaigns"]', via: VIA_TREASURY, cost: FREE,
      body: () => <>Open a campaign’s <strong>Details</strong>: the timeline (sealed offers → offers opened → holders vote → creator at work → paid), the offers with each creator’s price and pitch, the funding vote with every holder’s vote, the milestone payouts, and <strong>Proof (JSON)</strong> anyone can check.</>,
    },
    {
      id: 'x-audit', title: 'The audit log', target: '[data-tour="audit"]', via: VIA_TREASURY, cost: FREE,
      body: () => <>Every payment attempt and every spend-limit decision, on NEAR’s public record: paid, held, flags like rapid payments and first payment to a creator, and a copycat name turned away. Switch to <strong>Raw view</strong> for the exact codes (<code>paid</code>, <code>burst</code>, <code>new_payee</code>, <code>rejected + lookalike</code>).</>,
    },
    {
      id: 'x-creators', title: 'Creators: people and AI agents', route: () => '/creators', target: '[data-tour="creators"]', cost: FREE,
      body: () => <>Each approved creator holds a creator badge (an NFT that can’t be transferred) whose record updates as they work. Click <strong>Record and review</strong>: the AI scout’s report carries a <strong>Private AI</strong> badge, and your browser checks the AI’s secure hardware itself (a few seconds).</>,
    },
    {
      id: 'x-thesis', title: 'The thesis, with its evidence', route: () => '/dashboard', target: '[data-tour="thesis"]', cost: FREE,
      body: () => <>Why agent-run marketing treasuries belong on NEAR, with the evidence computed from NEAR’s public data: the fee per agent action, where the trading fees went, cost per new buyer, key and spend limits, and what the claim doesn’t cover.</>,
    },
    {
      id: 'x-next', title: 'That’s the whole loop', cost: FREE,
      body: () => <>Token → fees → marketing fund → sealed offers → holders’ vote → milestone payouts → completion certificate. To take part, open <strong>Get started</strong> (bottom left) and pick <em>Back a startup</em>, <em>Creator</em> or <em>Founder</em>. You need a NEAR test wallet with a little test NEAR (free from a faucet).</>,
    },
  ],
};

// ---------- Back a startup: buy, join the holders, vote ----------

const back: Path = {
  id: 'back', title: 'Back a startup', who: 'I want to buy and vote', wallet: true,
  blurb: 'Buy a startup’s attention token, join its holders’ council and vote on which campaign its marketing fund pays for.',
  steps: [
    signIn,
    {
      id: 'b-evidence', title: 'Check the evidence first', route: (x) => `/s/${focusStartup(x.state, x.now)}`, target: '[data-tour="evidence-panel"]', via: EVIDENCE, requires: EVIDENCE_TAB, cost: FREE,
      body: () => <>Before you buy: who is the founder, which links are verified, what have they shipped? Read the research brief and its Private AI badge.</>,
    },
    {
      id: 'b-buy', title: 'Buy some attention tokens', route: (x) => `/s/${focusStartup(x.state, x.now)}`, target: '[data-tour="trade"]', via: VIA_MARKET,
      cost: 'The test NEAR you type (2% of it goes to the marketing fund), plus 0.00125 NEAR one-time token account setup on your first buy. The network fee is free when your wallet supports it; the NEAR you spend always comes from your own account.',
      body: (x) => {
        const id = focusStartup(x.state, x.now);
        return <>Type an amount in <strong>Buy</strong> and click <strong>Buy {sym(id)}</strong>. 0.1 NEAR buys about {tenth(x, id)} {sym(id)}; you need at least {minHold(x, id)} {sym(id)} to join the holders. The quote is the contract’s own math, and your price protection is sent with the buy.</>;
      },
      done: (x) => x.sig.holds.length > 0,
      after: () => <>A toast with <strong>View on NEAR</strong>, your buy at the top of the trades table, and your balance next to your account (about 15 s).</>,
    },
    {
      id: 'b-join', title: 'Join the holders’ council', target: '[data-tour="holders"]', via: VIA_TREASURY, cost: GASLESS,
      route: (x) => `/s/${x.sig.holdsEnough.find((h) => !x.sig.holderOf.includes(h)) ?? x.sig.holds[0] ?? focusStartup(x.state, x.now)}`,
      body: () => <>Holders vote together as the startup’s holders’ council: one holder, one vote, so a big holder can’t buy the outcome. Click <strong>Join the holders</strong>: Signalfire’s contract checks your balance and adds you to the council.</>,
      done: (x) => x.sig.holderOf.length > 0,
      wait: (x) => (x.sig.holds.length > 0 && x.sig.holdsEnough.length === 0 ? <>You hold some tokens, but less than the minimum to join. Buy a little more on the Market tab.</> : null),
      after: () => <>You appear in the council list with a <strong>you</strong> chip. Anyone may remove holders who sell below the minimum.</>,
    },
    {
      id: 'b-vote', title: 'Vote on funding a campaign', target: '[data-tour="campaigns"]', via: VIA_TREASURY, cost: GASLESS,
      route: (x) => {
        const v = live(x.state, x.now).voting.find((c) => x.sig.holderOf.includes(c.startup));
        return `/s/${v?.startup ?? x.sig.holderOf[0] ?? focusStartup(x.state, x.now)}`;
      },
      body: () => <>When the winning offer is picked, a funding vote opens for the holders. Open the campaign that reads <strong>Holders vote</strong> and click <strong>Vote yes</strong> or <strong>Vote no</strong>. A majority of holders decides, and the vote itself can’t move money.</>,
      done: (x) => x.sig.voted,
      wait: (x) => {
        const l = live(x.state, x.now);
        const mine = l.voting.find((c) => x.sig.holderOf.includes(c.startup));
        if (mine) return null;
        const soon = [...l.bidding, ...l.reveal].find((c) => x.sig.holderOf.includes(c.startup));
        if (soon) return <>Campaign #{soon.id} on {nameOf(x.state, soon.startup)} is taking offers; its vote opens once the offers are opened, in about {fmtLeft(soon.reveal_ends_ms - x.now + 10_000)}. Keep this page open.</>;
        return <>No vote is open on a startup you hold right now. A vote opens about 3 minutes after a brief is posted (90 s for sealed offers, 60 s to open them, then the winner is picked). {whenNext(x.state, x.now)} The demo’s AI holders vote within seconds, so if they reach a majority first the vote closes. That’s the council working, and you vote on the next one.{OWN}</>;
      },
      after: () => <>Your vote shows next to your account under the funding vote. When a majority approves, the winning price is set aside and the campaign starts: your creator is on it.</>,
    },
    {
      id: 'b-ref', title: 'New buyers and payouts', target: '[data-tour="campaigns"]', via: VIA_TREASURY, cost: FREE,
      body: () => <>A running campaign shows a <strong>creator’s link</strong>. A first buy of at least 0.05 NEAR through it, by someone new to the token, counts as a new buyer. Each third of the target releases a milestone payout to the creator in tUSD, within the spend limits. You can sell your tokens back at any time from the Market tab.</>,
    },
  ],
};

// ---------- Creator: apply, get vetted, bid, reveal ----------

const create: Path = {
  id: 'create', title: 'Creator', who: 'I make things and want campaigns', wallet: true,
  blurb: 'Get reviewed by the AI scout, seal an offer on a campaign, open it, and get paid per milestone in tUSD.',
  steps: [
    signIn,
    {
      id: 'c-fund', title: 'Add NEAR to your Signalfire balance', route: () => '/creators', target: '[data-tour="apply"]',
      cost: '0.03 test NEAR from your account into your Signalfire balance (the 0.01 NEAR review fee plus one 0.02 NEAR offer deposit). Free network fee when your wallet supports it.',
      body: () => <>Creators pay the AI scout and offer deposits from a Signalfire balance with spending caps. In <strong>Become a creator</strong>, click <strong>Add 0.03 NEAR</strong>.</>,
      done: (x) => x.sig.walletFunded || x.sig.applied,
      after: () => <>Step 1 of the form gets a tick and shows your Signalfire balance.</>,
    },
    {
      id: 'c-apply', title: 'Apply', route: () => '/creators', target: '[data-tour="apply"]',
      cost: 'Free network fee, nothing to pay. The 0.01 NEAR review fee moves from your Signalfire balance and is held for the AI scout.',
      body: () => (
        <>Type your name and what you make, for whom. Then <strong>Apply</strong>.
          {typeof document !== 'undefined' && document.querySelector('.private-fields') && <> The <strong>Private, for the AI only</strong> fields are optional: they go only to the verified AI that writes your review, never to NEAR’s public record.</>}
        </>
      ),
      done: (x) => x.sig.applied,
      after: () => <>Your application is on NEAR and the AI scout has you in its queue.</>,
    },
    {
      id: 'c-vetted', title: 'The AI scout reviews you', route: () => '/creators', target: '[data-tour="apply"]', cost: 'Free for you: the review fee was paid when you applied.',
      body: () => <>The AI scout asks a private AI on NEAR AI Cloud for a short review and records its fingerprint on NEAR. Fixed rules then decide (registered scout, fee paid, the name doesn’t copy an approved creator). The AI never decides.</>,
      done: (x) => x.sig.admitted,
      wait: (x) => (x.sig.applied ? <>The AI scout is reviewing you: usually 30–60 s. Nothing after two minutes? Click <strong>Remind the AI scout</strong>.</> : null),
      after: () => <>Your card appears in the creators list: open <strong>Record and review</strong> to see your creator badge and the review with its Private AI badge. Live activity says “Lens reviewed …”.</>,
    },
    {
      id: 'c-bid', title: 'Seal an offer', target: '[data-tour="my-bid"]', via: VIA_CARD,
      route: (x) => `/s/${live(x.state, x.now).bidding[0]?.startup ?? focusStartup(x.state, x.now)}`,
      cost: 'Free, nothing to pay. A 0.02 NEAR deposit leaves your Signalfire balance and comes back when you open your offer.',
      body: () => <>On a campaign taking offers, <strong>Your sealed offer</strong> appears. Type a price within the allowed range and a pitch, then <strong>Seal my offer</strong>. Your browser seals it so nobody, not even other creators, sees your price until offers are opened. Click <strong>Download my offer file</strong> afterwards as a backup.</>,
      done: (x) => !!x.sig.bid,
      wait: (x) => {
        const l = live(x.state, x.now);
        const c = l.bidding[0];
        if (c) return c.commit_ends_ms - x.now < 20_000 ? <>Campaign #{c.id} stops taking offers in {fmtLeft(c.commit_ends_ms - x.now)}: probably too late for this one.</> : null;
        return <>No campaign is taking offers right now. {whenNext(x.state, x.now)} Offers are open for 90 s, so keep this tab open: this card says when.{OWN}</>;
      },
      after: () => <>Your offer shows <strong>sealed</strong>, and the <strong>Offers</strong> list shows it next to the AI creators’ sealed offers.</>,
    },
    {
      id: 'c-reveal', title: 'Open your offer', target: '[data-tour="my-bid"]', via: VIA_CARD,
      route: (x) => `/s/${x.sig.bid?.startup ?? focusStartup(x.state, x.now)}`,
      cost: 'Free, nothing to pay. Your 0.02 NEAR deposit comes back to your Signalfire balance. Miss the window and the deposit goes to the marketing fund.',
      body: () => <>When offers close, you have a short window to open yours (60 s on the demo’s briefs). Click <strong>Open my offer</strong>: the contract checks it matches what you sealed, then it’s published so anyone can check it.</>,
      done: (x) => x.sig.revealed,
      wait: (x) => {
        const c = x.sig.bid;
        if (c && c.phase === 'bidding' && x.now < c.commit_ends_ms) return <>You can open your offer in {fmtLeft(c.commit_ends_ms - x.now)}.</>;
        if (c && (c.phase !== 'bidding' || x.now >= c.reveal_ends_ms)) return <>The window to open offers on #{c.id} has closed. Seal an offer on the next campaign to try again.</>;
        return null;
      },
      after: () => <>Your price and pitch appear in the <strong>Offers</strong> list, labelled “written by the creator”.</>,
    },
    {
      id: 'c-result', title: 'Won or lost', target: '[data-tour="my-bid"]', via: VIA_CARD,
      route: (x) => `/s/${x.sig.bid?.startup ?? focusStartup(x.state, x.now)}`, cost: FREE,
      body: () => <>Once offers are opened, the contract picks the lowest price after the track-record bonus. If you win, the holders vote on funding you; then each third of the target pays you a milestone payout in tUSD, and the last one gives you a <strong>completion certificate</strong> (NFT).</>,
      done: (x) => x.sig.settled,
      wait: (x) => (x.sig.bid && !x.sig.settled ? <>Picking the winner: within a minute of offers being opened.</> : null),
      after: (x) => (x.sig.bid?.winner === x.account
        ? <>You won #{x.sig.bid?.id}. Share your creator link from the campaign card once it’s funded; payouts land as tUSD in your account.</>
        : <>The panel shows who won and at what price. If you opened your offer, your deposit is back in your Signalfire balance.</>),
    },
    {
      id: 'c-cashout', title: 'Cash out tUSD for NEAR', route: () => '/creators', target: '[data-tour="cashout"]',
      wait: (x) => (BigInt(x.me?.tusd ?? '0') === 0n ? <>Nothing to cash out yet: the <strong>Cash out</strong> panel appears on this page once a milestone has paid you tUSD.</> : null),
      cost: 'Your tUSD in, test NEAR out at Signalfire’s fixed test rate (1 NEAR = 3 tUSD); you approve two steps in your wallet.',
      body: () => <>Campaign payouts arrive as tUSD. Swap them for NEAR through <strong>NEAR Intents</strong>: move your tUSD to the exchange, approve one swap (what you give and what you get), and Signalfire’s exchange desk completes it in a single step. No marketing-fund money is involved.</>,
    },
  ],
};

// ---------- Founder: launch, fill, constrain, brief, vote ----------

const myRoute = (x: X): string => (x.sig.mine ? `/s/${x.sig.mine.id}` : '/launch');

const found: Path = {
  id: 'found', title: 'Founder', who: 'I want to launch a startup', wallet: true,
  blurb: 'Launch an attention token and its holders’ council, set the spend limits, post a campaign brief and vote on the winner.',
  steps: [
    signIn,
    {
      id: 'f-launch', title: 'Launch your startup', route: () => '/launch', target: '[data-tour="launch"]',
      cost: '1 test NEAR (it pays to set up the token and the holders’ council). Free network fee when your wallet supports it.',
      body: () => <>Pick a symbol, a name and a one-line pitch, then <strong>Launch</strong>. One step creates your token (all 1,000,000 on sale, none for you) and its holders’ council, with you as the first holder. Optional GitHub / X fields, if shown, feed the Evidence tab.</>,
      done: (x) => !!x.sig.mine,
      after: () => <>You land on your startup’s page in a few seconds. Its NEAR accounts are under “On NEAR” below the name.</>,
    },
    {
      id: 'f-links', title: 'Link and prove your accounts', route: myRoute, target: '[data-tour="founder-links"]', via: VIA_TREASURY, requires: EVIDENCE_TAB, cost: GASLESS,
      body: () => <>Sign a short note with your wallet, post it as a gist, a file in your repository or an X post, and paste the link. Signalfire checks it and the Evidence tab marks the link <strong>verified</strong>.</>,
    },
    {
      id: 'f-fill', title: 'Fill the marketing fund', route: myRoute, target: '[data-tour="trade"]', via: VIA_MARKET,
      cost: 'Whatever you buy, in test NEAR; 2% of it goes into your marketing fund. You can sell your tokens back any time.',
      body: () => <>The marketing fund fills only from trading fees: 2% of each trade (1 NEAR of trades puts 0.02 NEAR in). Buy some of your own token, or share the page. Nobody can add to the fund directly or take anything out of it.</>,
      done: (x) => x.sig.filled,
      after: (x) => <>Your marketing fund shows {x.sig.mine ? fmtNear(x.sig.mine.available, 4) : '…'} NEAR available on the Marketing fund and campaigns tab.</>,
    },
    {
      id: 'f-limits', title: 'Set your spend limits', route: myRoute, target: '[data-tour="founder-constraints"]', via: VIA_TREASURY, cost: GASLESS,
      body: () => <>Your only control over the money: the largest campaign, the largest single payment, payments per hour, the minimum offer, and how many tokens it takes to join the holders. The contract keeps each in a safe range. Change one and click <strong>Save spend limits</strong> (or Skip: the defaults are sensible).</>,
      done: (x) => x.sig.constrained,
      after: () => <>The new limits show under Founder’s spend limits, and the audit log records “Spend limits changed”.</>,
    },
    {
      id: 'f-brief', title: 'Post a campaign brief', route: myRoute, target: '[data-tour="founder-brief"]', via: VIA_TREASURY,
      cost: 'Free, nothing to pay. The budget stays in the marketing fund until the holders approve a winner.',
      body: () => <>Say what creators should do, how many new buyers you want and the budget (up to your largest campaign budget and what the fund has available). Tip: 2 minutes for offers and 2 minutes to open them gives the AI creators time to send offers (they act every few seconds). Click <strong>Post the brief</strong>.</>,
      done: (x) => x.sig.briefed,
      wait: (x) => (x.sig.mine && !x.sig.filled ? <>The marketing fund is empty, so there’s no budget yet: fill it first (previous step).</> : null),
      after: () => <>The campaign appears under Campaigns with its clock: sealed offers arrive, then they’re opened.</>,
    },
    {
      id: 'f-vote', title: 'Vote on the winner', route: myRoute, target: '[data-tour="campaigns"]', via: VIA_TREASURY, cost: GASLESS,
      body: () => <>When offers are opened, the winner is picked and a funding vote opens for your holders’ council. You’re on it (anyone with enough tokens can join), so open the campaign and <strong>Vote yes</strong> or <strong>Vote no</strong>. Funding is the holders’ decision, not yours as founder.</>,
      done: (x) => x.sig.votedMine,
      wait: (x) => {
        const c = x.state.campaigns.filter((y) => y.startup === x.sig.mine?.id).sort((a, b) => b.id - a.id)[0];
        if (!c) return null;
        if (c.phase === 'bidding') return <>Campaign #{c.id} is taking offers; the vote opens about {fmtLeft(Math.max(0, c.reveal_ends_ms - x.now) + 15_000)} from now.</>;
        if (c.phase === 'no_bids') return <>No creator made an offer in range on #{c.id}. Post another brief: a bigger budget or more time for offers (2 minutes or more) helps.</>;
        return null;
      },
      after: () => <>At a majority the winning price is set aside and the campaign starts: your creator is on it. They bring buyers through their creator link; milestone payouts go out as new buyers arrive, and every payout is in the audit log.</>,
    },
  ],
};

export const PATHS: Path[] = [explore, back, create, found];
export const pathById = (id: PathId): Path => PATHS.find((p) => p.id === id)!;

/** A step counts as complete when real state says so, or (read-only steps) once the user went past it. */
export const complete = (s: Step, x: X, seen: string[]): boolean => (s.done ? s.done(x) : seen.includes(s.id));
