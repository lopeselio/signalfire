import { useEffect } from 'react';
import { Checklist } from './Checklist.tsx';
import { Hints, Notes } from './Hints.tsx';
import { PATHS } from './paths.tsx';
import { tourStore } from './state.ts';
import { Tour } from './Tour.tsx';
import { useX } from './useX.ts';
import { Welcome } from './Welcome.tsx';
import './tour.css';

export { seenOnboarding } from './state.ts';
export { HowItWorks } from './HowItWorks.tsx';

// The onboarding, mounted once by the shell: the welcome ("who are you?", on a first visit and from "?"), the guided
// tour, the Get started checklist, first-time hints and the notes in empty and waiting states.

const REQUIRES = [...new Set(PATHS.flatMap((p) => p.steps.map((s) => s.requires).filter((r): r is string => !!r)))];

/** Remembers which optional features this build has, the first time their hook shows up on any page. */
function useFeatures(): void {
  useEffect(() => {
    const id = setInterval(() => {
      for (const r of REQUIRES) if (!tourStore.get().features.includes(r) && document.querySelector(r)) tourStore.hasFeature(r);
    }, 2000);
    return () => clearInterval(id);
  }, []);
}

export function Onboarding({ open, onOpen, onClose }: { open: boolean; onOpen: () => void; onClose: () => void }) {
  useFeatures();
  const x = useX();
  if (!x) return null;
  return (
    <>
      {open && <Welcome x={x} onClose={onClose} />}
      <Tour x={x} />
      <Checklist x={x} onWelcome={onOpen} />
      <Hints />
      <Notes x={x} />
    </>
  );
}
