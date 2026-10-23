import type loadHighs from 'highs';
import type {Highs, InitOptions} from 'highs';

export type SolverResult = {
  status: string; statusCode: number; values: Record<string, number> | null;
  objective: number | null; bound: number; gap: number; nodes: number;
  elapsedMs: number; memoryBytes: number;
};

/** Spike only. No imports from the existing engine, UI or persistence. */
export async function createHighsAdapter(load: typeof loadHighs, options?: InitOptions) {
  const started = performance.now();
  const highs: Highs = await load(options);
  const initMs = performance.now() - started;
  let activeModels = 0;
  return {
    initMs, version: highs.version,
    get memoryBytes() { return highs.memoryBytes; },
    get activeModels() { return activeModels; },
    solve(lp: string, settings: {seed: number; seconds: number; nodes: number}): SolverResult {
      const start = performance.now();
      const model = highs.createModel();
      activeModels++;
      try {
        model.options.set({output_flag: false, solver: 'choose',
          random_seed: settings.seed, time_limit: settings.seconds,
          mip_max_nodes: settings.nodes, mip_rel_gap: 0, mip_abs_gap: 0,
          mip_feasibility_tolerance: 1e-8});
        model.readModel({format: 'lp', data: lp});
        const {modelStatus} = model.run();
        const status = Object.entries(highs.constants.modelStatus).find(([, code]) => code === modelStatus)?.[0] ?? 'unknown';
        const feasible = model.info.get('primal_solution_status') === highs.constants.solutionStatus.feasible;
        const values = feasible ? Object.fromEntries(Array.from(model.getSolution().colValue,
          (value, index) => [model.getColName(index), value])) : null;
        return {status, statusCode: modelStatus, values,
          objective: feasible ? model.getObjectiveValue() : null,
          bound: Number(model.info.get('mip_dual_bound')), gap: Number(model.info.get('mip_gap')),
          nodes: Number(model.info.get('mip_node_count')), elapsedMs: performance.now() - start,
          memoryBytes: highs.memoryBytes};
      } finally {
        model.dispose();
        activeModels--;
      }
    },
  };
}
export type SolverAdapter = Awaited<ReturnType<typeof createHighsAdapter>>;
