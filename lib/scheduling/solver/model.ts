import {anchors, approvedBoundary, approvedPair, binaryValues, checkProblem, compareMetrics,
  decodeAssignment, validateAssignment, type Metrics, type Problem} from './problem.ts';
import type {Column, Row, Settings, SolverAdapter, SolverResult, Term} from './highs-adapter.ts';
import {defaultSettings} from './settings.ts';

type Stage = {name: string; terms: Term[]};
type ProofStage = Omit<SolverResult, 'values'> & {name: string; proved: boolean; evidence?: string};
export type Progress = {stage: string; assignment: (number | null)[]; metrics: Metrics; provedPrefix: string[]};
const x = (e: number, i: number) => `x_${e}_${i}`;
const minimum = (m: Metrics) => m.gaps[0] ?? Infinity;
const score = (name: string, m: Metrics) => name === 'coverage' ? -m.coverage : name === 'special' ? -m.special :
  name === 'units' ? -m.units : name === 'minimum-gap' ? minimum(m) : m.gaps.filter(g => g === Number(name.slice(4))).length;

/** Assignment/coverage model only. No successor columns or path constraints. */
export function buildModel(p: Problem, freeTargets = false) {
  checkProblem(p);
  // Allocation planning supplies its own variable target ceilings. Validate the
  // balanced source first; retain exactly the same assignment constraints.
  if (freeTargets) p = {...p, targets: p.targets.map(() => p.targets.reduce((a, b) => a + b, 0))};
  const columns: Column[] = [{name: 'dummy', binary: true, upper: 0}], rows: Row[] = [], gaps = new Set<number>();
  const coverage: Term[] = [], special: Term[] = [], units: Term[] = [];
  const ids = p.targets.map(() => [] as number[]);
  for (const [i, d] of p.duties.entries()) {
    rows.push({terms: d.eligible.map(e => [1, x(e, i)]), upper: 1});
    for (const e of d.eligible) {
      const boundaryConflict = (p.boundaries ?? []).some(b => b.engineer === e && d.start <= b.end && b.start <= d.end &&
        !(d.lock === e && approvedBoundary(p, i, b)));
      const allowed = !boundaryConflict && d.units <= p.targets[e] && (d.lock === undefined || d.lock === e);
      columns.push({name: x(e, i), binary: true, lower: d.lock === e ? 1 : 0, upper: allowed ? 1 : 0});
      if (allowed) ids[e].push(i);
      coverage.push([-d.days, x(e, i)]);
      if (d.special) special.push([-d.special, x(e, i)]);
      units.push([-d.units, x(e, i)]);
    }
  }
  for (let e = 0; e < p.targets.length; e++) {
    rows.push({terms: ids[e].map(i => [p.duties[i].units, x(e, i)]), upper: p.targets[e]});
    const weekends = new Map<number, number[]>();
    for (const i of ids[e]) {
      const w = p.duties[i].weekend;
      if (w !== undefined) weekends.set(w, [...(weekends.get(w) ?? []), i]);
    }
    const ys: Term[] = [], approval = p.exceptions?.weekends?.find(a => a.engineer === e);
    for (const [w, ds] of weekends) {
      const y = `w_${e}_${w}`;
      columns.push({name: y, upper: approval && !approval.weekends.includes(w) ? 0 : 1}); ys.push([1, y]);
      for (const i of ds) rows.push({terms: [[1, x(e, i)], [-1, y]], upper: 0});
      rows.push({terms: [[1, y], ...ds.map(i => [-1, x(e, i)] as Term)], upper: 0});
    }
    if (!approval) rows.push({terms: ys, upper: 1});
    for (const [a, i] of ids[e].entries()) for (const j of ids[e].slice(a + 1)) {
      const gap = p.duties[j].start - p.duties[i].end, terms: Term[] = [[1, x(e, i)], [1, x(e, j)]];
      if (gap === 0 && !approvedPair(p, i, j)) rows.push({terms, upper: 1});
      else if (p.duties[i].units + p.duties[j].units <= p.targets[e]) gaps.add(gap);
    }
    const {before, after} = anchors(p, e);
    for (const i of ids[e]) {
      if (before) gaps.add(p.duties[i].start - before.end);
      if (after) gaps.add(after.start - p.duties[i].end);
    }
  }
  rows.push(...capacityRows(p, ids, 0));
  return {columns, rows, gaps: [...gaps].sort((a, b) => a - b), ids, stages: [{name: 'coverage', terms: coverage},
    {name: 'special', terms: special}, {name: 'units', terms: units}] as Stage[]};
}

/** With binary x, acyclic unit flow through every selected node has a unique integral path. */
function buildFlows(p: Problem, ids: number[][], gapFloor: number) {
  const columns: Column[] = [], rows: Row[] = [], gaps = new Map<number, Term[]>();
  for (let e = 0; e < p.targets.length; e++) {
    if (!ids[e].length) continue;
    const locked = ids[e].filter(i => p.duties[i].lock === e);
    const lockedUnits = locked.reduce((n, i) => n + p.duties[i].units, 0);
    const incoming = new Map(ids[e].map(i => [i, [] as Term[]]));
    const outgoing = new Map(ids[e].map(i => [i, [] as Term[]]));
    const source: Term[] = [], sink: Term[] = [];
    const arc = (name: string, from: Term[], to: Term[], gap?: number) => {
      if (gap !== undefined && gap < gapFloor) return;
      columns.push({name}); from.push([1, name]); to.push([1, name]);
      if (gap !== undefined) gaps.set(gap, [...(gaps.get(gap) ?? []), [1, name]]);
    };
    if (!locked.length) arc(`empty_${e}`, source, sink); // No anchor-to-anchor score.
    const {before, after} = anchors(p, e);
    for (const [a, i] of ids[e].entries()) {
      if (!locked.some(k => k < i)) arc(`first_${e}_${i}`, source, incoming.get(i)!, before ? p.duties[i].start - before.end : undefined);
      if (!locked.some(k => k > i)) arc(`last_${e}_${i}`, outgoing.get(i)!, sink, after ? after.start - p.duties[i].end : undefined);
      for (const j of ids[e].slice(a + 1)) {
        const gap = p.duties[j].start - p.duties[i].end;
        const required = lockedUnits + (p.duties[i].lock === e ? 0 : p.duties[i].units) +
          (p.duties[j].lock === e ? 0 : p.duties[j].units);
        if ((gap === 0 && !approvedPair(p, i, j)) || locked.some(k => i < k && k < j) || required > p.targets[e]) continue;
        arc(`a_${e}_${i}_${j}`, outgoing.get(i)!, incoming.get(j)!, gap);
      }
    }
    rows.push({terms: source, lower: 1, upper: 1}, {terms: sink, lower: 1, upper: 1});
    for (const i of ids[e]) {
      rows.push({terms: [...incoming.get(i)!, [-1, x(e, i)]], lower: 0, upper: 0},
        {terms: [...outgoing.get(i)!, [-1, x(e, i)]], lower: 0, upper: 0});
    }
  }
  rows.push(...capacityRows(p, ids, gapFloor));
  return {columns, rows, stages: [...gaps].sort(([a], [b]) => a - b).map(([g, terms]) => ({name: `gap:${g}`, terms}))};
}

/** Valid per-engineer capacity cuts. Integer point totals and weekend use are
 * strongly coupled (e.g. one half-weekend cannot fill an even ordinary target).
 * A small weighted-interval DP computes maxima with/without a weekend. It does
 * not choose the schedule. Large synthetic targets simply omit this optional cut. */
function capacityRows(p: Problem, ids: number[][], g: number): Row[] {
  const rows: Row[] = [];
  for (let e = 0; e < ids.length; e++) {
    if (p.targets[e] > 4096 || p.exceptions?.weekends?.some(a => a.engineer === e)) continue;
    const locked = ids[e].filter(i => p.duties[i].lock === e), {before, after} = anchors(p, e);
    const states = ids[e].map(() => new Map<number, Set<number>>());
    let without = locked.length ? -1 : 0, withWeekend = -1;
    for (let a = 0; a < ids[e].length; a++) {
      const i = ids[e][a], d = p.duties[i], current = states[a];
      const append = (weekend: number, units: number) => {
        if (d.weekend !== undefined && weekend !== -1 && weekend !== d.weekend) return;
        const total = units + d.units;
        if (total > p.targets[e]) return;
        const w = d.weekend ?? weekend;
        if (!current.has(w)) current.set(w, new Set());
        current.get(w)!.add(total);
      };
      if (!locked.some(k => k < i) && (!before || d.start - before.end >= g)) append(-1, 0);
      for (let b = 0; b < a; b++) {
        const j = ids[e][b], gap = d.start - p.duties[j].end;
        if (gap < g || (gap === 0 && !approvedPair(p, j, i)) || locked.some(k => j < k && k < i)) continue;
        for (const [w, totals] of states[b]) for (const units of totals) append(w, units);
      }
      if (locked.some(k => k > i) || (after && after.start - d.end < g)) continue;
      for (const [w, totals] of current) for (const units of totals) {
        if (w === -1) without = Math.max(without, units);
        else withWeekend = Math.max(withWeekend, units);
      }
    }
    const assigned: Term[] = ids[e].map(i => [p.duties[i].units, x(e, i)]);
    const weekends: Term[] = [...new Set(ids[e].flatMap(i => p.duties[i].weekend === undefined ? [] : [p.duties[i].weekend!]))]
      .map(w => [1, `w_${e}_${w}`]);
    if (without < 0 && withWeekend < 0) rows.push({terms: [], upper: -1});
    else if (without < 0) rows.push({terms: assigned, upper: withWeekend}, {terms: weekends, lower: 1});
    else if (withWeekend < 0) rows.push({terms: assigned, upper: without}, {terms: weekends, upper: 0});
    else if (without !== p.targets[e] || withWeekend !== p.targets[e]) rows.push({terms: [...assigned,
      ...(without === withWeekend ? [] : weekends.map(([, name]) => [without - withWeekend, name] as Term))], upper: without});
  }
  return rows;
}

/** Expanded intervals [start,end+g) form an interval graph. Maximal cliques
 * enforce all threshold conflicts and strengthen the pairwise LP relaxation. */
function thresholdRows(p: Problem, ids: number[][], g: number): Row[] {
  const rows: Row[] = [];
  for (let e = 0; e < ids.length; e++) {
    let right = 0, previousRight = -1;
    for (let a = 0; a < ids[e].length; a++) {
      right = Math.max(right, a + 1);
      while (right < ids[e].length && p.duties[ids[e][right]].start < p.duties[ids[e][a]].end + g) right++;
      if (right - a > 1 && right !== previousRight) {
        rows.push({terms: ids[e].slice(a, right).map(i => [1, x(e, i)]), upper: 1});
        previousRight = right;
      }
    }
    const {before, after} = anchors(p, e);
    const blocked = ids[e].filter(i => (before && p.duties[i].start - before.end < g) ||
      (after && after.start - p.duties[i].end < g));
    if (blocked.length) rows.push({terms: blocked.map(i => [1, x(e, i)]), upper: 0});
  }
  rows.push(...capacityRows(p, ids, g));
  return rows;
}

export function solveProblem(adapter: SolverAdapter, p: Problem, settings: Settings = defaultSettings,
  onProgress?: (progress: Progress) => void) {
  if (!Number.isInteger(settings.seed) || settings.seed < 0 || settings.seed > 2147483647 ||
    !Number.isFinite(settings.seconds) || settings.seconds < 0 ||
    !Number.isInteger(settings.nodes) || settings.nodes < 0 || settings.nodes > 2147483647) throw Error('Invalid solver settings');
  const started = performance.now(), base = buildModel(p), buildMs = performance.now() - started;
  let random = settings.seed >>> 0;
  const preference: Stage = {name: 'preferred', terms: (p.preferences ?? []).map(v => [-v.weight, x(v.engineer, v.duty)])};
  const seeded: Stage = {name: 'seed', terms: p.seededTies ? p.duties.flatMap((d, i) => d.eligible.map(e => {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    return [random % 1000000, x(e, i)] as Term;
  })) : []};
  const secondary = [preference, seeded];
  const objective = (name: string, m: Metrics, a: (number | null)[]) => {
    const stage = secondary.find(s => s.name === name);
    return stage ? stage.terms.reduce((sum, [c, variable]) => {
      const [, e, i] = variable.split('_').map(Number);
      return sum + (a[i] === e ? c : 0);
    }, 0) : score(name, m);
  };
  const stages: ProofStage[] = [], thresholds: (Omit<SolverResult, 'values'> & {threshold: number | null; feasible: boolean | null})[] = [];
  let assignment = p.duties.map(d => d.lock ?? null), metrics = validateAssignment(p, assignment);
  let remainingNodes = settings.nodes, columns = base.columns.length, rows = base.rows.length, peakRows = rows, finished = false;
  let minimumGap: {lower: number | null; upper: number | null; proved: boolean} | undefined;
  let termination = 'budget';
  const created = adapter.modelsCreated, submitted = adapter.startsSubmitted;
  const session = adapter.createSession();
  const prefix = () => stages.filter(s => s.proved).map(s => s.name);
  const progress = (stage: string) => onProgress?.({stage, assignment: [...assignment], metrics, provedPrefix: prefix()});
  const identity = (name: string, value: number, evidence: string) => {
    stages.push({name, objective: value, bound: value, gap: 0, nodes: 0, elapsedMs: 0,
      memoryBytes: adapter.memoryBytes, status: 'identity', statusCode: 0, proved: true, evidence});
    progress(name);
  };
  const startValues = () => Object.fromEntries(p.duties.flatMap((d, i) => d.eligible.map(e => [x(e, i), assignment[i] === e ? 1 : 0])));
  const run = (terms: Term[], reuse = true) => {
    const seconds = settings.seconds - (performance.now() - started) / 1000;
    if (seconds <= 0 || remainingNodes < 0) return null;
    session.setObjective(terms);
    const result = session.run({...settings, seconds, nodes: remainingNodes}, reuse ? startValues() : undefined);
    remainingNodes -= result.nodes;
    termination = result.status;
    return result;
  };
  const candidate = (result: SolverResult, terms: Term[], name?: string, floor?: number) => {
    if (!result.values) return null;
    const values = binaryValues(result.values), a = decodeAssignment(p, values), m = validateAssignment(p, a);
    for (const stage of stages) if (stage.proved && objective(stage.name, m, a) !== stage.objective) throw Error('Prior objective degraded');
    if (floor !== undefined && minimum(m) < floor) throw Error('Threshold violated');
    const value = terms.reduce((n, [c, v]) => n + c * values[v], 0);
    if (!Number.isSafeInteger(value) || (name && value !== objective(name, m, a)) || result.objective === null ||
      Math.abs(value - result.objective) > 1e-7) throw Error('Objective mismatch');
    const comparison = compareMetrics(m, metrics, p.spacing);
    if (comparison < 0 || (comparison === 0 && name && secondary.some(s => s.name === name) &&
      value < objective(name, metrics, assignment))) {assignment = a; metrics = m; progress(name ?? 'threshold');}
    return value;
  };
  const optimize = (stage: Stage) => {
    const initial = objective(stage.name, metrics, assignment);
    if (!stage.terms.length || (stage.name.startsWith('gap:') && initial === 0)) {
      identity(stage.name, initial, 'Nonnegative count at zero');
      if (stage.terms.length) session.zeroColumns(stage.terms);
      return true;
    }
    const result = run(stage.terms);
    if (!result) {termination = 'budget'; return false;}
    if (result.status === 'infeasible') throw Error('Optional-coverage model contradicts verified incumbent');
    const value = candidate(result, stage.terms, stage.name);
    const proved = value !== null && result.status === 'optimal' && result.bound > value - 1 &&
      result.bound <= value + 1e-7 && result.gap === 0;
    if (proved && objective(stage.name, metrics, assignment) !== value) throw Error('Optimum contradicts verified incumbent');
    const {values: discarded, ...metadata} = result; void discarded;
    stages.push({...metadata, name: stage.name, objective: value, proved});
    progress(stage.name);
    if (proved) {
      if (stage.name.startsWith('gap:') && value === 0) session.zeroColumns(stage.terms);
      else {session.addRows([{terms: stage.terms, lower: value!, upper: value!}]); rows++;}
    }
    return proved;
  };
  try {
    session.addColumns(base.columns); session.addRows(base.rows);
    let coverageProved = true;
    for (const stage of base.stages) {
      if (stage.name !== 'coverage' && metrics.coverage === p.duties.reduce((n, d) => n + d.days, 0)) {
        identity(stage.name, score(stage.name, metrics), 'Full coverage and target conservation');
      } else if (!optimize(stage)) {coverageProved = false; break;}
    }
    if (coverageProved && !p.spacing) finished = true;
    if (coverageProved && p.spacing) {
      const levels = base.gaps.concat(Infinity);
      const fixedMinimum = minimum(validateAssignment(p, p.duties.map(d => d.lock ?? null)));
      // Inserting duties between fixed intervals cannot improve their minimum gap.
      let lo = levels.indexOf(minimum(metrics));
      let hi = fixedMinimum === Infinity ? levels.length : levels.indexOf(fixedMinimum) + 1;
      if (lo < 0) throw Error('Missing incumbent gap threshold');
      let thresholdCount = 0, offset = rows;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2), floor = levels[mid];
        session.deleteRows(offset, thresholdCount);
        const constraints = thresholdRows(p, base.ids, floor);
        offset = session.addRows(constraints); thresholdCount = constraints.length;
        peakRows = Math.max(peakRows, rows + thresholdCount);
        const result = run([], minimum(metrics) >= floor);
        if (!result) {termination = 'budget'; break;}
        const value = candidate(result, [], undefined, floor);
        const feasible = value !== null ? true : result.status === 'infeasible' ? false : null;
        const {values: discarded, ...metadata} = result; void discarded;
        thresholds.push({...metadata, threshold: Number.isFinite(floor) ? floor : null, feasible});
        if (feasible === true) lo = Math.max(mid, levels.indexOf(minimum(metrics)));
        else if (feasible === false) hi = mid;
        else break; // UNKNOWN never becomes an infeasibility proof.
      }
      session.deleteRows(offset, thresholdCount);
      const proved = hi - lo === 1, floor = levels[lo];
      minimumGap = {lower: Number.isFinite(floor) ? floor : null,
        upper: hi === levels.length || levels[hi] === Infinity ? null : levels[hi], proved};
      if (proved) {
        identity('minimum-gap', floor, 'Verified witness and discrete infeasibility/fixed-interval bound');
        if (floor === Infinity) {
          // A gap-free witness alone is insufficient once secondary objectives
          // run: they must also preserve the vacuous infinite minimum.
          const constraints = thresholdRows(p, base.ids, floor);
          session.addRows(constraints); rows += constraints.length;
          finished = true;
        }
        else {
          const flows = buildFlows(p, base.ids, floor);
          session.addColumns(flows.columns); session.addRows(flows.rows);
          columns += flows.columns.length; rows += flows.rows.length;
          finished = true;
          for (const stage of flows.stages) if (!optimize(stage)) {finished = false; break;}
        }
      } else {
        stages.push({name: 'minimum-gap', status: termination, statusCode: 0, objective: floor,
          bound: minimumGap.upper ?? Infinity, gap: Infinity, nodes: 0, elapsedMs: 0,
          memoryBytes: adapter.memoryBytes, proved: false});
      }
    }
    if (finished) for (const stage of secondary.filter(s => s.terms.length)) {
      if (!optimize(stage)) {finished = false; break;}
    }
  } finally {session.dispose();}
  return {assignment, metrics, stages, thresholds, minimumGap, provedPrefix: prefix(),
    complete: metrics.deficits.every(n => n === 0) && assignment.every(e => e !== null),
    allStagesProved: finished, termination: finished ? 'optimal' : termination,
    buildMs, elapsedMs: performance.now() - started, baseColumns: base.columns.length,
    binaryColumns: base.columns.filter(c => c.binary).length, columns, rows, peakRows: Math.max(peakRows, rows),
    modelsCreated: adapter.modelsCreated - created, startsSubmitted: adapter.startsSubmitted - submitted,
    memoryBytes: adapter.memoryBytes, activeModels: adapter.activeModels};
}
