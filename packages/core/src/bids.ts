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
