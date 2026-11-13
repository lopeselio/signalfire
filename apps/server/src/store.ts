import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';
import type { Signed } from './nearai.ts';
import type { PrivateVerdict } from './verdict.ts';
import type { TourMemory, TourStore } from './tour.ts';

// JSON records under DATA_DIR (an Azure Files share when hosted). Everything that moves money is onchain;
// these files keep what the chain only holds a hash of: sealed bid openings (secret until the reveal),
// pitches, vetting reports and their NEAR AI proofs, and the agents' activity feed.

function dir(name: string): string {
  const d = join(config.dataDir, name);
  mkdirSync(d, { recursive: true });
  return d;
}

function write(file: string, v: unknown): void {
  writeFileSync(`${file}.tmp`, JSON.stringify(v, null, 1));
  renameSync(`${file}.tmp`, file);
}
function read<T>(file: string): T | null {
  try { return JSON.parse(readFileSync(file, 'utf8')) as T; } catch { return null; }
}

/** A creator agent's sealed bid: the opening stays here until the reveal window. */
export interface BidSecret {
  campaign: number;
  creator: string;
  price: string;
  salt: string;
  pitch: string;
  pitchHash: string;
  hash: string;
  proof: Signed;
  /** a person's bid, sealed in their browser: the opening reached us only after the reveal, and no model wrote the pitch */
  human?: boolean;
  committedTx?: string;
  revealedTx?: string;
  /** sealed to the OutLayer scorer's key (never revealed; the TEE scores it): the ciphertext posted onchain */
  sealed?: boolean;
  ciphertext?: string;
}
const bidFile = (campaign: number, creator: string): string => join(dir('bids'), `${campaign}-${creator}.json`);
export const saveBid = (b: BidSecret): void => write(bidFile(b.campaign, b.creator), b);
export const loadBid = (campaign: number, creator: string): BidSecret | null => read<BidSecret>(bidFile(campaign, creator));
export function bidsFor(campaign: number): BidSecret[] {
  return readdirSync(dir('bids')).filter((f) => f.startsWith(`${campaign}-`) && f.endsWith('.json')).map((f) => read<BidSecret>(join(dir('bids'), f))).filter((b): b is BidSecret => !!b);
}

/** The scout's vetting report for a creator, with its NEAR AI proof. reportHash = sha256Hex(report text). */
export interface Vetting {
  account: string; name: string; profile: string; report: string; reportHash: string; proof: Signed; tx?: string; admitted?: boolean; at: number;
  /** a private application: sha256 commitment to the details the applicant sealed to the model (never seen here) */
  privateCommitment?: string;
  /** the model's verdict on the private details: a score and fixed phrases only (a JSON schema forces it), so the
   *  public record can't repeat the details */
  privateVerdict?: PrivateVerdict;
  /** the end-to-end encrypted call that produced the verdict, with its Ed25519 TEE signature */
  privateProof?: Signed;
  /** the private details were submitted but could not reach the model (NEAR AI off or failing): they were dropped unread */
  privateDropped?: boolean;
}

/**
 * A private application waiting for the scout: ciphertext sealed in the applicant's browser to the model's
 * attested key, which this server can't open. Removed as soon as the scout's call is made.
 */
export interface PrivateApp { account: string; sealed: string; modelPub: string; commitment: string; at: number }
const privFile = (account: string): string => join(dir('private'), `${account}.json`);
export const savePrivateApp = (p: PrivateApp): void => write(privFile(p.account), p);
export const loadPrivateApp = (account: string): PrivateApp | null => read<PrivateApp>(privFile(account));
export function dropPrivateApp(account: string): void {
  try { unlinkSync(privFile(account)); } catch { /* already gone */ }
}
const vetFile = (account: string): string => join(dir('vetting'), `${account}.json`);
export const saveVetting = (v: Vetting): void => write(vetFile(v.account), v);
export const loadVetting = (account: string): Vetting | null => read<Vetting>(vetFile(account));

/** Accounts that applied through the web app and wait for the scout. */
export function pendingApplicants(): string[] {
  return read<string[]>(join(dir('state'), 'applicants.json')) ?? [];
}
export function setPendingApplicants(list: string[]): void {
  write(join(dir('state'), 'applicants.json'), [...new Set(list)].slice(-200));
}

/** The wire: what the agents did, newest first. */
export interface WireItem { at: number; who: string; what: string; tx?: string; campaign?: number; kind: string }
const wireFile = (): string => join(dir('state'), 'wire.json');
let wire: WireItem[] | null = null;
export function getWire(): WireItem[] {
  wire ??= read<WireItem[]>(wireFile()) ?? [];
  return wire;
}
export function addWire(item: Omit<WireItem, 'at'>): void {
  const list = getWire();
  list.unshift({ at: Date.now(), ...item });
  wire = list.slice(0, 300);
  write(wireFile(), wire);
}

/** Small key-value state for the agent loop (which fans were used, briefs posted, ...). */
export function getState<T>(key: string, d: T): T {
  return read<T>(join(dir('state'), `${key}.json`)) ?? d;
}
export function setState(key: string, v: unknown): void {
  write(join(dir('state'), `${key}.json`), v);
}

// ---------- the onboarding tour's memory per signed-in account (tour.ts) ----------

const tourFile = (account: string): string => join(dir('tour'), `${account.replace(/[^a-z0-9._-]/gi, '_').slice(0, 80)}.json`);
export const tourStore: TourStore = {
  load: (account) => read<TourMemory>(tourFile(account)),
  save: (account, m) => write(tourFile(account), m),
};
