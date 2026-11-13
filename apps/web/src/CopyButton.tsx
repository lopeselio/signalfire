import { useEffect, useState } from 'react';

/** A small "Copy" button for a command or URL; it says "Copied ✓" for a moment after a successful copy. */
export function CopyButton({ text, label = 'Copy', what }: { text: string; label?: string; what?: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1600);
    return () => clearTimeout(t);
  }, [done]);
  const copy = (): void => { void navigator.clipboard?.writeText(text).then(() => setDone(true)).catch(() => undefined); };
  return (
    <button type="button" className={`copy-btn${done ? ' done' : ''}`} onClick={copy} aria-label={done ? 'Copied' : `${label}${what ? ` ${what}` : ''}`}>
      <span aria-hidden="true">{done ? 'Copied ✓' : label}</span>
    </button>
  );
}
