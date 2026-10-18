import {setTimeout as delay} from 'node:timers/promises';
import {assertCssSources, currentCssHash} from './css-source.mjs';

export async function verifyServedCss(origin, {attempts = 1} = {}) {
  let response;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {response = await fetch(origin, {signal: AbortSignal.timeout(5000), cache: 'no-store'}); break;}
    catch (error) {if (attempt === attempts - 1) throw error; await delay(250);}
  }
  if (!response.ok) throw Error(`Application returned HTTP ${response.status}`);
  const html = await response.text();
  const links = [...html.matchAll(/<link\b[^>]*>/g)].map(m => m[0])
    .filter(link => /\brel="stylesheet"/.test(link)).map(link => link.match(/\bhref="([^"]+)"/)?.[1]);
  if (!links.length) throw Error('Application has no linked CSS');
  const css = await Promise.all(links.map(async href => {
    const url = new URL(href, origin);
    if (url.origin !== new URL(origin).origin) throw Error('Unexpected CSS origin');
    const r = await fetch(url, {cache: 'no-store'});
    if (!r.ok) throw Error(`CSS returned HTTP ${r.status}`);
    return r.text();
  }));
  const hash = await currentCssHash();
  assertCssSources(css, hash);
  return hash;
}
