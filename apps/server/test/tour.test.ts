import { describe, expect, it } from 'vitest';
import { LIMITS, mergeTour, rateLimiter, sanitizeTour, tourRoute, type TourMemory, type TourStore } from '../src/tour.ts';

const mem = (): TourStore & { data: Map<string, TourMemory> } => {
  const data = new Map<string, TourMemory>();
  return { data, load: (a) => data.get(a) ?? null, save: (a, m) => { data.set(a, m); } };
};
const always = (): boolean => true;

describe('tour memory', () => {
  it('drops malformed fields', () => {
    const t = sanitizeTour({ path: 'nope', tour: { path: 'back', index: -1 }, seen: ['x-fire', 'BAD ID', 7, 'x-fire'], hints: ['curve'] }, 1);
    expect(t).toEqual({ path: null, tour: null, seen: ['x-fire'], hints: ['curve'], at: 1 });
    expect(sanitizeTour({ path: 'create', tour: { path: 'create', index: 3 } }, 2).tour).toEqual({ path: 'create', index: 3 });
    expect(sanitizeTour(null, 0).seen).toEqual([]);
  });

  it('merges seen steps as a union and keeps the latest position', () => {
    const a = sanitizeTour({ path: 'explore', tour: { path: 'explore', index: 4 }, seen: ['x-fire', 'x-wire'] }, 1);
    const b = sanitizeTour({ path: 'create', tour: null, seen: ['x-ledger'], hints: ['dao'] }, 2);
    const m = mergeTour(a, b);
    expect(m.seen.sort()).toEqual(['x-fire', 'x-ledger', 'x-wire']);
    expect(m.path).toBe('create');
    expect(m.tour).toBeNull();
    expect(m.hints).toEqual(['dao']);
  });

  it('caps the number of ids', () => {
    const many = Array.from({ length: LIMITS.ids + 50 }, (_, i) => `s-${i}`);
    expect(sanitizeTour({ seen: many }, 0).seen).toHaveLength(LIMITS.ids);
  });

  it('rate-limits writes per account per minute', () => {
    const allow = rateLimiter(2);
    expect([allow('a', 0), allow('a', 1), allow('a', 2), allow('b', 3)]).toEqual([true, true, false, true]);
    expect(allow('a', 60_000)).toBe(true);
  });
});

describe('GET/PUT /api/me/tour', () => {
  it('needs a session', () => {
    expect(tourRoute('GET', null, null, 0, mem(), always).code).toBe(401);
    expect(tourRoute('PUT', null, '{}', 0, mem(), always).code).toBe(401);
  });

  it('returns an empty record before the first write, then the stored one', () => {
    const s = mem();
    expect(tourRoute('GET', 'sushiman1.testnet', null, 0, s, always).body).toEqual({ path: null, tour: null, seen: [], hints: [], at: 0 });
    expect(tourRoute('PUT', 'sushiman1.testnet', JSON.stringify({ path: 'explore', seen: ['x-fire'] }), 5, s, always).code).toBe(200);
    expect(tourRoute('PUT', 'sushiman1.testnet', JSON.stringify({ path: 'explore', seen: ['x-wire'] }), 6, s, always).code).toBe(200);
    const got = tourRoute('GET', 'sushiman1.testnet', null, 7, s, always).body as TourMemory;
    expect(got.seen.sort()).toEqual(['x-fire', 'x-wire']);
    // another account sees nothing of it
    expect((tourRoute('GET', 'other.testnet', null, 7, s, always).body as TourMemory).seen).toEqual([]);
  });

  it('refuses oversized, malformed and too frequent writes', () => {
    const s = mem();
    expect(tourRoute('PUT', 'a.testnet', null, 0, s, always).code).toBe(413);
    expect(tourRoute('PUT', 'a.testnet', 'x'.repeat(LIMITS.bytes + 1), 0, s, always).code).toBe(413);
    expect(tourRoute('PUT', 'a.testnet', '{not json', 0, s, always).code).toBe(400);
    expect(tourRoute('PUT', 'a.testnet', '{}', 0, s, () => false).code).toBe(429);
    expect(tourRoute('DELETE', 'a.testnet', '{}', 0, s, always).code).toBe(405);
  });
});
