import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {assertCssSources, currentCssHash} from './css-source.mjs';

export async function verifyProductionCss(directory = '.next') {
  const html = await readFile(path.join(directory, 'server/app/index.html'), 'utf8');
  const links = [...html.matchAll(/<link\b[^>]*>/g)].map(match => match[0])
    .filter(link => /\brel="stylesheet"/.test(link))
    .map(link => link.match(/\bhref="([^"]+)"/)?.[1]);
  assert(links.length > 0, 'Production HTML has no stylesheets');
  const stylesheets = await Promise.all(links.map(async href => {
    const pathname = new URL(href, 'http://build.invalid').pathname;
    assert(pathname.startsWith('/_next/static/') && !pathname.includes('..'), 'Unexpected production CSS path');
    const css = await readFile(path.join(directory, pathname.slice('/_next/'.length)), 'utf8');
    assert(css.length > 0, `Empty production stylesheet: ${pathname}`);
    return css;
  }));
  const css = stylesheets.join('\n');
  assertCssSources(stylesheets, await currentCssHash());
  // These belong to the shared custom stylesheet, independently of utility discovery.
  // Checking the files linked by HTML catches stale output as well as omitted assets.
  for (const selector of ['.mobile-navigation', '.mobile-nav-selection', '.mobile-availability-legend',
    '.mobile-availability-weekdays', '.calendar-grid', '.availability-grid', '.team-grip', '.editor-dialog',
    '.desktop-month-tools', '.workflow-actions', '.workflow-label-wide', '.workflow-label-compact']) {
    assert(css.includes(selector), `Production CSS is missing ${selector}`);
  }
  assert(/@media\s*\(max-width:\s*600px\)/.test(css), 'Production CSS is missing the phone breakpoint');
  return links.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const count = await verifyProductionCss(process.argv[2]);
  console.log(`Production CSS verified (${count} linked stylesheet${count === 1 ? '' : 's'})`);
}
