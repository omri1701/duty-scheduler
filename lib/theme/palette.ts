import type {CSSProperties} from 'react';

/** The 20 member colours (decision 2026-11-06). The stored value is the light tint's hex,
 * which the database's `#rrggbb` check accepts; each entry also carries a dark-mode tint
 * and an ink for text on the tint, so names stay legible as fills and as text in both themes. */
export type MemberColor = {
  /** Stored in duty_members.color. */
  hex: string;
  name: {en: string; he: string};
  /** Light theme: tint and the ink drawn on it. */
  light: {bg: string; ink: string};
  /** Dark theme: a deeper tint and a light ink. */
  dark: {bg: string; ink: string};
};

export const PALETTE: readonly MemberColor[] = [
  {hex: '#f6c4c0', name: {en: 'Rose', he: 'ורוד'}, light: {bg: '#f6c4c0', ink: '#6f1d1b'}, dark: {bg: '#8a2c2a', ink: '#ffe3e0'}},
  {hex: '#f8c9a8', name: {en: 'Peach', he: 'אפרסק'}, light: {bg: '#f8c9a8', ink: '#7a3a10'}, dark: {bg: '#8f4a1c', ink: '#ffe6d3'}},
  {hex: '#f6d58d', name: {en: 'Amber', he: 'ענבר'}, light: {bg: '#f6d58d', ink: '#6b4a05'}, dark: {bg: '#8a6414', ink: '#fff0c4'}},
  {hex: '#f0e68c', name: {en: 'Lemon', he: 'לימון'}, light: {bg: '#f0e68c', ink: '#5a5500'}, dark: {bg: '#787212', ink: '#fbf7c2'}},
  {hex: '#cfe7a2', name: {en: 'Lime', he: 'ליים'}, light: {bg: '#cfe7a2', ink: '#355a0b'}, dark: {bg: '#4d7a1a', ink: '#e8f7cd'}},
  {hex: '#b4e1b0', name: {en: 'Green', he: 'ירוק'}, light: {bg: '#b4e1b0', ink: '#1f5a24'}, dark: {bg: '#2f7a37', ink: '#dcf5da'}},
  {hex: '#a9e3cf', name: {en: 'Mint', he: 'מנטה'}, light: {bg: '#a9e3cf', ink: '#0f5a46'}, dark: {bg: '#1f7a62', ink: '#d4f5ea'}},
  {hex: '#a6dfe0', name: {en: 'Teal', he: 'טורקיז'}, light: {bg: '#a6dfe0', ink: '#0c5558'}, dark: {bg: '#1a7275', ink: '#d2f4f4'}},
  {hex: '#b3dcf3', name: {en: 'Sky', he: 'תכלת'}, light: {bg: '#b3dcf3', ink: '#0f4a70'}, dark: {bg: '#1f6a97', ink: '#d9eefb'}},
  {hex: '#bccff5', name: {en: 'Blue', he: 'כחול'}, light: {bg: '#bccff5', ink: '#1f3a85'}, dark: {bg: '#3353a8', ink: '#dfe7fb'}},
  {hex: '#c7c4f3', name: {en: 'Indigo', he: 'אינדיגו'}, light: {bg: '#c7c4f3', ink: '#312a80'}, dark: {bg: '#4a42a6', ink: '#e5e3fb'}},
  {hex: '#d7c2ee', name: {en: 'Violet', he: 'סגול'}, light: {bg: '#d7c2ee', ink: '#4b2378'}, dark: {bg: '#67389c', ink: '#eee2fb'}},
  {hex: '#ebc2e6', name: {en: 'Orchid', he: 'סחלב'}, light: {bg: '#ebc2e6', ink: '#6b1f62'}, dark: {bg: '#8a3480', ink: '#fbe3f8'}},
  {hex: '#f5c6d8', name: {en: 'Pink', he: 'ורוד בהיר'}, light: {bg: '#f5c6d8', ink: '#7a1f45'}, dark: {bg: '#9a3560', ink: '#fde4ee'}},
  {hex: '#e3cdb3', name: {en: 'Sand', he: 'חול'}, light: {bg: '#e3cdb3', ink: '#5e3f1b'}, dark: {bg: '#7a5a34', ink: '#f6e8d6'}},
  {hex: '#d9c6b0', name: {en: 'Mocha', he: 'מוקה'}, light: {bg: '#d9c6b0', ink: '#4e3517'}, dark: {bg: '#6b4e30', ink: '#f1e4d2'}},
  {hex: '#c9d1c0', name: {en: 'Sage', he: 'מרווה'}, light: {bg: '#c9d1c0', ink: '#374a2a'}, dark: {bg: '#4f6440', ink: '#e4ebdc'}},
  {hex: '#c4d3dc', name: {en: 'Slate', he: 'צפחה'}, light: {bg: '#c4d3dc', ink: '#2f4552'}, dark: {bg: '#465c6a', ink: '#e2ecf2'}},
  {hex: '#d6d2cf', name: {en: 'Stone', he: 'אבן'}, light: {bg: '#d6d2cf', ink: '#44403c'}, dark: {bg: '#5c5652', ink: '#efebe8'}},
  {hex: '#f3bdb0', name: {en: 'Coral', he: 'אלמוג'}, light: {bg: '#f3bdb0', ink: '#7a2e1c'}, dark: {bg: '#9a4530', ink: '#fde3dc'}},
];

/** Colours members received before the 20-colour palette: each renders as its nearest new colour. */
const LEGACY: Record<string, string> = {
  '#adc9ee': '#bccff5', '#f0ba95': '#f8c9a8', '#c9b1de': '#d7c2ee', '#9bcfbe': '#a9e3cf', '#e9a2aa': '#f6c4c0',
  '#e7d88f': '#f0e68c', '#dfb4d2': '#ebc2e6', '#c1cf98': '#cfe7a2', '#94cad7': '#a6dfe0', '#cfb39b': '#e3cdb3',
  '#b1c1ca': '#c4d3dc', '#aaa8d9': '#c7c4f3', '#dbb677': '#f6d58d', '#f1c3ba': '#f3bdb0', '#a5dfac': '#b4e1b0',
};

const byHex = new Map(PALETTE.map(c => [c.hex, c]));

function rgb(hex: string) {
  const v = hex.replace('#', '');
  return [0, 1, 2].map(i => parseInt(v.slice(i * 2, i * 2 + 2), 16) / 255) as [number, number, number];
}
function hue([r, g, b]: [number, number, number]) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d < 0.02) return -1;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return ((h * 60) + 360) % 360;
}

/** The palette entry a stored colour renders as. Unknown values pick the nearest hue, so an
 * old or hand-edited colour still shows legibly in both themes. */
export function memberColor(hex: string | undefined | null): MemberColor {
  const key = (hex ?? '').toLowerCase();
  const known = byHex.get(key) ?? byHex.get(LEGACY[key] ?? '');
  if (known) return known;
  if (!/^#[0-9a-f]{6}$/.test(key)) return PALETTE[9];
  const h = hue(rgb(key));
  if (h < 0) return PALETTE[18];
  let best = PALETTE[0], distance = Infinity;
  for (const c of PALETTE) {
    const ch = hue(rgb(c.hex));
    if (ch < 0) continue;
    const d = Math.min(Math.abs(ch - h), 360 - Math.abs(ch - h));
    if (d < distance) {distance = d; best = c;}
  }
  return best;
}

/** Inline variables for anything painted in a member's colour; globals.css picks the
 * light or dark pair (`.member-tint` and the calendar pills read --member-bg/--member-ink). */
export function memberStyle(hex: string | undefined | null): CSSProperties {
  const c = memberColor(hex);
  return {'--member-light': c.light.bg, '--member-light-ink': c.light.ink, '--member-dark': c.dark.bg, '--member-dark-ink': c.dark.ink} as CSSProperties;
}

/** Up to two initials for an avatar. */
export function initials(name: string) {
  return name.trim().split(/\s+/).map(n => n[0] ?? '').join('').slice(0, 2).toUpperCase();
}
