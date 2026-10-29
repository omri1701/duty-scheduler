import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {verifyProductionCss} from '../scripts/verify-production-css.mjs';
import {currentCssHash} from '../scripts/css-source.mjs';

test('verify the CSS linked by production HTML, rejecting stale output and failed asset emission', async context => {
  const directory = await mkdtemp(path.join(tmpdir(), 'duty-css-test-'));
  context.after(() => rm(directory, {recursive: true, force: true}));
  await mkdir(path.join(directory, 'server/app'), {recursive: true});
  await mkdir(path.join(directory, 'static/immutable/chunks'), {recursive: true});
  const htmlPath = path.join(directory, 'server/app/index.html');
  const html = name => `<link rel="stylesheet" href="/_next/static/immutable/chunks/${name}.css?dpl=test">`;
  const css = await readFile('app/globals.css', 'utf8');
  // Simulate an older cached stylesheet alongside a correctly emitted new asset.
  const stale = css.slice(0, css.indexOf('/* Phone-only additions'));
  const fingerprint = `:root{--duty-css-source:"${await currentCssHash()}"}`;
  await writeFile(path.join(directory, 'static/immutable/chunks/current.css'), css + fingerprint);
  await writeFile(path.join(directory, 'static/immutable/chunks/old.css'), stale);
  await writeFile(htmlPath, html('current'));
  assert.equal(await verifyProductionCss(directory), 1);
  await writeFile(htmlPath, html('current') + html('old'));
  await assert.rejects(verifyProductionCss(directory), /does not match/);
  await writeFile(htmlPath, html('old'));
  await assert.rejects(verifyProductionCss(directory), /does not match/);
  await writeFile(path.join(directory, 'static/immutable/chunks/old.css'), stale + fingerprint);
  await assert.rejects(verifyProductionCss(directory), /missing \.mobile-navigation/);
  await writeFile(htmlPath, html('missing'));
  await assert.rejects(verifyProductionCss(directory), {code: 'ENOENT'});
  await writeFile(path.join(directory, 'static/immutable/chunks/empty.css'), '');
  await writeFile(htmlPath, html('empty'));
  await assert.rejects(verifyProductionCss(directory), /Empty production stylesheet/);
  await writeFile(htmlPath, '<html><body>No styles</body></html>');
  await assert.rejects(verifyProductionCss(directory), /no stylesheets/);
});
