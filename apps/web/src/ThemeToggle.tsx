import { useState } from 'react';

type Choice = 'light' | 'dark' | 'system';
const KEY = 'signalfire:theme';
const NEXT: Record<Choice, Choice> = { light: 'dark', dark: 'system', system: 'light' };
const LABEL: Record<Choice, string> = { light: 'Theme: light', dark: 'Theme: dark', system: 'Theme: follows your system' };
const ICON: Record<Choice, string> = { light: '☀', dark: '☾', system: '◐' };

function read(): Choice {
  try { const t = localStorage.getItem(KEY); return t === 'dark' || t === 'system' ? t : 'light'; } catch { return 'light'; }
}

/** Light (default, peach) / dark / system. Remembered in this browser; index.html applies it before first paint. */
export function ThemeToggle() {
  const [choice, setChoice] = useState<Choice>(read);
  const cycle = (): void => {
    const next = NEXT[choice];
    setChoice(next);
    if (next === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = next;
    try { localStorage.setItem(KEY, next); } catch { /* storage blocked: lasts this visit */ }
  };
  return (
    <button className="ghost round theme-toggle" onClick={cycle} aria-label={`${LABEL[choice]}. Click to change.`} title={`${LABEL[choice]} (click to change)`}>
      <span aria-hidden="true">{ICON[choice]}</span>
    </button>
  );
}
