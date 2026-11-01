import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {assertCssSources, currentCssHash} from './css-source.mjs';

async function readBuildFile(directory, file, description) {
  try {
    return await readFile(path.join(directory, file), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') throw Error(`${description} is missing: ${path.join(directory, file)}. Run next build before this check.`);
    throw error;
  }
}
const readManifest = async (directory, file) => JSON.parse(await readBuildFile(directory, file, 'Next build manifest'));

// Next 16.4 writes prerendered pages to a hashed response cache when a build adapter
// is configured (Vercel sets NEXT_ADAPTER_PATH), and to server/app otherwise.
// Locate the root document from the build's own manifests, as Next does.
export async function productionHtmlFile(directory = '.next') {
  const {config} = await readManifest(directory, 'required-server-files.json');
  const {routes} = await readManifest(directory, 'prerender-manifest.json');
  assert(routes['/']?.dataRoute?.endsWith('.rsc'), 'Next did not prerender / as a static App Router page; cannot find its stylesheets');
  if (!config.adapterPath || config.output === 'export') return 'server/app/index.html';
  const appPaths = await readManifest(directory, 'app-path-routes-manifest.json');
  const sourceRoute = Object.keys(appPaths).find(page => page.endsWith('/page') && appPaths[page] === routes['/'].srcRoute);
  assert(sourceRoute, 'App path routes manifest has no page for /');
  let getRouteCacheKey;
  try {
    ({getRouteCacheKey} = await import('next/dist/server/lib/route-cache-key.js'));
  } catch (error) {
    throw Error(`Next no longer exposes its route cache key (${error.message}); update scripts/verify-production-css.mjs`);
  }
  return `server${getRouteCacheKey('/', {kind: 'APP_PAGE', sourceRoute})}.html`;
}

export async function verifyProductionCss(directory = '.next') {
  const html = await readBuildFile(directory, await productionHtmlFile(directory), 'Production HTML for /');
  const links = [...html.matchAll(/<link\b[^>]*>/g)].map(match => match[0])
    .filter(link => /\brel="stylesheet"/.test(link))
    .map(link => link.match(/\bhref="([^"]+)"/)?.[1]);
  assert(links.length > 0, 'Production HTML has no stylesheets');
  const stylesheets = await Promise.all(links.map(async href => {
    const pathname = new URL(href, 'http://build.invalid').pathname;
    assert(pathname.startsWith('/_next/static/') && !pathname.includes('..'), 'Unexpected production CSS path');
    const css = await readBuildFile(directory, pathname.slice('/_next/'.length), 'Production stylesheet');
    assert(css.length > 0, `Empty production stylesheet: ${pathname}`);
    return css;
  }));
  const css = stylesheets.join('\n');
  assertCssSources(stylesheets, await currentCssHash());
  // These belong to the shared custom stylesheet, independently of utility discovery.
  // Checking the files linked by HTML catches stale output as well as omitted assets.
  for (const selector of ['.mobile-navigation', '.mobile-nav-selection', '.mobile-availability-legend',
    '.mobile-availability-weekdays', '.calendar-grid', '.availability-grid', '.team-grip', '.editor-dialog',
    '.desktop-month-tools', '.workflow-actions', '.month-toolbar-container', '.mobile-action-menu']) {
    assert(css.includes(selector), `Production CSS is missing ${selector}`);
  }
  assert(/@media\s*\(max-width:\s*600px\)/.test(css), 'Production CSS is missing the phone breakpoint');
  return links.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const count = await verifyProductionCss(process.argv[2]);
  console.log(`Production CSS verified (${count} linked stylesheet${count === 1 ? '' : 's'})`);
}
