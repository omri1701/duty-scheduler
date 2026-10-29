import {loadSchedulingAdapter} from '../scheduling/solver/load.ts';
import {proposeAllocation, assessAllocation} from './planner.ts';
import {editAllocation, transferAllocation} from './edits.ts';
import {compileAllocation} from './compile.ts';
import {reviewAllocation} from './review.ts';
import {context} from './model.ts';
import type {AllocationOperation} from './client.ts';

const scope = self as unknown as {postMessage: (value: unknown) => void; onmessage: ((event: MessageEvent<AllocationOperation>) => void) | null};
scope.onmessage = async ({data}) => {
  let adapter: Awaited<ReturnType<typeof loadSchedulingAdapter>> | undefined;
  try {
    adapter = await loadSchedulingAdapter();
    const {input} = data;
    const settings = {seconds: data.kind === 'propose' ? 15 : 5, seed: 17};
    if (data.kind === 'propose') {
      const p = proposeAllocation(adapter, input, settings);
      scope.postMessage({type: 'result', value: {draft: p.draft, check: p.check, optimal: p.optimal}});
    } else {
      const copied = data.kind === 'assess' && data.copied;
      let draft = copied ? {...data.draft, sourceKey: context(input).key} : reviewAllocation(input, data.draft);
      if (data.kind === 'edit') draft = editAllocation(adapter, input, draft, data.edit, settings).draft;
      if (data.kind === 'transfer') draft = transferAllocation(input, draft, data.transfer).draft;
      const check = assessAllocation(adapter, input, draft, data.kind === 'assess' ? settings : {...settings, seconds: 0});
      scope.postMessage({type: 'result', value: {draft: copied ? data.draft : draft, check,
        ...(data.kind === 'compile' ? {compiled: compileAllocation(input, draft, data.assignments)} : {})}});
    }
  } catch (e) {scope.postMessage({type: 'error', message: e instanceof Error ? e.message : String(e)});}
};
