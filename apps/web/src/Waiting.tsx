import { useEffect, useState } from 'react';
import { reducedMotion } from './motion.tsx';

/**
 * A wait that says what is happening. `lines` rotate every `every` ms (about 3 s) with a soft shimmer; each line must
 * describe something that really happens during this wait. Under prefers-reduced-motion it shows one still line
 * (`still`, or the first line). Screen readers hear the still line once, not every rotation.
 */
export function Waiting({ lines, still, every = 3000, className }: { lines: string[]; still?: string; every?: number; className?: string }) {
  const [reduced] = useState(reducedMotion);
  const [i, setI] = useState(0);
  const many = lines.length > 1 && !reduced;
  useEffect(() => {
    if (!many) return;
    const t = setInterval(() => setI((k) => (k + 1) % lines.length), every);
    return () => clearInterval(t);
  }, [many, lines.length, every]);
  const quiet = still ?? lines[0];
  return (
    <p className={`waiting${many ? ' many' : ''}${className ? ` ${className}` : ''}`} role="status">
      <span className="w-spark" aria-hidden="true" />
      {many ? (
        <>
          <span key={i} className="w-line" aria-hidden="true">{lines[i % lines.length]}</span>
          <span className="sr-only">{quiet}</span>
        </>
      ) : <span className="w-line">{quiet}</span>}
    </p>
  );
}
