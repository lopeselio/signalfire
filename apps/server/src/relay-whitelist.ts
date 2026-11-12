import { config } from './config.ts';
import { getStartups } from './hub.ts';

// Which contracts the gasless relayer may call: the hub and every startup's token and DAO. Startups launch while the
// server runs, so the list is live: every chain snapshot adds what it sees, and a call to a receiver we don't know
// yet re-reads the hub's startups (at most once per `minGapMs`) before it is refused.

export interface StartupAccounts { token: string; dao: string }

export function createWhitelist(hub: string, load: () => Promise<StartupAccounts[]>, minGapMs = 5000, now: () => number = Date.now) {
  const allowed = new Set<string>([hub]);
  let last = -Infinity;
  const note = (list: StartupAccounts[]): void => { for (const s of list) { allowed.add(s.token); allowed.add(s.dao); } };
  const refresh = async (): Promise<void> => { last = now(); note(await load()); };
  return {
    note,
    refresh,
    has: (receiver: string): boolean => allowed.has(receiver),
    /** Is `receiver` allowed? Re-reads the startups first if it isn't known (rate-limited). */
    async allows(receiver: string): Promise<boolean> {
      if (allowed.has(receiver)) return true;
      if (now() - last >= minGapMs) await refresh().catch(() => undefined);
      return allowed.has(receiver);
    },
    list: (): string[] => [...allowed],
  };
}

/** The server's live list (ba.ts checks relays against it; snapshot.ts feeds it). */
export const relayWhitelist = createWhitelist(config.hub, getStartups);
