import {createHighsAdapter} from './highs-adapter.ts';
import {solveProblem} from './model.ts';
import type {Problem} from './problem.ts';
import type loadHighs from 'highs';

async function loadAdapter() {
  const url = new URL('/api/solver-spike/asset/highs.mjs', self.location.origin).href;
  // Keep upstream Emscripten glue intact; Turbopack cannot parse this WASM's imports.
  const {default: load} = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ url) as {default: typeof loadHighs};
  return createHighsAdapter(load, {locateFile: () => new URL('/api/solver-spike/asset/highs.wasm', self.location.origin).href});
}

const scope = self as unknown as {postMessage: (data: unknown) => void;
  onmessage: ((event: MessageEvent) => void) | null};
let adapter: ReturnType<typeof createHighsAdapter> | undefined;
scope.onmessage = async ({data}: MessageEvent<{id: number; problem: Problem;
  settings: {seed: number; seconds: number; nodes: number}}>) => {
  const {id, problem, settings} = data;
  try {
    adapter ??= loadAdapter();
    const solver = await adapter;
    scope.postMessage({id, type: 'solving'});
    const result = solveProblem(solver, problem, settings);
    scope.postMessage({id, type: 'result', result, initMs: solver.initMs, version: solver.version});
  } catch (error) {
    scope.postMessage({id, type: 'error', message: error instanceof Error ? error.message : String(error)});
  }
};
