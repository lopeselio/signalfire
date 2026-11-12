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
const GASLESS = 'Gasless: no NEAR attached, and Signalfire’s relayer pays the gas when your wallet can sign delegate actions (otherwise a normal transaction, a few thousandths of testnet NEAR in gas).';
const VIA_TREASURY = [{ sel: '[data-tour="tab-treasury"]', text: 'First open the Treasury and campaigns tab.' }];
const VIA_MARKET = [{ sel: '[data-tour="tab-market"]', text: 'First open the Market tab.' }];
const EVIDENCE_TAB = '[data-tour="evidence-tab"]';
const EVIDENCE = [{ sel: EVIDENCE_TAB, text: 'Open the Evidence tab.' }];
/** inside a campaign card: open the card first, else the tab */
const VIA_CARD = [{ sel: '[data-tour="campaigns"]', text: 'Open the campaign’s card: click Details on the one taking bids or reveals.' }, ...VIA_TREASURY];
/** The way not to wait for the demo's next brief: run your own (founders may bid on and vote on their own campaigns). */
const OWN = <> Don’t want to wait? Take the <strong>Founder</strong> path: launch your own startup and post a brief; the AI creators bid on it within seconds, you can seal a bid on it yourself, and you vote as its first holder.</>;

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
  title: 'Sign in with a NEAR testnet wallet',
  body: () => <>Click <strong>Sign in</strong> and pick a wallet (Meteor, HOT, Intear, MyNearWallet…). It signs a short “Sign in to this site” message; that starts a session here. Use a <strong>testnet</strong> account: nothing here touches mainnet.</>,
  cost: 'Free: your wallet signs a message, not a transaction.',
  target: '[data-tour="sign-in"]',
  done: (x) => x.sig.signedIn,
  after: (x) => <>You’re signed in as <code>{x.account}</code> (top right). Every action from here goes through your wallet.</>,
};

// ---------- Explore: read-only, no wallet ----------

const explore: Path = {
  id: 'explore', title: 'Explore', who: 'I’m just looking', wallet: false,
  blurb: 'A guided look at a live startup, its treasury, a campaign, the creators and the evidence. No wallet needed.',
  steps: [
    {
      id: 'x-beacon', title: 'Where every trading fee goes', route: () => '/', target: '[data-tour="beacon"]', cost: FREE,
      body: () => <>2% of every trade of every attention token lands in that startup’s <strong>marketing treasury</strong>, a ledger inside the hub contract. This card adds them up: free to fund campaigns, reserved for funded ones, paid to creators, and <strong>paid to founders: 0</strong>. No method in the contract can send it to them.</>,
    },
    {
      id: 'x-wire', title: 'The wire: agents acting onchain', route: () => '/', target: '[data-tour="wire"]', cost: FREE,
      body: () => <>AI agents post briefs, seal bids, vote and buy here, live. Every line with a <strong>tx</strong> link opens the transaction on nearblocks, so nothing here is a mock-up.</>,
    },
    {
      id: 'x-discover', title: 'Pick a startup', route: () => '/discover', target: '[data-tour="startups"]', cost: FREE,
      body: () => <>Each card is a startup with its own attention token and DAO. The big number is its marketing treasury right now: budget only creators can earn, by bringing in new buyers. The demo startups and founders are fictional.</>,
    },
    {
      id: 'x-curve', title: 'The bonding curve', route: (x) => `/s/${focusStartup(x.state, x.now)}`, target: '[data-tour="price"]', via: VIA_MARKET, cost: FREE,
      body: () => <>The price rises in a straight line as tokens are bought and falls as they are sold back. The curve’s reserve always covers selling every token back. Buys tagged <strong>campaign #N</strong> came through a creator’s referral link and counted as results.</>,
    },
    {
      id: 'x-supply', title: 'Fixed supply, nothing for the founder', target: '[data-tour="supply"]', via: VIA_MARKET, cost: FREE,
      body: () => <>1,000,000 tokens, minted once to the curve. <strong>Founder allocation 0.</strong> The token is attention, not equity and not a claim on revenue: holding it buys a vote on how the marketing budget is spent, nothing more.</>,
    },
    {
      id: 'x-evidence', title: 'Check the evidence', target: '[data-tour="evidence-panel"]', via: EVIDENCE, requires: EVIDENCE_TAB, cost: FREE,
      body: () => <>Who the founder is and what they have shipped: linked accounts (verified or only claimed), their history, public code, the onchain track record, and an AI research brief whose Private AI badge your browser checks.</>,
    },
    {
      id: 'x-ledger', title: 'The marketing treasury', target: '[data-tour="ledger"]', via: VIA_TREASURY, cost: FREE,
      body: () => <>Free, reserved for funded campaigns, paid to creators, fees and forfeited bid bonds in. The only way out is a milestone payout to a creator the holders funded, through the <strong>spend policy</strong> (caps, payee allowlist, hourly limit).</>,
    },
    {
      id: 'x-campaigns', title: 'A campaign, phase by phase', target: '[data-tour="campaigns"]', via: VIA_TREASURY, cost: FREE,
      body: () => <>Open a campaign’s <strong>Details</strong>: the timeline (sealed bids → reveal → holders vote → running → paid), the bid book with each creator’s price and pitch, the DAO proposal with every holder’s vote, the milestones and <strong>Proof (JSON)</strong> you can re-check with <code>pnpm verify</code>.</>,
    },
    {
      id: 'x-audit', title: 'The audit log', target: '[data-tour="audit"]', via: VIA_TREASURY, cost: FREE,
      body: () => <>Every spend attempt and every decision the policy makes, written onchain by the hub: <code>paid</code>, <code>held</code>, flags like <code>burst</code> and <code>new_payee</code>, and <code>rejected + lookalike</code> for an impostor creator name.</>,
    },
    {
      id: 'x-creators', title: 'Creators: people and AI agents', route: () => '/creators', target: '[data-tour="creators"]', cost: FREE,
      body: () => <>Each admitted creator holds a soulbound NFT whose record updates as they work. Click <strong>NFTs and vetting report</strong>: the scout’s report carries a <strong>Private AI</strong> badge, and your browser verifies the model’s TEE attestation itself (a few seconds).</>,
    },
    {
      id: 'x-thesis', title: 'The thesis, with its evidence', route: () => '/dashboard', target: '[data-tour="thesis"]', cost: FREE,
      body: () => <>Why agent-run marketing treasuries belong on NEAR, with the evidence computed from chain data: gas per agent action, where the fees went, cost per new buyer, key and spend bounds, and the limits of the claim.</>,
    },
    {
      id: 'x-next', title: 'That’s the whole loop', cost: FREE,
      body: () => <>Token → fees → treasury → sealed bids → holders’ vote → milestone payouts → receipt NFT. To take part, open <strong>Get started</strong> (bottom left) and pick <em>Back a startup</em>, <em>Creator</em> or <em>Founder</em>. You need a NEAR testnet wallet with a little testnet NEAR (free from a faucet).</>,
    },
  ],
};

// ---------- Back a startup: buy, join the holders, vote ----------

const back: Path = {
  id: 'back', title: 'Back a startup', who: 'I want to buy and vote', wallet: true,
  blurb: 'Buy a startup’s attention token, join its holders’ council and vote on which campaign its treasury funds.',
  steps: [
    signIn,
    {
      id: 'b-evidence', title: 'Check the evidence first', route: (x) => `/s/${focusStartup(x.state, x.now)}`, target: '[data-tour="evidence-panel"]', via: EVIDENCE, requires: EVIDENCE_TAB, cost: FREE,
      body: () => <>Before you buy: who is the founder, which links are verified, what have they shipped? Read the research brief and its Private AI badge.</>,
    },
    {
      id: 'b-buy', title: 'Buy some attention tokens', route: (x) => `/s/${focusStartup(x.state, x.now)}`, target: '[data-tour="trade"]', via: VIA_MARKET,
      cost: 'The testnet NEAR you type (2% of it goes to the marketing treasury), plus 0.00125 NEAR token storage on your first buy. Gas: gasless when your wallet signs delegate actions; the NEAR you spend always comes from your own account.',
      body: (x) => {
        const id = focusStartup(x.state, x.now);
        return <>Type an amount in <strong>Buy</strong> and click <strong>Buy {sym(id)}</strong>. 0.1 NEAR buys about {tenth(x, id)} {sym(id)}; you need at least {minHold(x, id)} {sym(id)} to join the holders. The quote is the contract’s own math; your slippage limit is sent with the buy.</>;
      },
      done: (x) => x.sig.holds.length > 0,
      after: () => <>A toast with <strong>View transaction</strong>, your buy at the top of the trades table, and your balance next to your account (about 15 s).</>,
    },
    {
      id: 'b-join', title: 'Join the holders’ council', target: '[data-tour="holders"]', via: VIA_TREASURY, cost: GASLESS,
      route: (x) => `/s/${x.sig.holdsEnough.find((h) => !x.sig.holderOf.includes(h)) ?? x.sig.holds[0] ?? focusStartup(x.state, x.now)}`,
      body: () => <>Holders vote in the startup’s Sputnik DAO: one holder, one vote, so a whale can’t buy the outcome. Click <strong>Join the holders</strong>: the hub reads your balance from the token and adds you to the DAO’s holders role.</>,
      done: (x) => x.sig.holderOf.length > 0,
      wait: (x) => (x.sig.holds.length > 0 && x.sig.holdsEnough.length === 0 ? <>You hold some tokens, but less than the minimum to join. Buy a little more on the Market tab.</> : null),
      after: () => <>You appear in the council list with a <strong>you</strong> chip. Anyone may remove holders who sell below the minimum.</>,
    },
    {
      id: 'b-vote', title: 'Vote on a funding proposal', target: '[data-tour="campaigns"]', via: VIA_TREASURY, cost: GASLESS,
      route: (x) => {
        const v = live(x.state, x.now).voting.find((c) => x.sig.holderOf.includes(c.startup));
        return `/s/${v?.startup ?? x.sig.holderOf[0] ?? focusStartup(x.state, x.now)}`;
      },
      body: () => <>When an auction settles, the hub files a proposal in the DAO: “call <code>fund_campaign</code> for the winning bid”. Open the campaign that reads <strong>Holders vote</strong> and click <strong>Vote yes</strong> or <strong>Vote no</strong>. A majority of holders decides; the DAO itself can’t move money.</>,
      done: (x) => x.sig.voted,
      wait: (x) => {
        const l = live(x.state, x.now);
        const mine = l.voting.find((c) => x.sig.holderOf.includes(c.startup));
        if (mine) return null;
        const soon = [...l.bidding, ...l.reveal].find((c) => x.sig.holderOf.includes(c.startup));
        if (soon) return <>Campaign #{soon.id} on {nameOf(x.state, soon.startup)} is in its auction; its vote opens when the reveal closes, in about {fmtLeft(soon.reveal_ends_ms - x.now + 10_000)}. Keep this page open.</>;
        return <>No vote is open on a startup you hold right now. A vote opens about 3 minutes after a brief is posted (90 s of sealed bids, 60 s to reveal, then the settle). {whenNext(x.state, x.now)} The demo’s holder agents vote within seconds, so if they reach a majority first the proposal closes; that is the DAO working, and you vote on the next one.{OWN}</>;
      },
      after: () => <>Your vote shows as a chip next to your account under the DAO proposal. When a majority approves, the DAO calls the hub and the price is reserved: the campaign starts running.</>,
    },
    {
      id: 'b-ref', title: 'Results and payouts', target: '[data-tour="campaigns"]', via: VIA_TREASURY, cost: FREE,
      body: () => <>A running campaign shows a <strong>referral link</strong>. A first buy of at least 0.05 NEAR through it, by someone new to the token, is a result; each third of the target unlocks a milestone that pays the creator in tUSD through the spend policy. You can sell your tokens back on the curve at any time from the Market tab.</>,
    },
  ],
};

// ---------- Creator: apply, get vetted, bid, reveal ----------

const create: Path = {
  id: 'create', title: 'Creator', who: 'I make things and want campaigns', wallet: true,
  blurb: 'Get vetted by the AI scout, seal a bid on a campaign, reveal it, and get paid per milestone in tUSD.',
  steps: [
    signIn,
    {
      id: 'c-fund', title: 'Fund your Signalfire wallet', route: () => '/creators', target: '[data-tour="apply"]',
      cost: '0.03 testnet NEAR from your account into your Signalfire wallet inside the hub (the 0.01 NEAR vetting fee plus one 0.02 NEAR bid bond). Gas via the relayer when your wallet supports it.',
      body: () => <>Creators pay the scout and post bid bonds from a wallet inside the hub, with caps. In <strong>Become a creator</strong>, click <strong>Fund with 0.03 NEAR</strong>.</>,
      done: (x) => x.sig.walletFunded || x.sig.applied,
      after: () => <>Step 1 of the form gets a tick and shows your wallet balance.</>,
    },
    {
      id: 'c-apply', title: 'Apply', route: () => '/creators', target: '[data-tour="apply"]',
      cost: 'Gasless, no NEAR attached. The 0.01 NEAR vetting fee moves from your Signalfire wallet into escrow for the scout.',
      body: () => (
        <>Type your name and what you make, for whom. Then <strong>Apply</strong>.
          {typeof document !== 'undefined' && document.querySelector('.private-fields') && <> The <strong>Private, for the AI only</strong> fields are optional: they go only to the TEE model that writes your report, never onchain.</>}
        </>
      ),
      done: (x) => x.sig.applied,
      after: () => <>Your application is onchain and the scout has you in its queue.</>,
    },
    {
      id: 'c-vetted', title: 'The scout vets you', route: () => '/creators', target: '[data-tour="apply"]', cost: 'Free for you: the scout’s fee was paid when you applied.',
      body: () => <>The scout, an AI agent, asks a model running in a TEE on NEAR AI Cloud for a short vetting report, puts its hash onchain, and the hub admits you <strong>by rule</strong> (registered scout, fee paid, not a look-alike of an admitted name). The model never decides.</>,
      done: (x) => x.sig.admitted,
      wait: (x) => (x.sig.applied ? <>The scout is vetting you: usually 30–60 s. Nothing after two minutes? Click <strong>Remind the scout</strong>.</> : null),
      after: () => <>Your card appears in the creators list: open <strong>NFTs and vetting report</strong> to see your soulbound creator NFT and the report with its Private AI badge. The wire says “Lens vetted …”.</>,
    },
    {
      id: 'c-bid', title: 'Seal a bid', target: '[data-tour="my-bid"]', via: VIA_CARD,
      route: (x) => `/s/${live(x.state, x.now).bidding[0]?.startup ?? focusStartup(x.state, x.now)}`,
      cost: 'Gasless, no NEAR attached. A 0.02 NEAR bond leaves your Signalfire wallet and comes back when you reveal.',
      body: () => <>On a campaign taking bids, <strong>Your sealed bid</strong> appears. Type a price inside the credible range and a pitch, then <strong>Seal bid</strong>. Your browser draws a secret salt and sends only the hash: nobody, not even the other creators, sees your price until the reveal. Click <strong>Download the opening</strong> afterwards as a backup.</>,
      done: (x) => !!x.sig.bid,
      wait: (x) => {
        const l = live(x.state, x.now);
        const c = l.bidding[0];
        if (c) return c.commit_ends_ms - x.now < 20_000 ? <>Campaign #{c.id}’s bidding closes in {fmtLeft(c.commit_ends_ms - x.now)}: probably too late for this one.</> : null;
        return <>No campaign is taking bids right now. {whenNext(x.state, x.now)} Bidding lasts 90 s, so keep this tab open: this card says when it opens.{OWN}</>;
      },
      after: () => <>Your bid shows <strong>committed</strong> with its commit tx, and the bid book lists your sealed hash next to the AI creators’.</>,
    },
    {
      id: 'c-reveal', title: 'Reveal your bid', target: '[data-tour="my-bid"]', via: VIA_CARD,
      route: (x) => `/s/${x.sig.bid?.startup ?? focusStartup(x.state, x.now)}`,
      cost: 'Gasless, no NEAR attached. Your 0.02 NEAR bond comes back to your Signalfire wallet. Miss the window and the bond goes to the treasury.',
      body: () => <>When bidding closes, the reveal window opens (60 s on the demo’s briefs). Click <strong>Reveal my bid</strong>: the contract checks your price, pitch and salt against the hash, then your opening is published so anyone can verify it.</>,
      done: (x) => x.sig.revealed,
      wait: (x) => {
        const c = x.sig.bid;
        if (c && c.phase === 'bidding' && x.now < c.commit_ends_ms) return <>The reveal window opens in {fmtLeft(c.commit_ends_ms - x.now)}.</>;
        if (c && (c.phase !== 'bidding' || x.now >= c.reveal_ends_ms)) return <>The reveal window for #{c.id} has closed. Seal a bid on the next campaign to try again.</>;
        return null;
      },
      after: () => <>Your price and pitch appear in the bid book, labelled “written by the creator”.</>,
    },
    {
      id: 'c-result', title: 'Won or lost', target: '[data-tour="my-bid"]', via: VIA_CARD,
      route: (x) => `/s/${x.sig.bid?.startup ?? focusStartup(x.state, x.now)}`, cost: FREE,
      body: () => <>Anyone may settle the auction once the reveal closes; the contract picks the lowest price after the reputation discount. If you won, the holders vote on funding you, then each third of the target pays you a milestone in tUSD, and the last one mints a <strong>receipt NFT</strong>.</>,
      done: (x) => x.sig.settled,
      wait: (x) => (x.sig.bid && !x.sig.settled ? <>Settling: within a minute of the reveal closing.</> : null),
      after: (x) => (x.sig.bid?.winner === x.account
        ? <>You won #{x.sig.bid?.id}. Share the referral link from the campaign card once it’s funded; payouts land as tUSD in your account.</>
        : <>The panel shows who won and at what price; your bond is back in your wallet if you revealed.</>),
    },
    {
      id: 'c-cashout', title: 'Cash out tUSD for NEAR', route: () => '/creators', target: '[data-tour="cashout"]',
      wait: (x) => (BigInt(x.me?.tusd ?? '0') === 0n ? <>Nothing to cash out yet: the <strong>Cash out</strong> panel appears on this page once a milestone has paid you tUSD.</> : null),
      cost: 'Your tUSD in, testnet NEAR out at the hub’s fixed test rate (1 NEAR = 3 tUSD); you sign the deposit and one intent.',
      body: () => <>Campaign payouts arrive as tUSD. Swap them for NEAR through <strong>NEAR Intents</strong>: deposit your tUSD into the Verifier, sign one intent (what you give and what you get), and the Verifier settles it with the desk’s matching intent in one transaction. No treasury money is involved.</>,
    },
  ],
};

// ---------- Founder: launch, fill, constrain, brief, vote ----------

const myRoute = (x: X): string => (x.sig.mine ? `/s/${x.sig.mine.id}` : '/launch');

const found: Path = {
  id: 'found', title: 'Founder', who: 'I want to launch a startup', wallet: true,
  blurb: 'Launch an attention token and its DAO, set the treasury’s limits, post a campaign brief and vote on the winner.',
  steps: [
    signIn,
    {
      id: 'f-launch', title: 'Launch your startup', route: () => '/launch', target: '[data-tour="launch"]',
      cost: '1 testnet NEAR attached (it pays for the new token and DAO accounts). Gas via the relayer when your wallet supports it.',
      body: () => <>Pick a symbol, a name and a one-line pitch, then <strong>Launch</strong>. One transaction creates your token (all 1,000,000 on the curve, none for you) and your DAO, with you as its first holder. Optional GitHub / X fields, if shown, feed the Evidence tab.</>,
      done: (x) => !!x.sig.mine,
      after: () => <>You land on your startup’s page in a few seconds. Its token and DAO accounts are linked under the name.</>,
    },
    {
      id: 'f-links', title: 'Link and prove your accounts', route: myRoute, target: '[data-tour="founder-links"]', via: VIA_TREASURY, requires: EVIDENCE_TAB, cost: GASLESS,
      body: () => <>Sign a message with your wallet, publish it as a gist, repo file or X post, and paste the URL: the server checks it and the Evidence tab marks the link <strong>verified</strong>.</>,
    },
    {
      id: 'f-fill', title: 'Fill the treasury', route: myRoute, target: '[data-tour="trade"]', via: VIA_MARKET,
      cost: 'Whatever you buy, in testnet NEAR; 2% of it lands in your marketing treasury. You can sell it back on the curve.',
      body: () => <>The treasury fills only from trading fees: 2% of each trade (1 NEAR of trades puts 0.02 NEAR in). Buy some of your own token, or share the page. You can’t deposit into the treasury or take anything out of it.</>,
      done: (x) => x.sig.filled,
      after: (x) => <>Your treasury shows {x.sig.mine ? fmtNear(x.sig.mine.available, 4) : '…'} NEAR free on the Treasury tab.</>,
    },
    {
      id: 'f-limits', title: 'Set the spend policy’s limits', route: myRoute, target: '[data-tour="founder-constraints"]', via: VIA_TREASURY, cost: GASLESS,
      body: () => <>Your only lever over the money: the largest campaign, the largest single payout, payouts per hour, the credible-bid floor, and how many tokens it takes to join the holders. The contract enforces hard limits on each. Change one and click <strong>Save constraints</strong> (or Skip: the defaults are sensible).</>,
      done: (x) => x.sig.constrained,
      after: () => <>The new limits show under Founder’s constraints, and the audit log gets a <code>constraints</code> entry.</>,
    },
    {
      id: 'f-brief', title: 'Post a campaign brief', route: myRoute, target: '[data-tour="founder-brief"]', via: VIA_TREASURY,
      cost: 'Gasless, no NEAR attached. The budget stays in the treasury until the holders fund a winner.',
      body: () => <>Say what creators should do, how many new buyers you want and the budget (up to your cap and the treasury’s free NEAR). Tip: a 2-minute bidding and reveal window gives the AI creator agents time to bid (they act every few seconds). Click <strong>Post the brief</strong>.</>,
      done: (x) => x.sig.briefed,
      wait: (x) => (x.sig.mine && !x.sig.filled ? <>The treasury is empty, so no budget is possible yet: fill it first (previous step).</> : null),
      after: () => <>The campaign appears under Campaigns with its clock: sealed bids arrive, then the reveal.</>,
    },
    {
      id: 'f-vote', title: 'Vote on the winner', route: myRoute, target: '[data-tour="campaigns"]', via: VIA_TREASURY, cost: GASLESS,
      body: () => <>When the reveal closes, the auction settles and the hub files a funding proposal in your DAO. You’re on the holders’ council (anyone with enough tokens can join), so open the campaign and <strong>Vote yes</strong> or <strong>Vote no</strong>. Funding is the holders’ decision, not yours as founder.</>,
      done: (x) => x.sig.votedMine,
      wait: (x) => {
        const c = x.state.campaigns.filter((y) => y.startup === x.sig.mine?.id).sort((a, b) => b.id - a.id)[0];
        if (!c) return null;
        if (c.phase === 'bidding') return <>Campaign #{c.id} is in its auction; the vote opens about {fmtLeft(Math.max(0, c.reveal_ends_ms - x.now) + 15_000)} from now.</>;
        if (c.phase === 'no_bids') return <>Campaign #{c.id} got no credible bid. Post another brief with a longer bidding window.</>;
        return null;
      },
      after: () => <>At a majority the DAO calls the hub, the price is reserved and the campaign starts running. Creators bring buyers through its referral link; milestones pay out as results arrive, and every payout lands in the audit log.</>,
    },
  ],
};

export const PATHS: Path[] = [explore, back, create, found];
export const pathById = (id: PathId): Path => PATHS.find((p) => p.id === id)!;

/** A step counts as complete when real state says so, or (read-only steps) once the user went past it. */
export const complete = (s: Step, x: X, seen: string[]): boolean => (s.done ? s.done(x) : seen.includes(s.id));
