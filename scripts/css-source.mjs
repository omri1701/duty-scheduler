import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';

export const cssSourceHash = source => createHash('sha256').update(source).digest('hex');
export const currentCssHash = async () => cssSourceHash(await readFile(new URL('../app/globals.css', import.meta.url), 'utf8'));
export function assertCssSource(css, expected) {
  const hashes=[...css.matchAll(/--duty-css-source\s*:\s*([a-f0-9]{64})\s*[;}]/g)].map(match=>match[1]);
  if (!hashes.length || hashes.some(hash=>hash!==expected)) {
    throw Error('Served CSS does not match app/globals.css. Stop and restart the development server; do not validate this stale build.');
  }
}
export function assertCssSources(stylesheets, expected) {
  const workspace = stylesheets.filter(css=>css.includes('.month-toolbar') || css.includes('--duty-css-source'));
  if (!workspace.length) throw Error('Application has no fingerprinted workspace CSS');
  // Validate each asset: current CSS must not conceal another stale cascade.
  for (const css of workspace) assertCssSource(css,expected);
}
// This fingerprint travels through the same transform/cache as the stylesheet.
export default function cssSourcePlugin() {
  return {postcssPlugin: 'duty-css-source', Once(root) {
    root.append({selector: ':root', nodes: [{prop: '--duty-css-source', value: cssSourceHash(root.source.input.css)}]});
  }};
}
cssSourcePlugin.postcss = true;
