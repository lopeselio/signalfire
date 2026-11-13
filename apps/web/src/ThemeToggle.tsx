import { useState } from 'react';

type Choice = 'system' | 'light' | 'dark';
const KEY = 'signalfire:theme';
const NEXT: Record<Choice, Choice> = { system: 'light', light: 'dark', dark: 'system' };
const LABEL: Record<Choice, string> = { system: 'Theme: follows your system', light: 'Theme: light', dark: 'Theme: dark' };
const ICON: Record<Choice, string> = { system: '◐', light: '☀', dark: '☾' };

function read(): Choice {
  try { const t = localStorage.getItem(KEY); return t === 'light' || t === 'dark' ? t : 'system'; } catch { return 'system'; }
}

/** Light / dark / system. The choice lives in this browser (localStorage); index.html applies it before first paint. */
export function ThemeToggle() {
  const [choice, setChoice] = useState<Choice>(read);
  const cycle = (): void => {
    const next = NEXT[choice];
    setChoice(next);
    if (next === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = next;
    try { if (next === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, next); } catch { /* storage blocked: lasts this visit */ }
  };
  return (
    <button className="ghost round theme-toggle" onClick={cycle} aria-label={`${LABEL[choice]}. Click to change.`} title={`${LABEL[choice]} (click to change)`}>
      <span aria-hidden="true">{ICON[choice]}</span>
    </button>
  );
}
