import { useCallback, useEffect, useState } from 'react';

/** "system" follows the device; the other two are the person's own choice. */
export type ThemeChoice = 'system' | 'light' | 'dark';
const STORAGE_KEY = 'ajo.theme';
const ORDER: ThemeChoice[] = ['system', 'light', 'dark'];

export function loadTheme(): ThemeChoice {
  try { const v = localStorage.getItem(STORAGE_KEY); return v === 'light' || v === 'dark' ? v : 'system'; } catch { return 'system'; }
}

/** Puts the choice on <html> so the stylesheet switches palettes; "system" removes it and lets the device decide. */
export function applyTheme(choice: ThemeChoice) {
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
}

export function useTheme(): { choice: ThemeChoice; cycle: () => void } {
  const [choice, setChoice] = useState<ThemeChoice>(loadTheme);
  useEffect(() => { applyTheme(choice); }, [choice]);
  const cycle = useCallback(() => {
    setChoice((c) => {
      const next = ORDER[(ORDER.indexOf(c) + 1) % ORDER.length]!;
      try { if (next === 'system') localStorage.removeItem(STORAGE_KEY); else localStorage.setItem(STORAGE_KEY, next); } catch { /* the choice still applies until the page closes */ }
      return next;
    });
  }, []);
  return { choice, cycle };
}
