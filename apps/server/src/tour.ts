// The onboarding tour's memory for a signed-in account (GET/PUT /api/me/tour): which path, which step, the read-only
// steps already seen and the hints dismissed. The browser keeps the same thing in localStorage; this copy follows the
// account to another browser or an incognito window. It is a small, validated, size-capped JSON record per account,
// never anything that moves money, and only the signed-in account can read or write its own.

export type PathId = 'explore' | 'back' | 'create' | 'found';
export interface TourMemory {
  path: PathId | null;
  tour: { path: PathId; index: number } | null;
  seen: string[];
  hints: string[];
  at: number;
}

const PATHS = new Set<string>(['explore', 'back', 'create', 'found']);
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const LIMITS = { ids: 200, bytes: 8000, putsPerMinute: 20 };

const ids = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && ID.test(x)))].slice(0, LIMITS.ids) : []);
const pathOf = (v: unknown): PathId | null => (typeof v === 'string' && PATHS.has(v) ? (v as PathId) : null);

/** Keeps only well-formed fields (anything else is dropped, not rejected). */
export function sanitizeTour(v: unknown, now: number): TourMemory {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const t = o.tour as Record<string, unknown> | null | undefined;
  const tp = t && typeof t === 'object' ? pathOf(t.path) : null;
  const ti = t && typeof t === 'object' && Number.isInteger(t.index) && (t.index as number) >= 0 && (t.index as number) < 50 ? (t.index as number) : null;
  return { path: pathOf(o.path), tour: tp && ti !== null ? { path: tp, index: ti } : null, seen: ids(o.seen), hints: ids(o.hints), at: now };
}

/** The stored record and an update: seen steps and dismissed hints are a union (progress never shrinks); the update's
 * current path and step win, because it is what the visitor is doing now. */
export function mergeTour(stored: TourMemory | null, next: TourMemory): TourMemory {
  if (!stored) return next;
  return {
    path: next.path ?? stored.path,
    tour: next.tour,
    seen: [...new Set([...stored.seen, ...next.seen])].slice(0, LIMITS.ids),
    hints: [...new Set([...stored.hints, ...next.hints])].slice(0, LIMITS.ids),
    at: next.at,
  };
}

/** A fixed-window limit on writes per account. */
export function rateLimiter(perMinute = LIMITS.putsPerMinute): (account: string, now: number) => boolean {
  const w = new Map<string, { start: number; n: number }>();
  return (account, now) => {
    const e = w.get(account);
    if (!e || now - e.start >= 60_000) {
      if (w.size > 5000) w.clear();
      w.set(account, { start: now, n: 1 });
      return true;
    }
    e.n += 1;
    return e.n <= perMinute;
  };
}

export interface TourStore { load(account: string): TourMemory | null; save(account: string, m: TourMemory): void }

/** The endpoint's logic, without HTTP: `account` is the session's account (null when signed out). */
export function tourRoute(
  method: string, account: string | null, raw: string | null, now: number, store: TourStore, allow: (a: string, now: number) => boolean,
): { code: number; body: unknown } {
  if (!account) return { code: 401, body: { error: 'sign in first' } };
  if (method === 'GET') return { code: 200, body: store.load(account) ?? sanitizeTour({}, 0) };
  if (method !== 'PUT' && method !== 'POST') return { code: 405, body: { error: 'GET or PUT' } };
  if (raw === null || raw.length > LIMITS.bytes) return { code: 413, body: { error: 'too large' } };
  if (!allow(account, now)) return { code: 429, body: { error: 'too many updates; try again in a minute' } };
  let parsed: unknown;
  try { parsed = JSON.parse(raw || '{}'); } catch { return { code: 400, body: { error: 'JSON body' } }; }
  const merged = mergeTour(store.load(account), sanitizeTour(parsed, now));
  store.save(account, merged);
  return { code: 200, body: merged };
}
