// Renders the PWA icon set and the iOS startup screens from the brand mark (lib/brand.ts,
// components/brand/logo.tsx) with the pinned Playwright Chromium, so every asset comes from one
// definition. Run after changing the mark or the brand colour: node scripts/render-icons.mjs
import {chromium} from '@playwright/test';
import {mkdirSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const BRAND = '#17604f', DARK = '#0f2a24', ACCENT = '#c7ef7a';
const mark = (size, {padding = 0, rounded = true, background = BRAND} = {}) => `
<div style="width:${size}px;height:${size}px;display:grid;place-items:center;background:${rounded ? 'transparent' : background}">
 <div style="position:relative;width:${size - padding * 2}px;height:${size - padding * 2}px;border-radius:${rounded ? (size - padding * 2) * .22 : 0}px;background:${background};display:flex;align-items:flex-end;justify-content:center;color:#fff;font:800 ${(size - padding * 2) * .74}px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;letter-spacing:-.04em">
  <span style="margin-bottom:${(size - padding * 2) * .1}px;margin-left:${-(size - padding * 2) * .06}px">d</span>
  <span style="position:absolute;right:${(size - padding * 2) * .16}px;bottom:${(size - padding * 2) * .2}px;width:${(size - padding * 2) * .2}px;height:${(size - padding * 2) * .2}px;border-radius:50%;background:${ACCENT}"></span>
 </div>
</div>`;
const page_ = html => `<!doctype html><meta charset="utf-8"><body style="margin:0;background:transparent">${html}</body>`;

const browser = await chromium.launch();
const context = await browser.newContext({deviceScaleFactor: 1});
const page = await context.newPage();
async function shot(file, html, width, height, omitBackground = true) {
  await page.setViewportSize({width, height});
  await page.setContent(page_(html));
  await page.evaluate(() => document.fonts.ready);
  const buffer = await page.screenshot({omitBackground, clip: {x: 0, y: 0, width, height}});
  writeFileSync(resolve(root, 'public', file), buffer);
  console.log(file, width + 'x' + height);
}
await shot('icon-192.png', mark(192), 192, 192);
await shot('icon-512.png', mark(512), 512, 512);
await shot('icon-maskable-512.png', mark(512, {padding: 64, rounded: false}), 512, 512, false);
await shot('apple-touch-icon.png', mark(180, {rounded: false}), 180, 180, false);
// iOS startup screens: the mark centred on the brand colour, one per common iPhone size (points × 3 or × 2).
mkdirSync(resolve(root, 'public/splash'), {recursive: true});
const splash = [[1290, 2796], [1179, 2556], [1170, 2532], [1284, 2778], [1125, 2436], [828, 1792], [750, 1334], [1242, 2208]];
for (const [w, h] of splash) {
  await shot(`splash/${w}x${h}.png`, `<div style="width:${w}px;height:${h}px;display:grid;place-items:center;background:${DARK}">${mark(Math.round(w * .22))}</div>`, w, h, false);
}
await browser.close();
