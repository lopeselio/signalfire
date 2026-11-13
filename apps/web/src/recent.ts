// Calls this tab sent that succeeded, for a few minutes. The tour reads them so a step ticks the moment your
// transaction lands, instead of waiting for the server's next snapshot or audit read to catch up (~10–60 s).

export interface RecentCall { method: string; startup: string | null; at: number }

const KEEP_MS = 5 * 60_000;
let calls: RecentCall[] = [];

export function noteCall(method: string, args: object): void {
  const startup = typeof (args as { startup?: unknown }).startup === 'string' ? (args as { startup: string }).startup : null;
  calls = [...calls.filter((c) => Date.now() - c.at < KEEP_MS), { method, startup, at: Date.now() }];
}

/** Did this tab recently succeed in calling `method` (for `startup`, when given)? */
export function recently(method: string, startup?: string | null): boolean {
  return calls.some((c) => c.method === method && Date.now() - c.at < KEEP_MS && (startup === undefined || c.startup === startup));
}

/** The startups this tab recently called `method` for. */
export function recentStartups(method: string): string[] {
  return calls.filter((c) => c.method === method && c.startup && Date.now() - c.at < KEEP_MS).map((c) => c.startup!);
}
