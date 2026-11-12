import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { clientKey, openReply, openSealed, privateCommitment, replyChecks, sealForModel, sha256Hex, type ModelVerification } from '../src/index.ts';

describe('end-to-end encryption (NEAR AI v2)', () => {
  const model = clientKey(); // stands in for the model's Ed25519 key
  it('seals to the model; the sender’s kept secret opens it again, another secret does not', () => {
    const s = sealForModel('audience 4000', model.pub);
    expect(openSealed(s.hex, s.ephSecret, model.pub)).toBe('audience 4000');
    expect(() => openSealed(s.hex, clientKey().secret, model.pub)).toThrow();
  });
  it('the model’s secret opens a sealed message, as the TEE would (openReply is the same math)', () => {
    const s = sealForModel('hello', model.pub);
    expect(openReply(s.hex, model.secret)).toBe('hello');
  });
  it('commits to the private text with a salt', () => {
    expect(privateCommitment('a.testnet', '00', 'x')).toBe(sha256Hex('signalfire|private|a.testnet|00|x'));
    expect(privateCommitment('a.testnet', '01', 'x')).not.toBe(privateCommitment('a.testnet', '00', 'x'));
  });
  it('checks an Ed25519 reply signature against a verified signer', () => {
    const k = clientKey();
    const request = '{"m":1}';
    const response = '{"r":2}';
    const text = `M:${sha256Hex(request)}:${sha256Hex(response)}`;
    const signature = bytesToHex(ed25519.sign(utf8ToBytes(text), Uint8Array.from(Buffer.from(k.secret, 'hex'))));
    const v = { candidates: [{ signingAddress: k.pub, ok: true, checks: [], measurements: {} }] } as unknown as ModelVerification;
    const r = { model: 'M', request, response, signedText: text, signature, signingAddress: k.pub, signingAlgo: 'ed25519' };
    expect(replyChecks(r, v).every((c) => c.ok)).toBe(true);
    expect(replyChecks({ ...r, response: '{"r":3}' }, v).every((c) => c.ok)).toBe(false);
  });
});
