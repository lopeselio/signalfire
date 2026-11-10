import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';
import type { Signed } from './nearai.ts';

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
  committedTx?: string;
  revealedTx?: string;
}
const bidFile = (campaign: number, creator: string): string => join(dir('bids'), `${campaign}-${creator}.json`);
export const saveBid = (b: BidSecret): void => write(bidFile(b.campaign, b.creator), b);
export const loadBid = (campaign: number, creator: string): BidSecret | null => read<BidSecret>(bidFile(campaign, creator));
export function bidsFor(campaign: number): BidSecret[] {
  return readdirSync(dir('bids')).filter((f) => f.startsWith(`${campaign}-`) && f.endsWith('.json')).map((f) => read<BidSecret>(join(dir('bids'), f))).filter((b): b is BidSecret => !!b);
}

/** The scout's vetting report for a creator, with its NEAR AI proof. reportHash = sha256Hex(report text). */
export interface Vetting { account: string; name: string; profile: string; report: string; reportHash: string; proof: Signed; tx?: string; admitted?: boolean; at: number }
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
