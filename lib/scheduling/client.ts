import {createSolverWorker} from './solver/client.ts';
import {prepareGeneration} from './domain.ts';
import {acceptGeneration, createGenerationRequest, finishGeneration, progressReporter, type GenerationProgress, type RunOptions} from './generate.ts';
import type {GenerationInput} from './types.ts';

/** Cancellation terminates synchronous WASM. Recreate after cancellation/error.
 * The caller retains accepted data; this API never applies or persists a draft. */
export function createGenerationWorker(clock: () => number = Date.now) {
  const worker = createSolverWorker();
  return {
    terminate: worker.terminate,
    async run(input: GenerationInput, options: Omit<RunOptions, 'now'> = {}, onProgress?: (p: GenerationProgress) => void) {
      const request = createGenerationRequest(input, {...options, now: clock()});
      const prepared = prepareGeneration(request.input);
      const reply = await worker.run(prepared.problem, request.settings, undefined, progressReporter(prepared, onProgress));
      const result = finishGeneration(prepared, reply.result, request, reply.version);
      return acceptGeneration(result, input, clock());
    },
  };
}
