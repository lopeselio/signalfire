import { sha256Hex } from '@signalfire/core';
import { sub } from './config.ts';

// The AI agents. Each is a sub-account of the hub with function-call keys only (pnpm setup creates them).
// What they bid and how holders vote are plain rules here; NEAR AI only writes the words.

export interface CreatorPersona { name: string; account: string; title: string; profile: string; style: string; /** bid as a share of the budget, ±10% */ bidShare: number }

export const CREATORS: CreatorPersona[] = [
  { name: 'Nova', account: sub('creator-nova'), title: 'short-form video', profile: 'Short vertical videos: night-time study vlogs and campus walk-throughs, 12k followers.', style: 'warm, visual, quick cuts', bidShare: 0.7 },
  { name: 'Quill', account: sub('creator-quill'), title: 'threads and newsletters', profile: 'Writes a weekly student-life newsletter and long X threads; 4k subscribers.', style: 'dry, precise, lists', bidShare: 0.55 },
  { name: 'Ember', account: sub('creator-ember'), title: 'campus events', profile: 'Runs pop-up study nights with campus clubs and hands out referral cards.', style: 'energetic, in person', bidShare: 0.85 },
];

/** An impostor whose name is one look-alike character away from Nova: the contract refuses it by rule. */
export const IMPOSTOR = { name: 'N0va', account: sub('creator-n0va'), profile: 'Official Nova backup account. Same videos, new wallet.' };

export const SCOUT = { name: 'Lens', account: sub('scout-lens') };

export interface HolderPersona {
  name: string; account: string; /** the startup whose DAO it votes in (its second key only works there) */ startup: string;
  /** the most of the free treasury this holder lets one campaign take */ maxShare: number; /** lowest creator reputation it backs (bps) */ minRep: number;
}
export const HOLDERS: HolderPersona[] = [
  { name: 'Ada', account: sub('holder-ada'), startup: 'glow', maxShare: 0.8, minRep: -1000 },
  { name: 'Bo', account: sub('holder-bo'), startup: 'glow', maxShare: 0.5, minRep: 0 },
  { name: 'Cy', account: sub('holder-cy'), startup: 'glow', maxShare: 0.9, minRep: -2000 },
  { name: 'Dee', account: sub('holder-dee'), startup: 'fern', maxShare: 0.8, minRep: -1000 },
  { name: 'Eli', account: sub('holder-eli'), startup: 'fern', maxShare: 0.6, minRep: 0 },
  { name: 'Fay', account: sub('holder-fay'), startup: 'fern', maxShare: 0.9, minRep: -2000 },
  { name: 'Gus', account: sub('holder-gus'), startup: 'loop', maxShare: 0.8, minRep: -1000 },
  { name: 'Hal', account: sub('holder-hal'), startup: 'loop', maxShare: 0.6, minRep: 0 },
  { name: 'Ivy', account: sub('holder-ivy'), startup: 'loop', maxShare: 0.9, minRep: -2000 },
  { name: 'Jo', account: sub('holder-jo'), startup: 'kiln', maxShare: 0.8, minRep: -1000 },
  { name: 'Kai', account: sub('holder-kai'), startup: 'kiln', maxShare: 0.6, minRep: 0 },
  { name: 'Lu', account: sub('holder-lu'), startup: 'kiln', maxShare: 0.9, minRep: -2000 },
];
export const holdersOf = (startup: string): HolderPersona[] => HOLDERS.filter((h) => h.startup === startup);

export const FAN_COUNT = 12;
export const fanAccount = (i: number): string => sub(`fan-${String(i).padStart(2, '0')}`);

/** A creator's price: its share of the budget, moved ±10% by its salt (so bids differ run to run). */
export function bidPrice(p: CreatorPersona, budget: bigint, salt: string): bigint {
  const jitter = (parseInt(sha256Hex(salt).slice(0, 4), 16) / 0xffff) * 0.2 - 0.1;
  const bps = Math.round((p.bidShare + jitter) * 10_000);
  return (budget * BigInt(Math.max(500, Math.min(10_000, bps)))) / 10_000n;
}

/** A holder's vote on a funding proposal: a plain rule, not the model. */
export function holderApproves(h: HolderPersona, price: bigint, available: bigint, rep: number): boolean {
  return rep >= h.minRep && price * 10_000n <= available * BigInt(Math.round(h.maxShare * 10_000));
}

/**
 * The demo startups the operator runs for fictional founders (pnpm seed-demo launches the ones that don't exist).
 * Products and people are made up. The token is attention, not ownership: pitches never promise anything.
 */
export interface DemoStartup { id: string; name: string; pitch: string }
export const DEMO_STARTUPS: DemoStartup[] = [
  { id: 'fern', name: 'Fernbook', pitch: 'Fernbook lets students on the same campus swap last term’s textbooks for next term’s, matched by course code. Its attention token funds campaigns that bring new swappers in.' },
  { id: 'loop', name: 'Looproom', pitch: 'Looproom fills five-a-side football games: open pitches nearby, a waiting list, and a nudge when one player short. Its attention token funds campaigns that find new players.' },
  { id: 'kiln', name: 'Kilnday', pitch: 'Kilnday books open studio hours at community pottery studios, wheel and kiln time included. Its attention token funds campaigns that bring first-time potters in.' },
];

/** Briefs the founder agent posts, per startup, in turn. Each asks for new first-time buyers through the creator's link. */
export const BRIEFS: Record<string, { title: string; brief: string }[]> = {
  glow: [
    { title: 'Three study groups for exam week', brief: 'Bring 3 new study groups to Glowpath during exam week: show them the quiet spots still open after midnight near campus. Each first-time GLOW buyer through your link counts.' },
    { title: 'Library closing time', brief: 'Reach students who get sent home when the library closes at 11 and show them the nearest place that is still open and quiet. First-time GLOW buyers through your link count.' },
    { title: 'First-years’ first late night', brief: 'Help first-years find their first late-night study spot in their first month. Three new GLOW holders through your link complete the campaign.' },
    { title: 'Night-shift nursing students', brief: 'Nursing students study around shifts. Show them the 24-hour spots on Glowpath near the teaching hospital. New GLOW holders through your link count.' },
  ],
  fern: [
    { title: 'Spring-term textbook swap', brief: 'Bring 3 new swappers to Fernbook before the spring term starts: students who still have last term’s books on the shelf. First-time FERN buyers through your link count.' },
    { title: 'Engineering first-years', brief: 'First-year engineering lists are expensive. Show first-years how to swap for the set books by course code on Fernbook. Three new FERN holders through your link complete the campaign.' },
    { title: 'Move-out week', brief: 'During move-out week, reach students about to throw books away and get them listed on Fernbook instead. New FERN buyers through your link count.' },
  ],
  loop: [
    { title: 'One player short on Thursday', brief: 'Bring 3 new players to Looproom’s Thursday evening games, the night most games end up one player short. First-time LOOP buyers through your link count.' },
    { title: 'New-in-town footballers', brief: 'Reach people who just moved to the city and miss their weekly game. Show them the open pitches and waiting lists near them. New LOOP holders through your link count.' },
    { title: 'Lunchtime five-a-side', brief: 'Office workers near the river pitches want a lunchtime game. Get 3 of them onto Looproom’s waiting list. First-time LOOP buyers through your link count.' },
  ],
  kiln: [
    { title: 'First wheel session', brief: 'Bring 3 first-time potters to Kilnday for an open wheel session at a community studio. First-time KILN buyers through your link count.' },
    { title: 'Weekend studio hours', brief: 'Reach people looking for something to do with their hands on a Sunday and show them open studio hours near them. New KILN holders through your link count.' },
    { title: 'Glaze night regulars', brief: 'Studios run glaze nights that half-fill. Bring 3 new people who would come back every month. First-time KILN buyers through your link count.' },
  ],
};
