import { randomBytes } from 'node:crypto';
import { bidHash, fmtNear, isLookalike, parseNear, pitchHash, sha256Hex, unlocked } from '@signalfire/core';
import { call, callOn, view } from './chain.ts';
import { config, hasKey } from './config.ts';
import { ftBalance, getProposal, type Campaign, type Startup } from './hub.ts';
import { ask, jsonFrom } from './nearai.ts';
import { BRIEFS, CREATORS, FAN_COUNT, HOLDERS, SCOUT, bidPrice, fanAccount, holderApproves, holdersOf, type CreatorPersona } from './personas.ts';
import { snapshot, invalidate, type Snapshot } from './snapshot.ts';
import { addWire, getState, loadBid, pendingApplicants, saveBid, saveVetting, setPendingApplicants, setState } from './store.ts';

// The agent loop. Every tick it reads the chain and lets each agent act on what it sees:
//   scout     vets applicants (NEAR AI report, hash onchain; admission is the contract's rule)
//   creators  buy an audience brief from the scout, seal a bid with a NEAR AI pitch, reveal it
//   operator  settles auctions, cranks milestones, expires late campaigns (anyone could)
//   holders   vote on funding proposals in the DAO by a plain rule
//   fans      the simulated audience: first-time buyers through the winning creator's link
//   founder   posts the next brief for one of the operator's startups when nothing is running (paced, within budgets)
// Prices and votes are rules (personas.ts); the model only writes words.

const MARGIN_MS = 4000; // block time vs our clock
const FAN_BUY = parseNear('0.06');
const BRIEF_BUDGET_MAX = parseNear('0.12');
const BRIEF_BUDGET_MIN = parseNear('0.04');
/** the share of a treasury's free balance one brief may ask for */
const BRIEF_SHARE_BPS = 3500n;
const BRIEF_TARGET = 3;
/** gap after any brief, and between two briefs of the same startup (the demo's treasuries and fans are finite) */
const BRIEF_EVERY_MS = Number(process.env.BRIEF_EVERY_MIN ?? '45') * 60_000;
const BRIEF_SAME_STARTUP_MS = Number(process.env.BRIEF_SAME_STARTUP_MIN ?? '180') * 60_000;
const ACTIVE = ['bidding', 'proposing', 'voting', 'funded', 'propose_failed'];
const MAX_FANS = 40;

let running = false;
export interface TickOptions { autoBriefs?: boolean; only?: number }

const short = (a: string): string => a.replace(`.${config.hub}`, '');
const personaOf = (account: string): CreatorPersona | undefined => CREATORS.find((c) => c.account === account);

async function act<T>(who: string, what: string, fn: () => Promise<{ tx: string; value?: T }>, kind: string, campaign?: number): Promise<T | undefined> {
  try {
    const r = await fn();
    addWire({ who, what, tx: r.tx, kind, campaign });
    return r.value;
  } catch (e) {
    const msg = (e as Error).message;
    console.warn(`${who}: ${what} failed: ${msg}`);
    if ((e as { refused?: boolean }).refused) addWire({ who, what: `${what} — refused: ${msg.slice(0, 120)}`, kind: 'error', campaign, tx: (e as { tx?: string }).tx });
    return undefined;
  }
}

// ---------- scout ----------

export async function vet(s: Snapshot, account: string): Promise<void> {
  const app = s.applications[account];
  if (!app) return;
  const admitted = s.creators.map((c) => c.creator.account);
  const looks = admitted.filter((a) => isLookalike(account, a));
  const fallback = JSON.stringify({ summary: `${app.name}: ${app.profile}`, risks: looks.length ? [`name looks like ${looks.join(', ')}`] : [], fit: 3 });
  const proof = await ask(
    SCOUT.name,
    'You are Lens, the scout that vets marketing creators for Signalfire, a market where startups pay creators from a marketing treasury. ' +
      'Write a short, fair vetting note. Reply with JSON only: {"summary": string (max 40 words), "strengths": [string], "risks": [string], "fit": 1-5}. ' +
      'You do not decide admission: the contract does, by rule.',
    `Applicant account: ${account}\nName: ${app.name}\nProfile: ${app.profile}\nAlready admitted creators: ${admitted.join(', ') || 'none'}\n` +
      `Name check (rule): ${looks.length ? `looks like ${looks.join(', ')} - the contract will refuse it` : 'no lookalike'}`,
    fallback,
    260,
  );
  const report = proof.text;
  const reportHash = sha256Hex(report);
  saveVetting({ account, name: app.name, profile: app.profile, report, reportHash, proof, at: Date.now() });
  const out = await act<boolean>(SCOUT.name, `vetted ${short(account)} (${looks.length ? 'lookalike: refused by rule' : 'report filed'})`, () =>
    call<boolean>(SCOUT.account, 'vet_creator', { account, report_hash: reportHash }, 60), 'vet');
  if (out !== undefined) saveVetting({ account, name: app.name, profile: app.profile, report, reportHash, proof, admitted: out, at: Date.now() });
}

// ---------- creators ----------

async function seal(s: Snapshot, c: Campaign, p: CreatorPersona): Promise<void> {
  const st = s.startups.find((x) => x.id === c.startup)!;
  // buying data: an audience brief from the scout, agent to agent
  const briefs = getState<string[]>('briefs-bought', []);
  const key = `${c.id}:${p.account}`;
  if (!briefs.includes(key)) {
    setState('briefs-bought', [...briefs, key].slice(-500));
    await act(p.name, `paid ${SCOUT.name} 0.002 NEAR for an audience brief on #${c.id}`, () =>
      call(p.account, 'agent_pay', { to: SCOUT.account, amount: parseNear('0.002').toString(), memo: `audience brief #${c.id}` }, 20), 'pay', c.id);
  }
  // An opening saved earlier whose commit we never saw confirmed (an RPC error after the transaction may still have
  // landed): send the same commitment again, never a new one, or the reveal would no longer match what's onchain.
  const prev = loadBid(c.id, p.account);
  // the snapshot may predate a commit that landed (a restart or an RPC error after sending): ask the chain itself
  const onchain = await view<{ bids: { creator: string; hash: string }[] } | null>('get_campaign', { id: c.id }).catch(() => null);
  const mine = onchain?.bids.find((b) => b.creator === p.account);
  if (mine) {
    if (prev && prev.hash === mine.hash) saveBid({ ...prev, committedTx: prev.committedTx ?? 'landed' });
    else console.warn(`${p.name}: #${c.id} already has a commitment onchain that no saved opening matches; it can't be revealed`);
    return;
  }
  if (prev) {
    try {
      const r = await call(p.account, 'commit_bid', { campaign_id: c.id, hash: prev.hash }, 30);
      saveBid({ ...prev, committedTx: r.tx });
      addWire({ who: p.name, what: `sealed a bid on #${c.id} "${c.title}" (price and pitch hidden until the reveal)`, tx: r.tx, kind: 'bid', campaign: c.id });
    } catch (e) {
      // the first commit landed after all: keep the opening, the reveal will match
      if (/one bid per creator/.test((e as Error).message)) saveBid({ ...prev, committedTx: 'landed' });
      else console.warn(`${p.name}: re-sending the commitment on #${c.id} failed: ${(e as Error).message}`);
    }
    return;
  }
  const salt = randomBytes(32).toString('hex');
  const price = bidPrice(p, BigInt(c.budget), salt);
  const proof = await ask(
    p.name,
    `You are ${p.name}, a marketing creator (${p.title}; style: ${p.style}). You are bidding to run a campaign for ${st.name}. ` +
      'Write your pitch in at most 45 words: what you will make and where. No prices, no promises of returns, never call the token an investment.',
    `Brief "${c.title}": ${c.brief}\nGoal: ${c.target} new first-time buyers through your referral link (c${c.id}).\nYour profile: ${p.profile}`,
    `${p.name} will run "${c.title}" with ${p.title}: ${p.profile}`,
    140,
  );
  const pitch = proof.text.replace(/^"|"$/g, '').slice(0, 400);
  const ph = pitchHash(pitch);
  const hash = bidHash(c.id, p.account, price, ph, salt);
  saveBid({ campaign: c.id, creator: p.account, price: price.toString(), salt, pitch, pitchHash: ph, hash, proof });
  await act(p.name, `sealed a bid on #${c.id} "${c.title}" (price and pitch hidden until the reveal)`, async () => {
    const r = await call(p.account, 'commit_bid', { campaign_id: c.id, hash }, 30);
    const b = loadBid(c.id, p.account);
    if (b) saveBid({ ...b, committedTx: r.tx });
    return r;
  }, 'bid', c.id);
}

async function reveal(c: Campaign, p: CreatorPersona): Promise<void> {
  const b = loadBid(c.id, p.account);
  if (!b) return;
  await act(p.name, `revealed ${fmtNear(b.price)} NEAR on #${c.id}`, async () => {
    const r = await call(p.account, 'reveal_bid', { campaign_id: c.id, price: b.price, pitch_hash: b.pitchHash, salt: b.salt }, 30);
    saveBid({ ...b, revealedTx: r.tx });
    return r;
  }, 'reveal', c.id);
}

// ---------- holders ----------

async function vote(s: Snapshot, c: Campaign, st: Startup): Promise<void> {
  if (c.proposal_id === null) return;
  for (const h of holdersOf(st.id)) {
    if (!hasKey(`${h.account}#dao`)) continue;
    const p = await getProposal(st.dao, c.proposal_id);
    if (!p || p.status !== 'InProgress') return;
    if (p.votes[h.account]) continue;
    const rep = s.creators.find((x) => x.creator.account === c.winner)?.rep_bps ?? 0;
    const yes = holderApproves(h, BigInt(c.price), BigInt(st.available), rep);
    await act(h.name, `${yes ? 'voted YES' : 'voted NO'} in ${short(st.dao)} on proposal ${c.proposal_id}: fund #${c.id} at ${fmtNear(c.price)} NEAR`, () =>
      callOn(`${h.account}#dao`, st.dao, 'act_proposal', { id: c.proposal_id, action: yes ? 'VoteApprove' : 'VoteReject', proposal: p.kind }, 150), 'vote', c.id);
  }
}

// ---------- the audience ----------

/** Can this fan's hub wallet pay for one buy right now (balance, per-transaction and 24-hour caps)? */
function canBuy(s: Snapshot, f: string): boolean {
  const w = s.wallets[f];
  if (!w) return false;
  const daySpent = Date.now() - w.day_start_ms >= 24 * 3600_000 ? 0n : BigInt(w.day_spent);
  return BigInt(w.balance) >= FAN_BUY && BigInt(w.cap_tx) >= FAN_BUY && daySpent + FAN_BUY <= BigInt(w.cap_day);
}

/** Fans who could still be first-time buyers of this startup today. */
function fansReady(s: Snapshot, st: Startup): number {
  const used = new Set(getState<string[]>(`fans-${st.id}`, []));
  const count = getState<number>('fan-count', FAN_COUNT);
  let n = 0;
  for (let i = 1; i <= count; i++) {
    const f = fanAccount(i);
    if (!used.has(f) && !s.buyers[`${st.id}|${f}`] && hasKey(f) && canBuy(s, f)) n++;
  }
  return n;
}

async function nextFan(st: Startup, s: Snapshot): Promise<string | null> {
  const used = new Set(getState<string[]>(`fans-${st.id}`, []));
  const count = getState<number>('fan-count', FAN_COUNT);
  for (let i = 1; i <= count; i++) {
    const f = fanAccount(i);
    if (used.has(f) || !hasKey(f)) continue;
    if (s.buyers[`${st.id}|${f}`]) { used.add(f); continue; }
    if (!canBuy(s, f)) continue;
    return f;
  }
  // out of fans: the hub owner opens a few more (each is a fresh first-time buyer)
  if (count < MAX_FANS && hasKey(config.hub)) {
    const { ensureAgent } = await import('./setup.ts');
    for (let i = count + 1; i <= Math.min(MAX_FANS, count + 3); i++) {
      await ensureAgent(fanAccount(i).split('.')[0], { balance: '0.09', wallet: '0.08', capTx: '0.07', capDay: '0.08' }).catch((e) => console.warn(`fan ${i}: ${(e as Error).message}`));
    }
    setState('fan-count', Math.min(MAX_FANS, count + 3));
    addWire({ who: 'Signalfire', what: 'opened 3 more fan accounts for the simulated audience', kind: 'setup' });
  }
  setState(`fans-${st.id}`, [...used]);
  return null;
}

async function audience(s: Snapshot, c: Campaign, st: Startup): Promise<void> {
  const f = await nextFan(st, s);
  if (!f) return;
  const used = getState<string[]>(`fans-${st.id}`, []);
  setState(`fans-${st.id}`, [...used, f]);
  const winner = personaOf(c.winner ?? '')?.name ?? short(c.winner ?? '');
  await act(short(f), `bought ${fmtNear(FAN_BUY)} NEAR of ${st.id.toUpperCase()} through ${winner}'s link (c${c.id})`, () =>
    call(f, 'buy_with_wallet', { startup: st.id, amount: FAN_BUY.toString(), min_tokens_out: '0', ref_code: `c${c.id}` }, 60), 'buy', c.id);
}

// ---------- the loop ----------

async function campaignStep(s: Snapshot, c: Campaign, opts: TickOptions): Promise<void> {
  const st = s.startups.find((x) => x.id === c.startup);
  if (!st) return;
  const now = Date.now();
  if (c.phase === 'bidding') {
    if (now < c.commit_ends_ms - MARGIN_MS) {
      for (const p of CREATORS) {
        const cr = s.creators.find((x) => x.creator.account === p.account);
        if (!cr || cr.creator.revoked || !hasKey(p.account)) continue;
        if (c.bids.some((b) => b.creator === p.account)) continue;
        // a bid's opening is saved before it's sent: don't seal twice if the commit is still landing
        if (loadBid(c.id, p.account)?.committedTx) continue;
        await seal(s, c, p);
      }
    } else if (now >= c.commit_ends_ms + MARGIN_MS && now < c.reveal_ends_ms - MARGIN_MS) {
      for (const b of c.bids) {
        const p = personaOf(b.creator);
        if (p && !b.revealed && hasKey(p.account)) await reveal(c, p);
      }
    } else if (now >= c.reveal_ends_ms + MARGIN_MS) {
      await act('Signalfire', `settled the auction for #${c.id} and filed the funding proposal in ${short(st.dao)}`, () =>
        call(config.operator, 'settle_auction', { campaign_id: c.id }, 100), 'settle', c.id);
    }
  } else if (c.phase === 'propose_failed' && now >= c.reveal_ends_ms) {
    await act('Signalfire', `re-filed the funding proposal for #${c.id}`, () => call(config.operator, 'settle_auction', { campaign_id: c.id }, 100), 'settle', c.id);
  } else if (c.phase === 'voting') {
    await vote(s, c, st);
  } else if (c.phase === 'funded') {
    if (c.deadline_ms && now > c.deadline_ms + MARGIN_MS) {
      await act('Signalfire', `expired #${c.id} (${c.results}/${c.target} results): the unpaid part returns to the treasury`, () =>
        call(config.operator, 'expire_campaign', { campaign_id: c.id }, 30), 'expire', c.id);
      return;
    }
    if (unlocked(c.target, c.results) > c.milestones_paid) {
      const k = c.milestones_paid + 1;
      // a held payout is logged onchain each try: wait 5 minutes before asking the policy again
      const heldAt = getState<Record<string, number>>('held', {})[`${c.id}`] ?? 0;
      if (Date.now() - heldAt < 5 * 60_000) return;
      const out = await act<string>('Signalfire', `claimed milestone ${k} of #${c.id} for ${personaOf(c.winner ?? '')?.name ?? short(c.winner ?? '')}`, () =>
        call<string>(config.operator, 'claim_milestone', { campaign_id: c.id }, 120), 'payout', c.id);
      if (out && out !== 'paid') {
        addWire({ who: 'spend policy', what: `held milestone ${k} of #${c.id}: ${out}`, kind: 'held', campaign: c.id });
        setState('held', { ...getState<Record<string, number>>('held', {}), [`${c.id}`]: Date.now() });
      }
      return;
    }
    if (c.results < c.target && (opts.only === undefined || opts.only === c.id)) await audience(s, c, st);
  }
}

async function founder(s: Snapshot): Promise<void> {
  if (!hasKey(config.operator)) return;
  // the operator's startups with briefs written for them; one campaign at a time across all of them
  const mine = s.startups.filter((st) => st.founder === config.operator && st.status === 'live' && BRIEFS[st.id]?.length);
  if (s.campaigns.some((c) => mine.some((st) => st.id === c.startup) && ACTIVE.includes(c.phase))) return;
  const now = Date.now();
  if (now - getState<number>('last-brief', 0) < BRIEF_EVERY_MS) return;
  const lastBy = getState<Record<string, number>>('last-brief-by', {});
  // the startup that waited longest goes first
  for (const st of [...mine].sort((a, b) => (lastBy[a.id] ?? 0) - (lastBy[b.id] ?? 0))) {
    if (now - (lastBy[st.id] ?? 0) < BRIEF_SAME_STARTUP_MS) continue;
    let budget = (BigInt(st.available) * BRIEF_SHARE_BPS) / 10_000n;
    if (budget > BRIEF_BUDGET_MAX) budget = BRIEF_BUDGET_MAX;
    if (budget > BigInt(st.constraints.campaign_cap)) budget = BigInt(st.constraints.campaign_cap);
    budget -= budget % parseNear('0.01');
    if (budget < BRIEF_BUDGET_MIN) continue;
    // don't open a campaign the simulated audience can't finish
    if (fansReady(s, st) < BRIEF_TARGET) continue;
    const posted = getState<Record<string, number>>('briefs-posted-by', {});
    const n = posted[st.id] ?? (st.id === config.demo ? getState<number>('briefs-posted', 0) : 0);
    const list = BRIEFS[st.id];
    const b = list[n % list.length];
    setState('last-brief', now);
    setState('last-brief-by', { ...lastBy, [st.id]: now });
    const id = await act<number>(`${st.name} founder`, `posted brief "${b.title}": ${fmtNear(budget)} NEAR budget for ${BRIEF_TARGET} new holders`, () =>
      call<number>(config.operator, 'create_campaign', {
        startup: st.id, title: b.title, brief: b.brief, target: BRIEF_TARGET, budget: budget.toString(), commit_secs: 90, reveal_secs: 60, duration_secs: 3600,
      }, 30), 'brief');
    if (id !== undefined) setState('briefs-posted-by', { ...posted, [st.id]: n + 1 });
    return;
  }
}

/** One pass of every agent. Safe to call often; only one runs at a time. */
export async function tick(opts: TickOptions = {}): Promise<void> {
  if (running) return;
  running = true;
  try {
    invalidate();
    const s = await snapshot();
    // the scout: the agent creators' applications and anyone who applied through the web app
    const applicants = new Set([...CREATORS.map((c) => c.account), ...pendingApplicants()]);
    for (const a of applicants) if (s.applications[a] && hasKey(SCOUT.account)) await vet(s, a);
    setPendingApplicants(pendingApplicants().filter((a) => !s.creators.some((c) => c.creator.account === a) && s.applications[a] !== undefined));
    for (const c of s.campaigns) {
      if (['done', 'expired', 'no_bids'].includes(c.phase)) continue;
      if (opts.only !== undefined && c.id !== opts.only && c.phase === 'funded') continue;
      await campaignStep(s, c, opts);
    }
    if (opts.autoBriefs ?? config.autoBriefs) await founder(s);
  } catch (e) {
    console.warn(`agents: ${(e as Error).message}`);
  } finally {
    invalidate();
    running = false;
  }
}

export function startAgents(): void {
  if (!config.agents) return;
  if (!hasKey(config.operator)) { console.warn(`agents off: no key for ${config.operator}`); return; }
  const loop = async (): Promise<void> => {
    await tick();
    setTimeout(() => void loop(), config.tickMs).unref();
  };
  void loop();
  console.log(`agents on: ${CREATORS.length} creators, the scout, ${HOLDERS.length} holders, the audience (tick ${config.tickMs} ms)`);
}

