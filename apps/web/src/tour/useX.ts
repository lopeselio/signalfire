import { useApp, useNow } from '../ui.tsx';
import { complete, pathById, type X } from './paths.tsx';
import { signals, tourStore, useFounderAudit, type PathId } from './state.ts';

/** Everything a step reads: the app's state, the session, what the visitor has done, the clock. */
export function useX(): X | null {
  const { state, me, account } = useApp();
  const now = useNow(1000);
  const founder = !!account && !!state?.startups.some((s) => s.founder === account);
  const audit = useFounderAudit(founder);
  if (!state) return null;
  return { state, me, account, now, sig: signals(state, me, account, audit) };
}

/** The first step of a path the visitor hasn't completed (0 if they completed all of them). */
export function firstOpen(path: PathId, x: X): number {
  const seen = tourStore.get().seen;
  const i = pathById(path).steps.findIndex((s) => !s.requires && !complete(s, x, seen));
  return i < 0 ? 0 : i;
}

export function startPath(path: PathId, x: X | null, at?: number): void {
  tourStore.start(path, at ?? (x ? firstOpen(path, x) : 0));
}
