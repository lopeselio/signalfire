import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

// Sealed bids. The strings are byte for byte the ones contracts/hub/src/lib.rs builds.

export const sha256Hex = (s: string): string => bytesToHex(sha256(utf8ToBytes(s)));

/** A campaign pitch is sealed by its hash inside the bid and published at reveal. */
export const pitchHash = (pitch: string): string => sha256Hex(`signalfire|pitch|${pitch}`);

/** sha256("signalfire|bid|<campaign>|<creator>|<price yocto>|<pitch hash>|<salt>") */
export const bidHash = (campaign: number, creator: string, price: bigint, pitch: string, salt: string): string =>
  sha256Hex(`signalfire|bid|${campaign}|${creator}|${price.toString()}|${pitch}|${salt}`);

export const isHex32 = (s: string): boolean => /^[0-9a-f]{64}$/.test(s);

/** Everything needed to reveal a sealed bid. Agents keep it on the server; people keep it in their browser. */
export interface BidOpening { campaign: number; creator: string; price: string; pitch: string; pitchHash: string; salt: string; hash: string }

/** Seals a bid: the pitch hash and the commitment, exactly as the hub recomputes them at reveal. */
export function sealBid(campaign: number, creator: string, price: bigint, pitch: string, salt: string): BidOpening {
  const ph = pitchHash(pitch);
  return { campaign, creator, price: price.toString(), pitch, pitchHash: ph, salt, hash: bidHash(campaign, creator, price, ph, salt) };
}

/** Does an opening hash to its pitch hash and commitment (and, if given, to the commitment onchain)? */
export function openingMatches(o: BidOpening, onchainHash?: string): boolean {
  if (!/^\d{1,40}$/.test(o.price) || o.salt.length === 0 || o.salt.length > 128) return false;
  if (pitchHash(o.pitch) !== o.pitchHash) return false;
  const h = bidHash(o.campaign, o.creator, BigInt(o.price), o.pitchHash, o.salt);
  return h === o.hash && (onchainHash === undefined || h === onchainHash);
}

/** Which step of a sealed-bid auction a campaign is in. Mirrors commit_bid / reveal_bid / settle_auction. */
export type BidStage = 'commit' | 'reveal' | 'settle' | 'closed';
export function bidStage(c: { phase: string; commit_ends_ms: number; reveal_ends_ms: number }, nowMs: number): BidStage {
  if (c.phase !== 'bidding') return 'closed';
  if (nowMs < c.commit_ends_ms) return 'commit';
  if (nowMs < c.reveal_ends_ms) return 'reveal';
  return 'settle';
}
