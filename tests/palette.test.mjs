import test from 'node:test';
import assert from 'node:assert/strict';
import {PALETTE} from '../lib/theme/palette.ts';

// Names are drawn in the member's ink on the member's tint (owner round 4): every colour must stay
// readable as text, WCAG AA (4.5:1), in both themes.
const luminance = hex => {
  const [r, g, b] = [1, 3, 5].map(i => {const s = parseInt(hex.slice(i, i + 2), 16) / 255; return s <= .03928 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4;});
  return .2126 * r + .7152 * g + .0722 * b;
};
const contrast = (a, b) => {const [x, y] = [luminance(a), luminance(b)]; return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);};

test('every member colour keeps its name readable on its tint in light and dark', () => {
  assert.equal(PALETTE.length, 20);
  for (const c of PALETTE) for (const theme of ['light', 'dark']) {
    const ratio = contrast(c[theme].bg, c[theme].ink);
    assert.ok(ratio >= 4.5, `${c.name.en} ${theme}: ${ratio.toFixed(2)}`);
  }
});
