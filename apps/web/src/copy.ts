// Plain words for raw strings the UI receives but must not change: contract panics, the core form checks and
// wallet refusals (asserted by tests), wallet and server errors. The raw text stays the source of truth; these
// maps only change what a person reads. Anything unknown falls back to the raw string.

/** Contract panics, wallet and server errors → a plain sentence (matched as a substring, longest key first). */
const ERRORS: Record<string, string> = {
  // contract panics (contracts/hub)
  'slippage: fewer tokens than min_tokens_out': 'The price moved before your buy went through, so nothing was bought and you kept your NEAR. Try again, or allow more price movement.',
  'slippage: less NEAR than min_near_out': 'The price moved before your sale went through, so nothing was sold. Try again, or allow more price movement.',
  'too little to buy one raw unit': 'That amount is too small to buy any tokens.',
  'at most 1000 NEAR per buy': 'You can buy up to 1,000 NEAR at a time.',
  'below the holder minimum': 'You need the minimum number of tokens to join the holders.',
  'not awaiting a vote': 'This vote has already closed.',
  'bidding is closed': 'This campaign has stopped taking offers.',
  'one bid per creator': "You've already sent an offer on this campaign.",
  'admitted creators only': 'Only approved creators can send offers.',
  'not a creator': 'Only approved creators can send offers.',
  'creator revoked': 'This creator account has been removed.',
  'not the reveal window': "It isn't time to open offers.",
  'opening does not match the commitment': "That doesn't match your sealed offer. Check you chose the right offer file.",
  'bad opening': "That doesn't match your sealed offer. Check you chose the right offer file.",
  'already revealed': 'Your offer is already open.',
  'the reveal window is still open': 'Creators are still sending or opening offers. Try once that window closes.',
  'bidding is still open': 'Creators are still sending or opening offers. Try once that window closes.',
  'already settled': 'The winner has already been picked.',
  'this brief takes sealed bids only': "This campaign's offer type changed. Reload the page and seal your offer again.",
  'this brief takes commit-reveal bids': "This campaign's offer type changed. Reload the page and seal your offer again.",
  "the scorer's key changed": "This campaign's offer type changed. Reload the page and seal your offer again.",
  'sealed bids are never revealed': "Privately scored offers don't need opening. There's nothing to do.",
  'wallet: not enough NEAR': 'Your Signalfire balance is too low. Add NEAR to it first.',
  'no wallet': 'Your Signalfire balance is too low. Add NEAR to it first.',
  'wallet: over the per-transaction cap': "That's over your Signalfire balance's per-payment limit.",
  'wallet: over the 24-hour cap': "That's over your Signalfire balance's daily limit. Try again tomorrow.",
  'already applied': "You've already applied. The AI scout reviews you shortly.",
  'already admitted': "You're already an approved creator.",
  'name or profile too long': 'Name or description is too long.',
  'symbol taken': 'That symbol is taken.',
  'symbol: 2-8 lowercase letters or digits': 'Symbol: 2 to 8 lowercase letters or digits.',
  'attach 1 NEAR to launch': 'Launching costs 1 NEAR.',
  'council: 1 to 9 holders': "The holders' council starts with 1 to 9 members.",
  'name or pitch too long': 'Name or pitch is too long.',
  'title or brief too long': 'Title or goal is too long.',
  'founder only': "Only this startup's founder can do this.",
  'budget over the campaign cap': 'The budget is over your largest campaign budget.',
  "budget over the treasury's free balance": 'The budget is more than the marketing fund has available.',
  "the treasury can't cover the price": "The marketing fund can't cover this price right now.",
  'the DAO refused the proposal': "The holders' funding vote couldn't open. Signalfire is trying again.",
  'milestone not reached yet': 'Not enough new buyers yet for the next payout.',
  'campaign is not funded': "This campaign isn't running.",
  'campaign is not running': "This campaign isn't running.",
  'startup is not live': "That startup or campaign isn't available.",
  'no such startup': "That startup or campaign isn't available.",
  'no such campaign': "That startup or campaign isn't available.",
  // the wallet (apps/web/src/wallet.ts)
  'the wallet didn’t sign': "Your wallet didn't confirm, so nothing was sent.",
  'the relayer refused the transaction': "Signalfire couldn't cover the network fee for this one. Try again; your wallet may ask you to pay a tiny fee yourself.",
  'the transaction failed': "It didn't go through.",
  // the server (apps/server/src/main.ts, ba.ts, cashout.ts)
  'reveal onchain first; the opening stays private until then': 'Open your offer first. It stays private until then.',
  'this opening does not match the sealed commitment': "That doesn't match your sealed offer.",
  'sign in first': 'Please sign in first.',
  'not signed in': 'Please sign in first.',
  'NEAR AI is off on this server': 'Private AI is switched off right now.',
  "sealed to a key that is not the model's current attested key": "The AI's key changed since this page loaded. Reload and try again.",
  'no application onchain yet': "We don't see your application on NEAR yet. Give it a few seconds.",
  'is not whitelisted for relay': "Signalfire can't cover the network fee for this action.",
  'another cash-out is settling': 'Another cash-out is finishing. Try again in a few seconds.',
  'deposit the tUSD into the Verifier first': 'Move your tUSD to the exchange first (step 1).',
  'register your wallet key with the Verifier first': 'Finish the one-time wallet setup first.',
  'the signed intent was refused': "The swap you approved didn't match the cash-out, so nothing happened. Try again.",
  'the two sides do not cancel': "The swap you approved didn't match the cash-out, so nothing happened. Try again.",
  'the Verifier would refuse it': "The swap you approved didn't match the cash-out, so nothing happened. Try again.",
};
const ERROR_KEYS = Object.keys(ERRORS).sort((a, b) => b.length - a.length);

/** A raw error message in plain words (the raw text when there's no match). */
export function friendly(msg: string): string {
  const ref = /the transaction failed \(([^)]+)\)/.exec(msg);
  if (ref) return `It didn't go through (reference ${ref[1]}).`;
  const k = ERROR_KEYS.find((key) => msg.includes(key));
  return k ? ERRORS[k] : msg;
}

/** packages/core briefErrors and constraintErrors (tested there, so mapped here for display). */
const FORM: Record<string, string> = {
  'title: 1 to 80 bytes': 'Title: required, up to 80 characters (accents and emoji use more).',
  'brief: at most 600 bytes': 'Goal: up to about 600 characters.',
  'target: 1 to 10000 buyers': 'New buyers wanted: 1 to 10,000.',
  'budget over the campaign cap': 'The budget is over your largest campaign budget.',
  "budget over the treasury's free balance": 'The budget is more than the marketing fund has available.',
  'windows: 30 s to 7 days': 'Time for offers and time to open them: 30 seconds to 7 days each.',
  'duration: 1 minute to 90 days': 'Deadline: 1 minute to 90 days after funding.',
  'campaign_cap out of range': 'Largest campaign budget: more than 0, up to 1,000 NEAR.',
  'max_payout must be positive': 'Largest single payment must be more than 0.',
  'payouts_per_hour: 1 to 60': 'Payments per hour: 1 to 60.',
  'min_bid_bps: at most 9000': 'Minimum offer: 0% to 90% of the budget.',
  'min_holder_tokens: 1 token to 1% of supply': 'Tokens to join the holders: 1 to 10,000.',
  'enter a number in every field': 'Enter a number in every field.',
};
export const formError = (raw: string): string => FORM[raw] ?? raw;

/** packages/core walletRefusal (tested there, and Bid.tsx matches the raw text), mapped for display. */
const REFUSAL: Record<string, string> = {
  'no wallet: fund it first': "you don't have a Signalfire balance yet: add NEAR first",
  'over the per-transaction cap': "it's over your per-payment limit",
  'over the 24-hour cap': "it's over your daily limit; try again tomorrow",
  'not enough NEAR in the wallet': "there isn't enough NEAR in your Signalfire balance",
};
export const refusalText = (raw: string): string => REFUSAL[raw] ?? raw;

/** An audit entry's action and outcome in plain words (the raw values stay in the audit log's Raw view). */
export function auditWhat(action: string, outcome: string): string {
  if (action === 'constraints') return 'Spend limits changed';
  if (action === 'vet') return outcome === 'admitted' ? 'Creator approved' : outcome === 'rejected' ? 'Creator turned away: copycat name' : `Creator review: ${outcome}`;
  if (action === 'revoke') return 'Creator removed';
  if (action === 'bond_forfeit') return 'Deposit kept for the marketing fund';
  if (action === 'fund') return 'Campaign funded by the holders’ vote';
  if (action === 'payout') {
    const p: Record<string, string> = {
      paid: 'Payout sent', 'held:over_cap': 'Payout held: over the payment limit', 'held:rate_limit': 'Payout held: hourly limit reached',
      'held:payee_revoked': 'Payout held: creator removed', 'failed:transfer': 'Payout failed and was undone',
    };
    return p[outcome] ?? `Payout: ${outcome}`;
  }
  if (action === 'expire') return 'Deadline passed: unpaid budget returned';
  if (action === 'agent_setup') return 'Keyless payout agent set up';
  if (action === 'agent_enabled') return outcome === 'off' ? 'Keyless payout agent switched off' : 'Keyless payout agent switched on';
  if (action === 'scorer_set') return 'Private scoring program set';
  if (action === 'scorer_key') return 'Private scoring key published';
  if (action === 'sealed_abandoned') return 'Private scoring timed out: deposits returned';
  return action;
}

/** An audit entry's note in plain words. */
export function auditNote(action: string, note: string): string {
  if (action === 'constraints') return 'Spend limits updated';
  if (action === 'vet') {
    if (note.startsWith('report ')) return 'Review report on file';
    const m = /^lookalike of (.+)$/.exec(note);
    if (m) return `Name too close to ${m[1]}`;
  }
  if (action === 'bond_forfeit') {
    if (note === 'bid never revealed') return 'Offer never opened';
    if (note === 'sealed bid did not open to its commitment') return 'Sealed offer didn’t match what was sealed';
  }
  if (action === 'fund') { const m = /^DAO proposal (\d+)$/.exec(note); if (m) return `Funding vote #${m[1]}`; }
  if (action === 'payout') {
    const m = /^milestone (\d+): ([^·]+?)(?: ·.*)?$/.exec(note);
    if (m) return `Payout ${m[1]} of 3: ${m[2]}`;
  }
  if (action === 'expire') return note.replace(/(\d+) of (\d+) results/, '$1 of $2 new buyers');
  if (action === 'agent_setup') return 'Key created by NEAR’s signing network';
  if (action === 'sealed_abandoned') return 'No winner; every deposit returned';
  if (action === 'scorer_set' || action === 'scorer_key') return 'Fingerprints in Raw view';
  return note;
}

/** An audit flag in plain words (the raw code is kept as the chip's title). */
export const FLAG: Record<string, string> = {
  burst: 'rapid payments', new_payee: 'first payment to this creator', over_cap: 'over limit', rate_limit: 'hourly limit',
  lookalike: 'copycat name', keyless_agent: 'sent by keyless agent', outlayer: 'private scoring',
};

/** An audit outcome as a short plain chip (colour still comes from the raw value). */
export function auditResult(outcome: string): string {
  const m: Record<string, string> = { admitted: 'approved', committed: 'funded', set: 'done', to_treasury: 'kept', rejected: 'turned away' };
  if (outcome.startsWith('held')) return 'held';
  if (outcome.startsWith('failed')) return 'failed';
  return m[outcome] ?? outcome;
}
