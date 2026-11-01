import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {verifyProductionCss} from '../scripts/verify-production-css.mjs';
import {currentCssHash} from '../scripts/css-source.mjs';

// A local build writes server/app; a build adapter (Vercel) writes Next's hashed response cache.
const layouts = {
  local: {config: {}, html: 'server/app/index.html'},
  adapter: {config: {adapterPath: '/vercel/adapter.js'},
    html: `server/route-cache/APP_PAGE/${createHash('sha256').update('/page').digest('hex')}/$/index.html`},
};

async function buildDirectory(context, layout) {
  const directory = await mkdtemp(path.join(tmpdir(), 'duty-css-test-'));
  context.after(() => rm(directory, {recursive: true, force: true}));
  await mkdir(path.dirname(path.join(directory, layout.html)), {recursive: true});
  await mkdir(path.join(directory, 'static/immutable/chunks'), {recursive: true});
  await writeFile(path.join(directory, 'required-server-files.json'), JSON.stringify({config: layout.config}));
  await writeFile(path.join(directory, 'prerender-manifest.json'), JSON.stringify({routes: {'/': {srcRoute: '/', dataRoute: '/index.rsc'}}}));
  await writeFile(path.join(directory, 'app-path-routes-manifest.json'), JSON.stringify({'/_not-found/page': '/_not-found', '/page': '/'}));
  return directory;
}

for (const [name, layout] of Object.entries(layouts)) {
  test(`verify the CSS linked by production HTML (${name} build), rejecting stale output and failed asset emission`, async context => {
    const directory = await buildDirectory(context, layout);
    const htmlPath = path.join(directory, layout.html);
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
    await assert.rejects(verifyProductionCss(directory), /Production stylesheet is missing: .*missing\.css/);
    await writeFile(path.join(directory, 'static/immutable/chunks/empty.css'), '');
    await writeFile(htmlPath, html('empty'));
    await assert.rejects(verifyProductionCss(directory), /Empty production stylesheet/);
    await writeFile(htmlPath, '<html><body>No styles</body></html>');
    await assert.rejects(verifyProductionCss(directory), /no stylesheets/);
    await rm(htmlPath);
    await assert.rejects(verifyProductionCss(directory), /Production HTML for \/ is missing/);
  });
}

test('name the missing build output instead of failing with a raw ENOENT', async context => {
  const directory = await buildDirectory(context, layouts.adapter);
  // The adapter layout must not fall back to a stale server/app document.
  await mkdir(path.join(directory, 'server/app'), {recursive: true});
  await writeFile(path.join(directory, 'server/app/index.html'), '<link rel="stylesheet" href="/_next/static/old.css">');
  await assert.rejects(verifyProductionCss(directory), /Production HTML for \/ is missing: .*route-cache/);
  await writeFile(path.join(directory, 'prerender-manifest.json'), JSON.stringify({routes: {}}));
  await assert.rejects(verifyProductionCss(directory), /did not prerender \//);
  await rm(path.join(directory, 'required-server-files.json'));
  await assert.rejects(verifyProductionCss(directory), /Next build manifest is missing: .*required-server-files\.json/);
});
