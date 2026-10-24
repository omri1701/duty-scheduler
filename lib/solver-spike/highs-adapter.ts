import type loadHighs from 'highs';
import type {Highs, InitOptions} from 'highs';
import type {Settings} from './settings.ts';
export type {Settings} from './settings.ts';

export type Term = [number, string];
export type Column = {name: string; binary?: boolean; lower?: number; upper?: number};
export type Row = {terms: Term[]; lower?: number; upper?: number};
export type SolverResult = {
  status: string; statusCode: number; values: Record<string, number> | null;
  objective: number | null; bound: number; gap: number; nodes: number;
  elapsedMs: number; memoryBytes: number;
};

/** Spike only. Native model lifetime is one generation request. */
export async function createHighsAdapter(load: typeof loadHighs, options?: InitOptions) {
  const started = performance.now();
  const highs: Highs = await load(options);
  const initMs = performance.now() - started;
  let activeModels = 0, modelsCreated = 0, startsSubmitted = 0;
  function createSession(lp?: string) {
    const model = highs.createModel();
    activeModels++; modelsCreated++;
    let closed = false;
    const dispose = () => {if (!closed) {closed = true; model.dispose(); activeModels--;}};
    const names: string[] = [], indices = new Map<string, number>();
    let objective: number[] = [];
    const coordinate = (name: string) => {
      const i = indices.get(name);
      if (i === undefined) throw Error(`Unknown column ${name}`);
      return i;
    };
    const bound = (n: number) => n === Infinity ? highs.infinity : n === -Infinity ? -highs.infinity : n;
    try {
      if (lp) {
        model.readModel({format: 'lp', data: lp});
        for (let i = 0; i < model.getDimensions().numCols; i++) {const name = model.getColName(i); names.push(name); indices.set(name, i);}
      }
    } catch (error) {dispose(); throw error;}
    return {
      dispose,
      addColumns(columns: Column[]) {
        if (!columns.length) return;
        const offset = names.length;
        model.addVars(columns.map(c => c.lower ?? 0), columns.map(c => c.upper ?? 1));
        const integers: number[] = [];
        columns.forEach((c, i) => {
          if (indices.has(c.name)) throw Error('Duplicate column');
          names.push(c.name); indices.set(c.name, offset + i);
          if (c.binary) integers.push(offset + i);
        });
        if (integers.length) model.changeColsIntegrality({kind: 'set', indices: integers}, integers.map(() => highs.constants.variableType.integer));
      },
      addRows(rows: Row[]) {
        const offset = model.getDimensions().numRows;
        if (!rows.length) return offset;
        const starts = [0], cols: number[] = [], values: number[] = [];
        for (const r of rows) {
          for (const [v, name] of r.terms) {cols.push(coordinate(name)); values.push(v);}
          starts.push(cols.length);
        }
        model.addRows({lower: Float64Array.from(rows, r => bound(r.lower ?? -Infinity)),
          upper: Float64Array.from(rows, r => bound(r.upper ?? Infinity)),
          matrix: {format: 'csr', numRows: rows.length, numCols: names.length,
            starts: Int32Array.from(starts), indices: Int32Array.from(cols), values: Float64Array.from(values)}});
        return offset;
      },
      deleteRows(offset: number, count: number) {
        if (count) model.deleteRows({kind: 'range', from: offset, to: offset + count - 1});
      },
      setObjective(terms: Term[]) {
        const costs = new Map(terms.map(([v, name]) => [coordinate(name), v]));
        const changed = [...new Set([...objective, ...costs.keys()])].sort((a, b) => a - b);
        if (changed.length) model.changeColsCost({kind: 'set', indices: changed}, changed.map(i => costs.get(i) ?? 0));
        objective = [...costs.keys()];
      },
      zeroColumns(terms: Term[]) {
        const cols = terms.map(([, name]) => coordinate(name)).sort((a, b) => a - b);
        if (cols.length) model.changeColsBounds({kind: 'set', indices: cols}, cols.map(() => 0), cols.map(() => 0));
      },
      run(settings: Settings, start?: Record<string, number>): SolverResult {
        const began = performance.now();
        model.zeroAllClocks(); // Native time_limit is cumulative across runs.
        model.options.set({output_flag: false, solver: 'choose', random_seed: settings.seed,
          time_limit: settings.seconds, mip_max_nodes: settings.nodes, mip_rel_gap: 0, mip_abs_gap: 0,
          mip_feasibility_tolerance: 1e-8});
        if (start) {
          const entries = Object.entries(start).map(([name, v]) => [coordinate(name), v]).sort(([a], [b]) => a - b);
          model.setSolution({indices: entries.map(([i]) => i), values: entries.map(([, v]) => v)});
          startsSubmitted++;
        }
        const {modelStatus} = model.run();
        const status = Object.entries(highs.constants.modelStatus).find(([, code]) => code === modelStatus)?.[0] ?? 'unknown';
        const feasible = model.info.get('primal_solution_status') === highs.constants.solutionStatus.feasible;
        const values = feasible ? Object.fromEntries(Array.from(model.getSolution().colValue, (v, i) => [names[i], v])) : null;
        return {status, statusCode: modelStatus, values, objective: feasible ? model.getObjectiveValue() : null,
          bound: Number(model.info.get('mip_dual_bound')), gap: Number(model.info.get('mip_gap')),
          nodes: Number(model.info.get('mip_node_count')), elapsedMs: performance.now() - began, memoryBytes: highs.memoryBytes};
      },
    };
  }
  return {
    initMs, version: highs.version, createSession,
    get memoryBytes() {return highs.memoryBytes;}, get activeModels() {return activeModels;},
    get modelsCreated() {return modelsCreated;}, get startsSubmitted() {return startsSubmitted;},
    /** Retained for native status/parser checks. Scheduling uses createSession. */
    solve(lp: string, settings: Settings) {
      const session = createSession(lp);
      try {return session.run(settings);} finally {session.dispose();}
    },
  };
}
export type SolverAdapter = Awaited<ReturnType<typeof createHighsAdapter>>;
