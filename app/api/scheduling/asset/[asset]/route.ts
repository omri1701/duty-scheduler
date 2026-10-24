import {readFile} from 'node:fs/promises';
import {join} from 'node:path';

export const dynamic = 'force-dynamic';
/** Public executable assets only. Never serve arbitrary package paths. */
export async function GET(_request: Request, context: {params: Promise<{asset: string}>}) {
  const {asset} = await context.params;
  if (!['highs.wasm', 'highs.mjs', 'LICENSE'].includes(asset)) return new Response(null, {status: 404});
  const bytes = await readFile(join(process.cwd(), 'node_modules', 'highs', asset === 'LICENSE' ? '' : 'build', asset));
  return new Response(bytes, {headers: {
    'Content-Type': asset.endsWith('.wasm') ? 'application/wasm' : asset === 'LICENSE' ? 'text/plain; charset=utf-8' : 'text/javascript; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin',
  }});
}
