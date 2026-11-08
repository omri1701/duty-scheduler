// Cuts a round logo out of its flat background: finds the dark disc on a light background,
// masks it to a clean anti-aliased circle (a hair inside the edge, so no light fringe) and saves
// public/brand/logo.png at the source's own resolution (never upscaled), transparent outside.
// Then run node scripts/render-icons.mjs. Usage: node scripts/cut-logo.mjs <image.webp|png|jpg>
import {chromium} from '@playwright/test';
import {readFileSync, writeFileSync} from 'node:fs';
import {extname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const input = process.argv[2];
if (!input) throw Error('Usage: node scripts/cut-logo.mjs <image>');
const type = {'.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg'}[extname(input).toLowerCase()];
if (!type) throw Error('Use a .webp, .png or .jpg image.');
const out = resolve(fileURLToPath(new URL('../', import.meta.url)), 'public/brand/logo.png');
const browser = await chromium.launch();
const page = await browser.newPage();
const result = await page.evaluate(async src => {
  const img = new Image(); img.src = src; await img.decode();
  const W = img.naturalWidth, H = img.naturalHeight;
  const c = new OffscreenCanvas(W, H), x = c.getContext('2d'); x.drawImage(img, 0, 0);
  const d = x.getImageData(0, 0, W, H).data;
  const lum = (px, py) => {const i = (Math.round(py) * W + Math.round(px)) * 4; return (d[i] + d[i + 1] + d[i + 2]) / 3;};
  // Edge points: from the centre outwards, the first dark→light step on 360 rays.
  const pts = [], cx0 = W / 2, cy0 = H / 2, max = Math.min(W, H) / 2 - 1;
  for (let a = 0; a < 360; a++) {
    const t = a * Math.PI / 180;
    for (let r = max * .8; r < max; r += .25) if (lum(cx0 + r * Math.cos(t), cy0 + r * Math.sin(t)) >= 128) {pts.push([cx0 + r * Math.cos(t), cy0 + r * Math.sin(t)]); break;}
  }
  if (pts.length < 300) throw Error('No round logo found: expected a dark disc on a light background.');
  // Least-squares circle (Kasa).
  let sx = 0, sy = 0; for (const [px, py] of pts) {sx += px; sy += py;} const mx = sx / pts.length, my = sy / pts.length;
  let suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (const [px, py] of pts) {const u = px - mx, v = py - my; suu += u * u; svv += v * v; suv += u * v; suuu += u ** 3; svvv += v ** 3; suvv += u * v * v; svuu += v * u * u;}
  const det = suu * svv - suv * suv, b1 = (suuu + suvv) / 2, b2 = (svvv + svuu) / 2;
  const uc = (b1 * svv - b2 * suv) / det, vc = (suu * b2 - suv * b1) / det;
  const cx = mx + uc, cy = my + vc, R = Math.sqrt(uc * uc + vc * vc + (suu + svv) / pts.length);
  const r = Math.floor(R - 2), side = 2 * r, ox = Math.round(cx - r), oy = Math.round(cy - r);
  const o = new OffscreenCanvas(side, side), y = o.getContext('2d');
  y.beginPath(); y.arc(cx - ox, cy - oy, r, 0, Math.PI * 2); y.clip();
  y.drawImage(img, -ox, -oy);
  const blob = await o.convertToBlob({type: 'image/png'});
  return {cx, cy, R, side, png: [...new Uint8Array(await blob.arrayBuffer())]};
}, `data:${type};base64,${readFileSync(input).toString('base64')}`);
writeFileSync(out, Buffer.from(result.png));
console.log(`public/brand/logo.png ${result.side}×${result.side} (circle at ${result.cx.toFixed(1)},${result.cy.toFixed(1)} r ${result.R.toFixed(1)})`);
await browser.close();
