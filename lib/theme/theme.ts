// Appearance (decision 2026-11-06): Auto follows the device; Light and Dark are per-device
// choices kept in localStorage. The resolved theme is `data-theme` on <html>, set before
// the first paint by THEME_SCRIPT (app/layout.tsx) so a dark device never flashes white.
export type ThemePreference = 'auto' | 'light' | 'dark';
export type Theme = 'light' | 'dark';
export const THEME_KEY = 'duty-theme';
/** The PC sidebar collapsed to icons, remembered per device (owner review 2026-11-07). */
export const SIDEBAR_KEY = 'duty-sidebar';
/** The page colour per theme: the status bar / notch area (theme-color metas and the .safe-top strip). */
export const THEME_COLOR = {light: '#f2f3f5', dark: '#000000'} as const;

export const THEME_SCRIPT = `(function(){try{var p=localStorage.getItem('${THEME_KEY}');var d=p==='dark'||(p!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.dataset.theme=d?'dark':'light';var m=document.querySelector('meta[name="theme-color"]');if(!m){m=document.createElement('meta');m.name='theme-color';document.head.appendChild(m);}m.setAttribute('content',d?'${THEME_COLOR.dark}':'${THEME_COLOR.light}');if(localStorage.getItem('${SIDEBAR_KEY}')==='collapsed')document.documentElement.dataset.sidebar='collapsed';}catch(e){}})();`;

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
  // The theme-color tag (THEME_SCRIPT made it before the first paint), so the status bar follows the chosen
  // theme even when the device's differs; Auto re-runs this when the device changes (hooks/use-theme.ts).
  // The .safe-top strip follows --bg.
  const metas = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
  if (!metas.length) {const meta = document.createElement('meta'); meta.name = 'theme-color'; document.head.append(meta);}
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach(meta => {meta.removeAttribute('media'); meta.setAttribute('content', THEME_COLOR[theme]);});
  return theme;
}

export function savePreference(preference: ThemePreference) {
  try {
    if (preference === 'auto') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, preference);
  } catch {}
}
