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

export interface HolderPersona { name: string; account: string; /** the most of the free treasury this holder lets one campaign take */ maxShare: number; /** lowest creator reputation it backs (bps) */ minRep: number }
export const HOLDERS: HolderPersona[] = [
  { name: 'Ada', account: sub('holder-ada'), maxShare: 0.8, minRep: -1000 },
  { name: 'Bo', account: sub('holder-bo'), maxShare: 0.5, minRep: 0 },
  { name: 'Cy', account: sub('holder-cy'), maxShare: 0.9, minRep: -2000 },
];

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

/** Briefs the founder agent posts for the demo startup, in turn. */
export const BRIEFS = [
  { title: 'Night owls', brief: 'Bring students who study after midnight to try Glowpath and buy a little GLOW through your link.' },
  { title: 'Exam week', brief: 'During exams, show students the quietest open spots near them. Each new GLOW holder through your link counts.' },
  { title: 'Library closing time', brief: 'Reach students kicked out at closing time with the nearest place still open. New holders through your link count.' },
  { title: 'Freshers', brief: 'Help first-years find their first late-night study spot. New GLOW holders through your link count.' },
];
