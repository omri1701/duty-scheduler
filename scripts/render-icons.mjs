// Renders the favicon, PWA icons and iOS startup screens from the one logo file (LOGO_SRC in
// lib/brand.ts, under public/) with the pinned Playwright Chromium. Each is the logo's navy,
// full-bleed, with the logo centred inside a safe area. File names never change, so installed
// Home Screen apps keep finding them. Run after replacing the logo: node scripts/render-icons.mjs
import {chromium} from '@playwright/test';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {extname, resolve} from 'node:path';
import {BRAND_COLOR as LOGO_NAVY, LOGO_SRC} from '../lib/brand.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const file = resolve(root, 'public', LOGO_SRC.replace(/^\//, ''));
const type = {'.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp'}[extname(file)];
if (!type) throw Error(`Unsupported logo type: ${file}`);
const logo = `data:${type};base64,${readFileSync(file).toString('base64')}`;
// The logo's width as a share of the image. Maskable keeps the owl's wing tips inside Android's
// 80% safe circle; iOS and "any" icons only round the corners.
const FILL = {favicon: .98, icon: .9, maskable: .8, splash: .55};

// favicon.svg: the logo nested on a navy square (SVG logos stay vector).
const side = 1000, inset = side * (1 - FILL.favicon) / 2, size = side * FILL.favicon;
const nested = type === 'image/svg+xml'
  ? readFileSync(file, 'utf8').trim().replace(/^<svg\b[^>]*?(viewBox="[^"]+")[^>]*>/, `<svg x="${inset}" y="${inset}" width="${size}" height="${size}" $1>`).replace(/<title>.*?<\/title>/, '')
  : `<image href="${logo}" x="${inset}" y="${inset}" width="${size}" height="${size}"/>`;
writeFileSync(resolve(root, 'public/favicon.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}"><rect width="${side}" height="${side}" fill="${LOGO_NAVY}"/>${nested}</svg>\n`);
console.log('favicon.svg');

const browser = await chromium.launch();
const page = await (await browser.newContext({deviceScaleFactor: 1})).newPage();
async function shot(name, width, height, fill) {
  await page.setViewportSize({width, height});
  const px = Math.round(Math.min(width, height) * fill);
  await page.setContent(`<!doctype html><body style="margin:0;background:${LOGO_NAVY};display:grid;place-items:center;height:100vh"><img src="${logo}" width="${px}" height="${px}" style="display:block"></body>`);
  await page.locator('img').evaluate(img => img.decode());
  writeFileSync(resolve(root, 'public', name), await page.screenshot({clip: {x: 0, y: 0, width, height}}));
  console.log(name, width + 'x' + height);
}
await shot('icon-192.png', 192, 192, FILL.icon);
await shot('icon-512.png', 512, 512, FILL.icon);
await shot('icon-maskable-512.png', 512, 512, FILL.maskable);
await shot('apple-touch-icon.png', 180, 180, FILL.icon);
// iOS startup screens, one per common iPhone size (points × 3 or × 2).
mkdirSync(resolve(root, 'public/splash'), {recursive: true});
const splash = [[1290, 2796], [1179, 2556], [1170, 2532], [1284, 2778], [1125, 2436], [828, 1792], [750, 1334], [1242, 2208]];
for (const [w, h] of splash) await shot(`splash/${w}x${h}.png`, w, h, FILL.splash);
await browser.close();
