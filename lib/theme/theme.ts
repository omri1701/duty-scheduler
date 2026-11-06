// Appearance (decision 2026-11-06): Auto follows the device; Light and Dark are per-device
// choices kept in localStorage. The resolved theme is `data-theme` on <html>, set before
// the first paint by THEME_SCRIPT (app/layout.tsx) so a dark device never flashes white.
export type ThemePreference = 'auto' | 'light' | 'dark';
export type Theme = 'light' | 'dark';
export const THEME_KEY = 'duty-theme';
/** The PC sidebar collapsed to icons, remembered per device (owner review 2026-11-07). */
export const SIDEBAR_KEY = 'duty-sidebar';

export const THEME_SCRIPT = `(function(){try{var p=localStorage.getItem('${THEME_KEY}');var d=p==='dark'||(p!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.dataset.theme=d?'dark':'light';if(localStorage.getItem('${SIDEBAR_KEY}')==='collapsed')document.documentElement.dataset.sidebar='collapsed';}catch(e){}})();`;

export function readPreference(): ThemePreference {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === 'light' || value === 'dark' ? value : 'auto';
  } catch {return 'auto';}
}

export function resolveTheme(preference: ThemePreference): Theme {
  if (preference !== 'auto') return preference;
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(preference: ThemePreference) {
  const theme = resolveTheme(preference);
  document.documentElement.dataset.theme = theme;
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#000000' : '#f2f3f5');
  return theme;
}

export function savePreference(preference: ThemePreference) {
  try {
    if (preference === 'auto') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, preference);
  } catch {}
}
