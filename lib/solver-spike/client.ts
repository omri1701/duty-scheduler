import type {Problem} from './problem.ts';
import type {solveProblem} from './model.ts';
import type {Progress} from './model.ts';
import {defaultSettings} from './settings.ts';

type Reply = {id: number; type: 'result'; result: ReturnType<typeof solveProblem>;
  initMs: number; version: {string: string; gitHash: string}};

/** Explicit lifetime: terminate after use, or to interrupt synchronous WASM. */
export function createSpikeWorker() {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), {type: 'module'});
  let nextId = 0, closed = false;
  let pending: {id: number; resolve: (reply: Reply) => void; reject: (error: Error) => void;
    onSolving?: () => void; onProgress?: (progress: Progress) => void; timer: ReturnType<typeof setTimeout>} | undefined;
  const terminate = () => {
    closed = true; worker.terminate();
    if (pending) {clearTimeout(pending.timer); pending.reject(new Error('Worker terminated')); pending = undefined;}
  };
  worker.onmessage = ({data}) => {
    if (!pending || data.id !== pending.id) return;
    if (data.type === 'solving') {pending.onSolving?.(); return;}
    if (data.type === 'progress') {pending.onProgress?.(data.progress); return;}
    const current = pending; pending = undefined; clearTimeout(current.timer);
    if (data.type === 'result') current.resolve(data);
    else {current.reject(new Error(data.message)); terminate();}
  };
  worker.onerror = () => {
    pending?.reject(new Error('Worker runtime/load failed'));
    terminate();
  };
  return {
    terminate,
    run(problem: Problem, settings = defaultSettings, onSolving?: () => void, onProgress?: (progress: Progress) => void) {
      if (closed || pending) return Promise.reject(new Error('Worker closed or busy'));
      const id = ++nextId;
      return new Promise<Reply>((resolve, reject) => {
        pending = {id, resolve, reject, onSolving, onProgress, timer: setTimeout(terminate, (settings.seconds + 30) * 1000)};
        try {worker.postMessage({id, problem, settings});}
        catch {terminate();}
      });
    },
  };
}
