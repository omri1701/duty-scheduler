import {binaryValues, checkProblem, decodeAssignment, validateAssignment, type Metrics, type Problem} from './problem.ts';
import type {SolverAdapter, SolverResult} from './highs-adapter.ts';

type Term = [number, string];
type Stage = {name: string; terms: Term[]};
const expression = (terms: Term[]) => terms.length ? terms.map(([n, v]) => `${n < 0 ? '-' : '+'} ${Math.abs(n)} ${v}`).join(' ') : '0 dummy';
const score = (name: string, m: Metrics) => name === 'coverage' ? -m.coverage : name === 'special' ? -m.special :
  name === 'units' ? -m.units : m.gaps.filter(g => g === Number(name.slice(4))).length;

export function buildModel(p: Problem) {
  checkProblem(p);
  // A fixed binary keeps MIP diagnostics defined even when all eligible edges are absent.
  const rows: string[] = [], binary: string[] = ['dummy'], stages: Stage[] = [];
  const row = (terms: Term[], op: string, rhs: number) => rows.push(`${expression(terms)} ${op} ${rhs}`);
  const x = (e: number, i: number) => `x_${e}_${i}`;
  const coverage: Term[] = [], special: Term[] = [], units: Term[] = [];
  for (const [i, d] of p.duties.entries()) {
    const terms: Term[] = d.eligible.map(e => [1, x(e, i)]);
    binary.push(...terms.map(t => t[1]));
    row(terms, '<=', 1);
    if (d.lock !== undefined) row([[1, x(d.lock, i)]], '=', 1);
    for (const e of d.eligible) {
      coverage.push([-d.days, x(e, i)]);
      if (d.special) special.push([-d.special, x(e, i)]);
      units.push([-d.units, x(e, i)]);
    }
  }
  const gapTerms = new Map<number, Term[]>();
  for (let e = 0; e < p.targets.length; e++) {
    const ids = p.duties.flatMap((d, i) => d.eligible.includes(e) ? [i] : []);
    row(ids.map(i => [p.duties[i].units, x(e, i)]), '<=', p.targets[e]);
    const weekends = new Map<number, number[]>();
    for (const i of ids) {
      const w = p.duties[i].weekend;
      if (w !== undefined) weekends.set(w, [...(weekends.get(w) ?? []), i]);
    }
    const ys: Term[] = [];
    for (const [w, ds] of weekends) {
      const y = `w_${e}_${w}`; binary.push(y); ys.push([1, y]);
      for (const i of ds) row([[1, x(e, i)], [-1, y]], '<=', 0);
      row([[1, y], ...ds.map(i => [-1, x(e, i)] as Term)], '<=', 0);
    }
    row(ys, '<=', 1);
    for (const [a, i] of ids.entries()) for (const j of ids.slice(a + 1)) {
      if (p.duties[j].start <= p.duties[i].end) row([[1, x(e, i)], [1, x(e, j)]], '<=', 1);
    }
    if (!p.spacing || !ids.length) continue;
    // One chronological path: source -> selected nodes -> sink. Empty path is legal.
    const incoming = new Map(ids.map(i => [i, [] as Term[]]));
    const outgoing = new Map(ids.map(i => [i, [] as Term[]]));
    const source: Term[] = [], sink: Term[] = [];
    const empty = `empty_${e}`; binary.push(empty); source.push([1, empty]); sink.push([1, empty]);
    for (const [a, i] of ids.entries()) {
      const first = `first_${e}_${i}`, last = `last_${e}_${i}`;
      binary.push(first, last); source.push([1, first]); sink.push([1, last]);
      incoming.get(i)!.push([1, first]); outgoing.get(i)!.push([1, last]);
      for (const j of ids.slice(a + 1)) {
        const gap = p.duties[j].start - p.duties[i].end;
        if (gap <= 0) continue;
        const arc = `a_${e}_${i}_${j}`; binary.push(arc);
        incoming.get(j)!.push([1, arc]); outgoing.get(i)!.push([1, arc]);
        gapTerms.set(gap, [...(gapTerms.get(gap) ?? []), [1, arc]]);
      }
    }
    row(source, '=', 1); row(sink, '=', 1);
    for (const i of ids) {
      row([...incoming.get(i)!, [-1, x(e, i)]], '=', 0);
      row([...outgoing.get(i)!, [-1, x(e, i)]], '=', 0);
    }
  }
  stages.push({name: 'coverage', terms: coverage}, {name: 'special', terms: special}, {name: 'units', terms: units});
  for (const [gap, terms] of [...gapTerms].sort(([a], [b]) => a - b)) stages.push({name: `gap:${gap}`, terms});
  return {stages, columns: binary.length, rows: rows.length,
    lp(stage: Stage, fixed: string[]) {
      return `Minimize\n obj: ${expression(stage.terms)}\nSubject To\n${[...rows, ...fixed].map((r, i) => ` r${i}: ${r}`).join('\n')}\nBounds\n dummy = 0\nBinary\n${binary.join('\n')}\nEnd`;
    }};
}

export function solveProblem(adapter: SolverAdapter, p: Problem,
  settings = {seed: 17, seconds: 5, nodes: 10000}) {
  if (!Number.isInteger(settings.seed) || settings.seed < 0 || settings.seed > 2147483647 ||
    !Number.isFinite(settings.seconds) || settings.seconds < 0 ||
    !Number.isInteger(settings.nodes) || settings.nodes < 0 || settings.nodes > 2147483647) throw Error('Invalid solver settings');
  const started = performance.now(), model = buildModel(p), buildMs = performance.now() - started;
  const fixed: string[] = [], stages: (Omit<SolverResult, 'values'> & {name: string; proved: boolean})[] = [];
  let assignment = p.duties.map(d => d.lock ?? null);
  let metrics = validateAssignment(p, assignment);
  let remainingNodes = settings.nodes;
  for (const stage of model.stages) {
    const seconds = settings.seconds - (performance.now() - started) / 1000;
    if (seconds <= 0 || remainingNodes < 0) break;
    const result = adapter.solve(model.lp(stage, fixed), {...settings, seconds, nodes: remainingNodes});
    remainingNodes -= result.nodes;
    let value: number | null = null;
    if (result.values) {
      const values = binaryValues(result.values);
      const candidate = decodeAssignment(p, values), checked = validateAssignment(p, candidate);
      const candidateValue = stage.terms.reduce((n, [c, v]) => n + c * values[v], 0);
      if (!Number.isSafeInteger(candidateValue)) throw Error('Noninteger objective');
      for (const prior of stages) {
        const old = model.stages.find(s => s.name === prior.name)!;
        if (old.terms.reduce((n, [c, v]) => n + c * values[v], 0) !== prior.objective ||
          score(prior.name, checked) !== prior.objective) throw Error('Prior objective degraded');
      }
      // Recompute spacing objective from actual successors, independent of arc variables.
      const expected = score(stage.name, checked);
      if (candidateValue !== expected || result.objective === null || Math.abs(candidateValue - result.objective) > 1e-7) throw Error('Objective mismatch');
      value = candidateValue;
      if (value <= score(stage.name, metrics)) {assignment = candidate; metrics = checked;}
    }
    // Integer objectives: a lower bound strictly above value-1 rules out improvement.
    // Account for floating representation of an otherwise exact optimum (e.g. -30.00000000000002).
    const proved = value !== null && result.status === 'optimal' && result.bound > value - 1 &&
      result.bound <= value + 1e-7 && result.gap === 0;
    if (proved && score(stage.name, metrics) !== value) throw Error('Optimum contradicts verified incumbent');
    const {values: discardedValues, ...metadata} = result;
    void discardedValues;
    stages.push({...metadata, objective: value, name: stage.name, proved});
    if (!proved) break;
    fixed.push(`${expression(stage.terms)} = ${value}`);
  }
  return {assignment, metrics, stages, provedPrefix: stages.filter(s => s.proved).map(s => s.name),
    complete: metrics.deficits.every(n => n === 0) && assignment.every(e => e !== null),
    allStagesProved: stages.length === model.stages.length && stages.every(s => s.proved),
    termination: stages.length < model.stages.length && stages.every(s => s.proved) ? 'budget' : stages.at(-1)?.status ?? 'budget',
    buildMs, elapsedMs: performance.now() - started, columns: model.columns, rows: model.rows,
    memoryBytes: adapter.memoryBytes, activeModels: adapter.activeModels};
}
