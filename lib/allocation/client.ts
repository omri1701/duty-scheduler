import type {AllocationDraft, AllocationInput, Check, Kind} from './types.ts';
import type {PrimaryAssignments} from '../scheduling/validate.ts';
import type {compileAllocation} from './compile.ts';

export type AllocationOperation = {input: AllocationInput} & (
  {kind: 'propose'} | {kind: 'assess'; draft: AllocationDraft; copied?: boolean} |
  {kind: 'compile'; draft: AllocationDraft; assignments: PrimaryAssignments} |
  {kind: 'edit'; draft: AllocationDraft; edit: {id: string; engineer: string; deltaUnits: number; kind: Kind}}
);
export type AllocationReply = {draft: AllocationDraft; check: Check; optimal?: boolean; compiled?: ReturnType<typeof compileAllocation>};

export function schedulingSupported() {
  return typeof Worker !== 'undefined' && typeof WebAssembly !== 'undefined' && typeof WebAssembly.instantiate === 'function';
}
/** One operation per Worker. Termination cancels even synchronous WASM calls. */
export function createAllocationWorker() {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), {type: 'module'});
  let rejectPending: ((error: Error) => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let used = false;
  const terminate = () => {worker.terminate(); clearTimeout(timer); rejectPending?.(Error('Worker terminated')); rejectPending = undefined;};
  return {terminate, run(operation: AllocationOperation): Promise<AllocationReply> {
    if (used) return Promise.reject(Error('Worker closed or busy'));
    used = true;
    return new Promise((resolve, reject) => {
      rejectPending = reject;
      timer = setTimeout(() => {terminate();}, 45_000);
      worker.onerror = () => {terminate();};
      worker.onmessage = ({data}) => {
        rejectPending = undefined; terminate();
        if (data.type === 'result') resolve(data.value); else reject(Error(data.message));
      };
      worker.postMessage(operation);
    });
  }};
}
