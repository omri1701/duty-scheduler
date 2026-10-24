import {loadSchedulingAdapter} from './load.ts';
import {solveProblem} from './model.ts';
import type {Problem} from './problem.ts';

const scope = self as unknown as {postMessage: (data: unknown) => void;
  onmessage: ((event: MessageEvent) => void) | null};
let adapter: ReturnType<typeof loadSchedulingAdapter> | undefined;
scope.onmessage = async ({data}: MessageEvent<{id: number; problem: Problem;
  settings: {seed: number; seconds: number; nodes: number}}>) => {
  const {id, problem, settings} = data;
  try {
    adapter ??= loadSchedulingAdapter();
    const solver = await adapter;
    scope.postMessage({id, type: 'solving'});
    const result = solveProblem(solver, problem, settings,
      progress => scope.postMessage({id, type: 'progress', progress}));
    scope.postMessage({id, type: 'result', result, initMs: solver.initMs, version: solver.version});
  } catch (error) {
    scope.postMessage({id, type: 'error', message: error instanceof Error ? error.message : String(error)});
  }
};
