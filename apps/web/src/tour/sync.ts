import { useEffect } from 'react';
import { tourStore, type PathId } from './state.ts';

// Keeps the tour's memory (path, step, seen steps, dismissed hints) with the signed-in account on the server
// (GET/PUT /api/me/tour), so a refresh in an incognito window or another browser keeps the ticks that read-only steps
// only get from "seen". Signed out, localStorage alone holds it, as before. Merging is a union: progress never shrinks.

interface Remote { path: PathId | null; tour: { path: PathId; index: number } | null; seen: string[]; hints: string[]; at: number }

const URL = '/api/me/tour';
const union = (a: string[], b: string[]): string[] => [...new Set([...a, ...b])];

export function useTourSync(account: string | null): void {
  useEffect(() => {
    if (!account) return;
    let alive = true;
    let ready = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let last = '';
    const push = (): void => {
      const s = tourStore.get();
      const body = JSON.stringify({ path: s.path, tour: s.tour, seen: s.seen, hints: s.hints });
      if (body === last) return;
      last = body;
      void fetch(URL, { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body }).catch(() => undefined);
    };
    fetch(URL, { credentials: 'same-origin' })
      .then((r) => (r.ok ? (r.json() as Promise<Remote>) : null))
      .then((r) => {
        if (!alive) return;
        if (r) {
          const s = tourStore.get();
          const remoteHas = r.seen.length > 0 || r.hints.length > 0 || !!r.path;
          tourStore.set({
            seen: union(s.seen, r.seen),
            hints: union(s.hints, r.hints),
            path: s.path ?? r.path,
            tour: s.tour ?? r.tour,
            welcomed: s.welcomed || remoteHas,
          });
        }
        ready = true;
        push(); // whatever this browser knew before sign-in joins the account's record
      })
      .catch(() => { ready = true; });
    const off = tourStore.subscribe(() => {
      if (!ready) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(push, 1500);
    });
    return () => { alive = false; off(); if (timer) clearTimeout(timer); };
  }, [account]);
}
