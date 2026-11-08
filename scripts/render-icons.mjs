// Renders every logo asset from the one source, public/brand/logo.png (a round logo, transparent
// outside; make it with node scripts/cut-logo.mjs <image>), with the pinned Playwright Chromium:
// in-app sizes (PNG + WebP), favicon, Home Screen and maskable icons and iOS startup screens on
// full-bleed navy. Only ever downscales, in halving steps, so nothing is blurred. File names never
// change, so installed Home Screen apps keep finding them. Run: node scripts/render-icons.mjs
import {chromium} from '@playwright/test';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {BRAND_COLOR, LOGO_SIZES} from '../lib/brand.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = file => resolve(root, 'public', file);
const source = `data:image/png;base64,${readFileSync(out('brand/logo.png')).toString('base64')}`;
// The logo's diameter as a share of the image. Maskable keeps the whole circle inside Android's
// 80% safe zone; iOS and "any" icons only round the corners; tiny favicons use nearly all of it.
const FILL = {favicon: .96, icon: .88, maskable: .8, splash: .5};

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent('<!doctype html><body></body>');
await page.evaluate(async src => {
  const img = new Image(); img.src = src; await img.decode();
  // Downscale in halving steps (each high-quality), then once to the exact size.
  window.scaled = size => {
    let canvas = new OffscreenCanvas(img.naturalWidth, img.naturalHeight); canvas.getContext('2d').drawImage(img, 0, 0);
    while (canvas.width / 2 >= size) {
      const next = new OffscreenCanvas(Math.round(canvas.width / 2), Math.round(canvas.height / 2)), x = next.getContext('2d');
      x.imageSmoothingQuality = 'high'; x.drawImage(canvas, 0, 0, next.width, next.height); canvas = next;
    }
    const last = new OffscreenCanvas(size, size), x = last.getContext('2d');
    x.imageSmoothingQuality = 'high'; x.drawImage(canvas, 0, 0, size, size); return last;
  };
  window.encode = async (canvas, type) => [...new Uint8Array(await (await canvas.convertToBlob({type, quality: .92})).arrayBuffer())];
  window.render = async (width, height, fill, background, type) => {
    const c = new OffscreenCanvas(width, height), x = c.getContext('2d');
    if (background) {x.fillStyle = background; x.fillRect(0, 0, width, height);}
    const size = Math.round(Math.min(width, height) * fill);
    x.drawImage(window.scaled(size), Math.round((width - size) / 2), Math.round((height - size) / 2));
    return window.encode(c, type);
  };
}, source);
async function save(file, width, height, fill, background = BRAND_COLOR, type = 'image/png') {
  writeFileSync(out(file), Buffer.from(await page.evaluate(a => window.render(...a), [width, height, fill, background, type])));
  console.log(file, `${width}x${height}`);
}
// In-app logo (components/brand/logo.tsx picks one by display size × pixel ratio).
for (const size of LOGO_SIZES) for (const type of ['png', 'webp']) await save(`brand/logo-${size}.${type}`, size, size, 1, null, `image/${type}`);
await save('favicon-32.png', 32, 32, FILL.favicon, null);
await save('favicon-48.png', 48, 48, FILL.favicon, null);
// favicon.svg stays for browsers and links that still ask for it: the 64px logo inside.
const fav = Buffer.from(await page.evaluate(a => window.render(...a), [64, 64, FILL.favicon, null, 'image/png'])).toString('base64');
writeFileSync(out('favicon.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><image href="data:image/png;base64,${fav}" width="64" height="64"/></svg>\n`);
console.log('favicon.svg');
await save('icon-192.png', 192, 192, FILL.icon);
await save('icon-512.png', 512, 512, FILL.icon);
await save('icon-maskable-512.png', 512, 512, FILL.maskable);
await save('apple-touch-icon.png', 180, 180, FILL.icon);
// iOS startup screens, one per common iPhone size (points × 3 or × 2).
mkdirSync(out('splash'), {recursive: true});
const splash = [[1290, 2796], [1179, 2556], [1170, 2532], [1284, 2778], [1125, 2436], [828, 1792], [750, 1334], [1242, 2208]];
for (const [w, h] of splash) await save(`splash/${w}x${h}.png`, w, h, FILL.splash);
await browser.close();
