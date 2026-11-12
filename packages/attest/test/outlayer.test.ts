import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { outlayerTaskHash, verifyOutlayerRun, type OutlayerAttestation } from '../src/index.ts';

const fx = (f: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
// A real run on outlayer.testnet (request 31472, 2026-11-12): the scorer's public_key op, asked by signalfire-ref.testnet.
const att = fx('outlayer-attestation.json') as OutlayerAttestation;
const collateral = fx('outlayer-collateral.json');
const base = {
  wasmHash: '36e28ec9e6bcd127b8cdd5d7b7a34b1e4047a8661fae895cba6b5947749ddff3',
  input: '{"op":"public_key"}',
  output: '{"op":"public_key","public_key":"44f468700cdec813df76b469d073d615c06ed9a2bb1a759c7cf4437a877de57c"}',
  caller: 'signalfire-ref.testnet',
  approved: async () => true,
  collateral: async () => collateral as never,
  nowSecs: 1794490767,
};

describe('OutLayer run attestations', () => {
  it('recomputes the task hash the quote carries, and checks code, input, output and caller', async () => {
    expect(outlayerTaskHash(att)).toBe('3245a41f030d55bfd2ba394ba3c6842ce01c5bceb2643b0e2ece46e14361f982');
    const { checks, measurements } = await verifyOutlayerRun(att, base);
    for (const c of checks) expect(c.ok, `${c.id} ${c.detail ?? ''}`).toBe(true);
    expect(measurements?.rtmr3).toBe(att.worker_measurement);
  });
  it('fails another output, another caller, a measurement not on the allowlist', async () => {
    const r = await verifyOutlayerRun(att, { ...base, output: '{"op":"public_key","public_key":"00"}', caller: 'mallory.testnet', approved: async () => false });
    const bad = r.checks.filter((c) => !c.ok).map((c) => c.id).sort();
    expect(bad).toEqual(['ol.caller', 'ol.measurements', 'ol.output']);
  });
  it('fails a tampered field (the task hash no longer matches the quote)', async () => {
    const r = await verifyOutlayerRun({ ...att, input_hash: '00'.repeat(32) }, base);
    expect(r.checks.find((c) => c.id === 'ol.task')!.ok).toBe(false);
  });
});
