// Lookalike creator names. Mirrors contracts/hub (vet_creator).

const MAP: Record<string, string> = { '0': 'o', '1': 'l', '3': 'e', '5': 's' };

/** The first label of an account id, lowercased, with look-alike digits mapped to letters. */
export const normalize = (account: string): string =>
  [...(account.split('.')[0] ?? '').toLowerCase()].map((c) => MAP[c] ?? c).join('');

export function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** Is `candidate` a lookalike of `existing`? Same normalized name but different spelling, or one edit apart (names of 4+). */
export function isLookalike(candidate: string, existing: string): boolean {
  if (candidate === existing) return false;
  const a = normalize(candidate);
  const b = normalize(existing);
  if (a === b) return true;
  return Math.min(a.length, b.length) >= 4 && levenshtein(a, b) <= 1;
}
