import {readFile} from 'node:fs/promises';
import {join} from 'node:path';

export const dynamic = 'force-dynamic';
/** Allowlisted, opt-in, same-origin assets from the lockfile-pinned package. */
export async function GET(_request: Request, context: {params: Promise<{asset: string}>}) {
  const {asset} = await context.params;
  if (process.env.DUTY_SOLVER_SPIKE !== '1' || !['highs.wasm', 'highs.mjs', 'LICENSE'].includes(asset)) return new Response(null, {status: 404});
  // Do not require.resolve the WASM: Turbopack treats that as a module to parse.
  const directory = join(process.cwd(), 'node_modules', 'highs');
  const bytes = await readFile(join(directory, asset === 'LICENSE' ? '' : 'build', asset));
  return new Response(bytes, {headers: {'Content-Type': asset.endsWith('.wasm') ? 'application/wasm' : asset === 'LICENSE' ? 'text/plain' : 'text/javascript', 'Cache-Control': 'no-store'}});
}
