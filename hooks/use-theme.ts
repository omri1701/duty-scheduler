'use client';
import {useCallback, useEffect, useSyncExternalStore} from 'react';
import {applyTheme, readPreference, resolveTheme, savePreference, type Theme, type ThemePreference} from '@/lib/theme/theme';

const listeners = new Set<() => void>();
let preference: ThemePreference | null = null;
function current() {return preference ?? (preference = typeof window === 'undefined' ? 'auto' : readPreference());}
function subscribe(listener: () => void) {
  listeners.add(listener);
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const onMedia = () => {if (current() === 'auto') applyTheme('auto'); listener();};
  media.addEventListener('change', onMedia);
  return () => {listeners.delete(listener); media.removeEventListener('change', onMedia);};
}
const snapshot = () => `${current()}:${resolveTheme(current())}`;
const serverSnapshot = () => 'auto:light';

/** The appearance preference and the theme it resolves to right now. */
export function useTheme(): {preference: ThemePreference; theme: Theme; setPreference: (next: ThemePreference) => void} {
  const value = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const [pref, theme] = value.split(':') as [ThemePreference, Theme];
  useEffect(() => {applyTheme(current());}, []);
  const setPreference = useCallback((next: ThemePreference) => {
    preference = next; savePreference(next); applyTheme(next);
    listeners.forEach(l => l());
  }, []);
  return {preference: pref, theme, setPreference};
}
