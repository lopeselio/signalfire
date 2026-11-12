import { describe, expect, it } from 'vitest';
import { createWhitelist } from '../src/relay-whitelist.ts';

describe('relayer whitelist', () => {
  it('lets a startup launched after boot through, and nothing else', async () => {
    let chain = [{ token: 'glow.hub.testnet', dao: 'glow-dao.hub.testnet' }];
    let reads = 0;
    let t = 0;
    const w = createWhitelist('hub.testnet', async () => { reads++; return chain; }, 5000, () => t);
    await w.refresh();
    expect(await w.allows('hub.testnet')).toBe(true);
    expect(await w.allows('glow-dao.hub.testnet')).toBe(true);
    // a new launch: the next unknown receiver triggers a re-read
    chain = [...chain, { token: 'zap.hub.testnet', dao: 'zap-dao.hub.testnet' }];
    t = 6000;
    expect(await w.allows('zap.hub.testnet')).toBe(true);
    expect(w.has('zap-dao.hub.testnet')).toBe(true);
    // strangers stay out, and they can't make us hammer the RPC
    const before = reads;
    expect(await w.allows('evil.testnet')).toBe(false);
    expect(await w.allows('evil2.testnet')).toBe(false);
    expect(reads).toBe(before);
    t = 20_000;
    expect(await w.allows('evil.testnet')).toBe(false);
    expect(reads).toBe(before + 1);
  });
  it('snapshots add startups without a read', () => {
    const w = createWhitelist('hub.testnet', async () => [], 5000, () => 0);
    w.note([{ token: 'a.hub.testnet', dao: 'a-dao.hub.testnet' }]);
    expect(w.has('a.hub.testnet') && w.has('a-dao.hub.testnet')).toBe(true);
  });
  it('a failed read refuses instead of throwing', async () => {
    const w = createWhitelist('hub.testnet', async () => { throw new Error('rpc down'); });
    expect(await w.allows('x.testnet')).toBe(false);
  });
});
