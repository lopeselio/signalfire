import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { sha256Hex } from './measure.ts';

// NEAR AI Cloud end-to-end encryption, protocol v2 (docs.near.ai, "End-to-End Encrypted Chat Completions"):
// X25519 ECDH with the model's attested Ed25519 key (as X25519), HKDF-SHA256 (info "ed25519_encryption"),
// XChaCha20-Poly1305. Wire format: ephemeral X25519 public key (32) ‖ nonce (24) ‖ ciphertext + tag.

const INFO = utf8ToBytes('ed25519_encryption');
const keyFor = (shared: Uint8Array): Uint8Array => hkdf(sha256, shared, undefined, INFO, 32);

/**
 * Encrypts `plaintext` so only the model's TEE can read it. Returns the wire hex and the ephemeral secret:
 * whoever keeps that secret (the applicant) can later open the ciphertext to prove what it said.
 */
export function sealForModel(plaintext: string, modelEd25519PubHex: string, ephSecret: Uint8Array = randomBytes(32)): { hex: string; ephSecret: string } {
  const modelX = ed25519.utils.toMontgomery(hexToBytes(modelEd25519PubHex.replace(/^0x/, '')));
  const nonce = randomBytes(24);
  const ct = xchacha20poly1305(keyFor(x25519.getSharedSecret(ephSecret, modelX)), nonce).encrypt(utf8ToBytes(plaintext));
  return { hex: bytesToHex(concatBytes(x25519.getPublicKey(ephSecret), nonce, ct)), ephSecret: bytesToHex(ephSecret) };
}

/** Opens a ciphertext sealed to the model, given the ephemeral secret its sender kept. */
export function openSealed(wireHex: string, ephSecretHex: string, modelEd25519PubHex: string): string {
  const d = hexToBytes(wireHex);
  const eph = hexToBytes(ephSecretHex);
  if (bytesToHex(x25519.getPublicKey(eph)) !== bytesToHex(d.subarray(0, 32))) throw new Error('that secret did not seal this ciphertext');
  const modelX = ed25519.utils.toMontgomery(hexToBytes(modelEd25519PubHex.replace(/^0x/, '')));
  return new TextDecoder().decode(xchacha20poly1305(keyFor(x25519.getSharedSecret(eph, modelX)), d.subarray(32, 56)).decrypt(d.subarray(56)));
}

/** A client key pair for one request: the model encrypts its reply to the public half. */
export function clientKey(secret: Uint8Array = randomBytes(32)): { secret: string; pub: string } {
  return { secret: bytesToHex(secret), pub: bytesToHex(ed25519.getPublicKey(secret)) };
}

/** Opens a reply field the model encrypted to the client key. */
export function openReply(wireHex: string, clientSecretHex: string): string {
  const d = hexToBytes(wireHex);
  const mine = ed25519.utils.toMontgomerySecret(hexToBytes(clientSecretHex));
  return new TextDecoder().decode(xchacha20poly1305(keyFor(x25519.getSharedSecret(mine, d.subarray(0, 32))), d.subarray(32, 56)).decrypt(d.subarray(56)));
}

/** The public commitment to an applicant's private details: sha256("signalfire|private|<account>|<salt>|<text>"). */
export const privateCommitment = (account: string, salt: string, text: string): string => sha256Hex(`signalfire|private|${account}|${salt}|${text}`);
export const newSalt = (): string => bytesToHex(randomBytes(32));
