import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { recoverAddress, replayRtmr3, replyChecks, verifyReport, type AttestationReport, type SignedReply } from '../src/index.ts';

const fx = (f: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const report = fx('report.json') as AttestationReport;
const collateral = fx('collateral.json');
const reply = fx('reply.json') as SignedReply;
// The report was fetched live on 2026-11-12 with this nonce; the collateral at the same time.
const NONCE = '281696d5ee2c0771d0757de7d536d6e44c0c99a6b5d6faf03ea39b6d12ac62b4';
const MODEL = 'Qwen/Qwen3.6-35B-A3B-FP8';
const NOW = 1794484300;
const opts = { collateral: async () => collateral as never, nowSecs: NOW, skipGpu: true };

describe('NEAR AI model attestation', () => {
  it('verifies a live report: Intel quote, signer + nonce binding, MRCONFIGID, RTMR3', async () => {
    const v = await verifyReport(report, MODEL, NONCE, opts);
    for (const c of v.candidates[0].checks) expect(c.ok, `${c.id}: ${c.detail ?? ''}`).toBe(true);
    expect(v.trustedSigners).toEqual(['0xfdbd7952498b333206f360d71d97a1e0961e8ddf']);
  });
  it('fails a different nonce (a replayed report)', async () => {
    const v = await verifyReport(report, MODEL, '00'.repeat(32), opts);
    expect(v.ok).toBe(false);
    expect(v.candidates[0].checks.find((c) => c.id === 'binding.nonce')!.ok).toBe(false);
  });
  it('fails a tampered event log or compose', async () => {
    const a = structuredClone(report.model_attestations![0]);
    const log = typeof a.event_log === 'string' ? JSON.parse(a.event_log) : a.event_log;
    const ev = log.find((e: { imr: number; event: string }) => e.imr === 3 && e.event === 'compose-hash');
    ev.event_payload = 'ab'.repeat(32);
    ev.digest = '';
    a.event_log = log;
    const tcb = typeof a.info.tcb_info === 'string' ? JSON.parse(a.info.tcb_info) : a.info.tcb_info;
    a.info.tcb_info = { ...tcb, app_compose: `${tcb.app_compose} ` };
    const v = await verifyReport({ model_attestations: [a] }, MODEL, NONCE, opts);
    expect(v.candidates[0].checks.find((c) => c.id === 'rtmr3')!.ok).toBe(false);
    expect(v.candidates[0].checks.find((c) => c.id === 'compose')!.ok).toBe(false);
  });
  it('replays RTMR3 to 48 bytes', () => {
    expect(replayRtmr3(report.model_attestations![0].event_log).length).toBe(48);
  });
});

describe('reply signatures', () => {
  it('recovers the TEE signer and matches the verified report', async () => {
    expect(recoverAddress(reply.signedText!, reply.signature!)).toBe(reply.signingAddress!.toLowerCase());
    const v = await verifyReport(report, MODEL, NONCE, opts);
    expect(replyChecks(reply, v).every((c) => c.ok)).toBe(true);
  });
  it('rejects an edited reply', async () => {
    const v = await verifyReport(report, MODEL, NONCE, opts);
    const edited = { ...reply, response: reply.response.replace('Nova', 'Novaa') };
    expect(replyChecks(edited, v).find((c) => c.id === 'reply.payload')!.ok).toBe(false);
  });
});
