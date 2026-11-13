import { useEffect, useRef, useState } from 'react';

/**
 * Ids that arrived after the list first loaded, for a short flash (1.6 s). The first non-empty list is what was
 * already there, so opening a page doesn't flash everything.
 */
export function useArrivals(ids: string[]): Set<string> {
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());
  const key = ids.join('|');
  useEffect(() => {
    if (ids.length === 0) return;
    if (seen.current === null) { seen.current = new Set(ids); return; }
    const add = ids.filter((x) => !seen.current!.has(x));
    if (add.length === 0) return;
    for (const x of add) seen.current.add(x);
    setFresh((f) => new Set([...f, ...add]));
    // not cleared on the next change: each arrival's flash ends on its own clock
    setTimeout(() => setFresh((f) => { const n = new Set(f); for (const x of add) n.delete(x); return n; }), 1600);
  }, [key]);
  return fresh;
}
