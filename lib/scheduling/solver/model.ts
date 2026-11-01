import {anchors, approvedPair, binaryValues, boundaryBlocked, boundaryTouches, checkProblem, compareGaps, compareQuality,
  decodeAssignment, validateAssignment, weekendAllowance, type Metrics, type Problem} from './problem.ts';
import type {Column, Row, Settings, SolverAdapter, SolverResult, Term} from './highs-adapter.ts';
import {defaultSettings} from './settings.ts';

type Stage = {name: string; terms: Term[]};
/** What the proved extra-weekend and back-to-back levels still allow in later rows. */
type Slack = {adjacent: boolean; weekends: boolean};
type ProofStage = Omit<SolverResult, 'values'> & {name: string; proved: boolean; evidence?: string};
export type Progress = {stage: string; assignment: (number | null)[]; metrics: Metrics; provedPrefix: string[]};
const x = (e: number, i: number) => `x_${e}_${i}`;
const minimum = (m: Metrics) => m.gaps[0] ?? Infinity;
const score = (name: string, m: Metrics) => name === 'coverage' ? -m.coverage : name === 'special' ? -m.special :
  name === 'units' ? -m.units : name === 'minimum-gap' ? minimum(m) : name === 'rotation' ? m.rotation :
  name === 'preferred' ? -m.preferred : name === 'repeats' ? m.repeats : name === 'weekdays' ? m.weekdays :
  name === 'extra-weekends' ? m.extraWeekends : name === 'adjacent' ? m.adjacent :
  m.gaps.filter(g => g === Number(name.slice(4))).length;
/** Counter stages minimize continuous columns bounded below by their counts (r, z and b columns). */
const counters = new Set(['repeats', 'extra-weekends', 'adjacent']);
const counter = (column: string) => /^[rzb]_/.test(column);
/** Stages whose objective is a nonnegative sum of nonnegative columns: an incumbent at zero is optimal. */
const nonnegative = (name: string) => name.startsWith('gap:') || name === 'rotation' || name === 'weekdays' || counters.has(name);
/** 32-bit hash mixer (splitmix-style); every output bit depends on the whole state. */
function mixer(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let t = state ^ (state >>> 16); t = Math.imul(t, 0x21f0aaad);
    t ^= t >>> 15; t = Math.imul(t, 0x735a2d97);
    return (t ^ (t >>> 15)) >>> 0;
  };
}

/** Assignment/coverage model only. No successor columns or path constraints. Extra
 * weekends and unapproved back-to-back pairs are allowed here; their own counter
 * stages (buildSlack) minimize them before any spacing level. */
export function buildModel(p: Problem, freeTargets = false) {
  checkProblem(p);
  // Allocation planning supplies its own variable target ceilings. Validate the
  // balanced source first; retain exactly the same assignment constraints.
  if (freeTargets) p = {...p, targets: p.targets.map(() => p.targets.reduce((a, b) => a + b, 0))};
  const columns: Column[] = [{name: 'dummy', binary: true, upper: 0}], rows: Row[] = [], gaps = new Set<number>();
  const coverage: Term[] = [], special: Term[] = [], units: Term[] = [], rotation: Term[] = [], weekdays: Term[] = [];
  const ids = p.targets.map(() => [] as number[]);
  for (const [i, d] of p.duties.entries()) {
    rows.push({terms: d.eligible.map(e => [1, x(e, i)]), upper: 1});
    for (const e of d.eligible) {
      const allowed = !boundaryBlocked(p, e, i) && d.units <= p.targets[e] && (d.lock === undefined || d.lock === e);
      columns.push({name: x(e, i), binary: true, lower: d.lock === e ? 1 : 0, upper: allowed ? 1 : 0});
      if (allowed) ids[e].push(i);
      coverage.push([-d.days, x(e, i)]);
      if (d.special) special.push([-d.special, x(e, i)]);
      units.push([-d.units, x(e, i)]);
      // Weekday rotation: a Sunday–Thursday duty costs the engineer's count for that weekday this cycle.
      if (d.weekday !== undefined && p.weekdays?.[e][d.weekday]) weekdays.push([p.weekdays[e][d.weekday], x(e, i)]);
    }
  }
  for (let e = 0; e < p.targets.length; e++) {
    rows.push({terms: ids[e].map(i => [p.duties[i].units, x(e, i)]), upper: p.targets[e]});
    const weekends = new Map<number, number[]>();
    for (const i of ids[e]) {
      const w = p.duties[i].weekend;
      if (w !== undefined) weekends.set(w, [...(weekends.get(w) ?? []), i]);
    }
    for (const [w, ds] of weekends) {
      const y = `w_${e}_${w}`;
      columns.push({name: y});
      // Weekend rotation: a weekend for an engineer who already had turns this cycle costs their count.
      if (p.rotation?.[e]) rotation.push([p.rotation[e], y]);
      for (const i of ds) rows.push({terms: [[1, x(e, i)], [-1, y]], upper: 0});
      rows.push({terms: [[1, y], ...ds.map(i => [-1, x(e, i)] as Term)], upper: 0});
    }
    // Back-to-back duties are no spacing gap; the adjacent stage counts them.
    for (const [a, i] of ids[e].entries()) for (const j of ids[e].slice(a + 1)) {
      const gap = p.duties[j].start - p.duties[i].end;
      if (gap > 0 && p.duties[i].units + p.duties[j].units <= p.targets[e]) gaps.add(gap);
    }
    const {before, after} = anchors(p, e);
    for (const i of ids[e]) {
      if (before && p.duties[i].start > before.end) gaps.add(p.duties[i].start - before.end);
      if (after && after.start > p.duties[i].end) gaps.add(after.start - p.duties[i].end);
    }
  }
  return {columns, rows, gaps: [...gaps].sort((a, b) => a - b), ids, rotation, weekdays, stages: [{name: 'coverage', terms: coverage},
    {name: 'special', terms: special}, {name: 'units', terms: units}] as Stage[]};
}

/** Same-weekday repeats: r[e,wd] >= (ordinary Sunday-Thursday duties of e on weekday wd) - 1.
 * Minimizing the sum counts every extra duty on an already used weekday. Continuous
 * columns suffice: binary x makes the minimum integral. */
function buildRepeats(p: Problem, ids: number[][]) {
  const columns: Column[] = [], rows: Row[] = [], terms: Term[] = [];
  for (let e = 0; e < p.targets.length; e++) {
    const byWeekday = new Map<number, number[]>();
    for (const i of ids[e]) {
      const wd = p.duties[i].weekday;
      if (wd !== undefined) byWeekday.set(wd, [...(byWeekday.get(wd) ?? []), i]);
    }
    for (const [wd, duties] of byWeekday) {
      if (duties.length < 2) continue;
      const r = `r_${e}_${wd}`;
      columns.push({name: r, upper: duties.length}); terms.push([1, r]);
      rows.push({terms: [[1, r], ...duties.map(i => [-1, x(e, i)] as Term)], lower: -1});
    }
  }
  return {columns, rows, stage: {name: 'repeats', terms} as Stage};
}

/** Extra weekends: z[e,k] >= (weekends of e) - k for every k from the allowance up, so the
 * sum is 1 + 2 + … + (extra weekends) and extra weekends spread across members.
 * Back-to-back: b[e,i] >= x[e,i] + x[e,next] - 1 for each unapproved adjacent pair, plus
 * x[e,i] itself for each unlocked duty touching e's duty in a neighbouring month.
 * Continuous columns suffice: binary x makes both minima integral. A proved zero
 * bounds the columns at 0, which restores the hard one-weekend and no-adjacency rows. */
function buildSlack(p: Problem, ids: number[][]) {
  const weekends = {columns: [] as Column[], rows: [] as Row[], stage: {name: 'extra-weekends', terms: [] as Term[]}};
  const adjacent = {columns: [] as Column[], rows: [] as Row[], stage: {name: 'adjacent', terms: [] as Term[]}};
  for (let e = 0; e < p.targets.length; e++) {
    const ys = [...new Set(ids[e].flatMap(i => p.duties[i].weekend === undefined ? [] : [p.duties[i].weekend!]))]
      .map(w => [-1, `w_${e}_${w}`] as Term);
    for (let k = weekendAllowance(p, e); k < ys.length; k++) {
      const z = `z_${e}_${k}`;
      weekends.columns.push({name: z, upper: ys.length - k}); weekends.stage.terms.push([1, z]);
      weekends.rows.push({terms: [[1, z], ...ys], lower: -k});
    }
    for (const [a, i] of ids[e].entries()) {
      const j = ids[e][a + 1];
      if (j === undefined || p.duties[j].start !== p.duties[i].end || approvedPair(p, i, j)) continue;
      const b = `b_${e}_${i}`;
      adjacent.columns.push({name: b}); adjacent.stage.terms.push([1, b]);
      adjacent.rows.push({terms: [[1, x(e, i)], [1, x(e, j)], [-1, b]], upper: 1});
    }
    for (const i of ids[e]) {const n = boundaryTouches(p, e, i); if (n) adjacent.stage.terms.push([n, x(e, i)]);}
  }
  return [weekends, adjacent];
}

/** With binary x, acyclic unit flow through every selected node has a unique integral path. */
function buildFlows(p: Problem, ids: number[][], gapFloor: number, slack: Slack) {
  const columns: Column[] = [], rows: Row[] = [], gaps = new Map<number, Term[]>();
  for (let e = 0; e < p.targets.length; e++) {
    if (!ids[e].length) continue;
    const locked = ids[e].filter(i => p.duties[i].lock === e);
    const lockedUnits = locked.reduce((n, i) => n + p.duties[i].units, 0);
    const incoming = new Map(ids[e].map(i => [i, [] as Term[]]));
    const outgoing = new Map(ids[e].map(i => [i, [] as Term[]]));
    const source: Term[] = [], sink: Term[] = [];
    // A back-to-back arc (gap 0) is no spacing gap: neither floored nor counted.
    const arc = (name: string, from: Term[], to: Term[], gap?: number) => {
      if (gap !== undefined && gap > 0 && gap < gapFloor) return;
      columns.push({name}); from.push([1, name]); to.push([1, name]);
      if (gap) gaps.set(gap, [...(gaps.get(gap) ?? []), [1, name]]);
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
        if ((gap === 0 && !slack.adjacent && !approvedPair(p, i, j)) || locked.some(k => i < k && k < j) || required > p.targets[e]) continue;
        arc(`a_${e}_${i}_${j}`, outgoing.get(i)!, incoming.get(j)!, gap);
      }
    }
    rows.push({terms: source, lower: 1, upper: 1}, {terms: sink, lower: 1, upper: 1});
    for (const i of ids[e]) {
      rows.push({terms: [...incoming.get(i)!, [-1, x(e, i)]], lower: 0, upper: 0},
        {terms: [...outgoing.get(i)!, [-1, x(e, i)]], lower: 0, upper: 0});
    }
  }
  rows.push(...capacityRows(p, ids, gapFloor, slack));
  return {columns, rows, stages: [...gaps].sort(([a], [b]) => a - b).map(([g, terms]) => ({name: `gap:${g}`, terms}))};
}

/** Valid per-engineer capacity cuts. Integer point totals and weekend use are
 * strongly coupled (e.g. one half-weekend cannot fill an even ordinary target).
 * A small weighted-interval DP computes maxima with/without a weekend. It does
 * not choose the schedule. Large synthetic targets simply omit this optional cut,
 * and so does a month whose proved level still needs extra weekends. */
function capacityRows(p: Problem, ids: number[][], g: number, slack: Slack): Row[] {
  const rows: Row[] = [];
  if (slack.weekends) return rows;
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
      // Floors apply to real gaps only; touching an anchor needs an approval (see ids).
      if (!locked.some(k => k < i) && (!before || d.start === before.end || d.start - before.end >= g)) append(-1, 0);
      for (let b = 0; b < a; b++) {
        const j = ids[e][b], gap = d.start - p.duties[j].end;
        if ((gap > 0 && gap < g) || (gap === 0 && !slack.adjacent && !approvedPair(p, j, i)) || locked.some(k => j < k && k < i)) continue;
        for (const [w, totals] of states[b]) for (const units of totals) append(w, units);
      }
      if (locked.some(k => k > i) || (after && after.start !== d.end && after.start - d.end < g)) continue;
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
 * enforce all threshold conflicts and strengthen the pairwise LP relaxation.
 * A back-to-back pair (approved, or any while the proved adjacent level is above
 * zero) is no spacing gap, so such an engineer instead gets one row per close pair:
 * both duties only with another of theirs in between. */
function thresholdRows(p: Problem, ids: number[][], g: number, slack: Slack): Row[] {
  const rows: Row[] = [];
  for (let e = 0; e < ids.length; e++) {
    if (slack.adjacent || p.exceptions?.consecutive?.some(([i]) => p.duties[i].lock === e)) {
      for (const [a, i] of ids[e].entries()) for (let b = a + 1; b < ids[e].length; b++) {
        const j = ids[e][b], gap = p.duties[j].start - p.duties[i].end;
        if (gap >= g) break;
        if (gap > 0) rows.push({terms: [[1, x(e, i)], [1, x(e, j)], ...ids[e].slice(a + 1, b).map(k => [-1, x(e, k)] as Term)], upper: 1});
      }
    } else {
      let right = 0, previousRight = -1;
      for (let a = 0; a < ids[e].length; a++) {
        right = Math.max(right, a + 1);
        while (right < ids[e].length && p.duties[ids[e][right]].start < p.duties[ids[e][a]].end + g) right++;
        if (right - a > 1 && right !== previousRight) {
          rows.push({terms: ids[e].slice(a, right).map(i => [1, x(e, i)]), upper: 1});
          previousRight = right;
        }
      }
    }
    const {before, after} = anchors(p, e);
    const close = (gap: number) => gap > 0 && gap < g;
    const blocked = ids[e].filter(i => (before && close(p.duties[i].start - before.end)) ||
      (after && close(after.start - p.duties[i].end)));
    if (blocked.length) rows.push({terms: blocked.map(i => [1, x(e, i)]), upper: 0});
  }
  rows.push(...capacityRows(p, ids, g, slack));
  return rows;
}

export function solveProblem(adapter: SolverAdapter, p: Problem, settings: Settings = defaultSettings,
  onProgress?: (progress: Progress) => void) {
  if (!Number.isInteger(settings.seed) || settings.seed < 0 || settings.seed > 2147483647 ||
    !Number.isFinite(settings.seconds) || settings.seconds < 0 ||
    !Number.isInteger(settings.nodes) || settings.nodes < 0 || settings.nodes > 2147483647) throw Error('Invalid solver settings');
  const started = performance.now(), base = buildModel(p), buildMs = performance.now() - started;
  const random = mixer(settings.seed);
  const rotationStage: Stage = {name: 'rotation', terms: base.rotation}, weekdayStage: Stage = {name: 'weekdays', terms: base.weekdays};
  const preference: Stage = {name: 'preferred', terms: (p.preferences ?? []).map(v => [-v.weight, x(v.engineer, v.duty)])};
  const repeats = buildRepeats(p, base.ids);
  const seeded: Stage = {name: 'seed', terms: p.seededTies ? p.duties.flatMap((d, i) => d.eligible.map(e => {
    // This last-stage score only breaks equivalent outcomes. Keep coefficients
    // small so native objective accumulation agrees with exact integer replay;
    // million-scale costs produced >1e-7 drift on ordinary six-engineer months.
    return [random() % 1000, x(e, i)] as Term;
  })) : []};
  // Directly below the proved minimum gap: cross-month weekend fairness, in-month weekday
  // variety, cross-month weekday rotation, explicit preferred dates, then the seeded tie.
  // The remaining sorted-gap leximin runs last, as a pure tie-breaker: above the seed it
  // pushed every pair towards the same two-week pattern month after month. This list is
  // the one place that fixes the order below the minimum gap.
  const quality = [rotationStage, repeats.stage, weekdayStage, preference, seeded];
  let qualityDone = false;
  const runQuality = () => {
    for (const stage of quality) {
      if (stage === repeats.stage && stage.terms.length) {
        session.addColumns(repeats.columns); session.addRows(repeats.rows);
        columns += repeats.columns.length; rows += repeats.rows.length;
      }
      if (!optimize(stage)) return false;
    }
    return true;
  };
  const seedCost = (a: (number | null)[]) => seeded.terms.reduce((sum, [c, variable]) => {
    const [, e, i] = variable.split('_').map(Number);
    return sum + (a[i] === e ? c : 0);
  }, 0);
  const objective = (name: string, m: Metrics, a: (number | null)[]) => name === 'seed' ? seedCost(a) : score(name, m);
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
    // Counter columns are the only non-binary ones; everything else must be exactly 0/1.
    const raw = result.values, values = binaryValues(Object.fromEntries(Object.entries(raw).filter(([k]) => !counter(k))));
    const a = decodeAssignment(p, values), m = validateAssignment(p, a);
    for (const stage of stages) if (stage.proved && objective(stage.name, m, a) !== stage.objective) throw Error('Prior objective degraded');
    if (floor !== undefined && minimum(m) < floor) throw Error('Threshold violated');
    // A counter is only bounded below by its count: a solution may carry slack above it
    // (never below), and the exact count is the validated one.
    const bounded = name !== undefined && counters.has(name);
    const value = bounded ? objective(name, m, a) : terms.reduce((n, [c, v]) => n + c * values[v], 0);
    if (!Number.isSafeInteger(value) || (name && value !== objective(name, m, a)) || result.objective === null ||
      (bounded ? value - result.objective > 1e-7 + 1e-8 * terms.length : Math.abs(value - result.objective) > 1e-7)) throw Error('Objective mismatch');
    // Hierarchy order: the quality levels, the seeded tie, then the sorted-gap leximin.
    const comparison = compareQuality(m, metrics, p.spacing) || Math.sign(seedCost(a) - seedCost(assignment)) ||
      (p.spacing ? compareGaps(m, metrics) : 0);
    if (comparison < 0) {assignment = a; metrics = m; progress(name ?? 'threshold');}
    return value;
  };
  const optimize = (stage: Stage) => {
    const initial = objective(stage.name, metrics, assignment);
    if (!stage.terms.length || (nonnegative(stage.name) && initial === 0)) {
      identity(stage.name, initial, 'Nonnegative count at zero');
      if (stage.terms.length) session.zeroColumns(stage.terms);
      return true;
    }
    const result = run(stage.terms);
    if (!result) {termination = 'budget'; return false;}
    if (result.status === 'infeasible') throw Error('Optional-coverage model contradicts verified incumbent');
    const value = candidate(result, stage.terms, stage.name);
    // Integer objective: a bound above value - 1 proves optimality; the native gap only
    // guards against a bound reported far from the objective (it carries 1e-16 noise
    // once fixed-level rows sit beside the continuous flows).
    const proved = value !== null && result.status === 'optimal' && result.bound > value - 1 &&
      result.bound <= value + 1e-7 && result.gap <= 1e-9;
    if (proved && objective(stage.name, metrics, assignment) !== value) throw Error('Optimum contradicts verified incumbent');
    const {values: discarded, ...metadata} = result; void discarded;
    stages.push({...metadata, name: stage.name, objective: value, proved});
    progress(stage.name);
    if (proved) {
      if (nonnegative(stage.name) && value === 0) session.zeroColumns(stage.terms);
      else {session.addRows([{terms: stage.terms, lower: value!, upper: value!}]); rows++;}
    }
    return proved;
  };
  try {
    session.addColumns(base.columns); session.addRows(base.rows);
    let headProved = true;
    for (const stage of base.stages) {
      if (stage.name !== 'coverage' && metrics.coverage === p.duties.reduce((n, d) => n + d.days, 0)) {
        identity(stage.name, score(stage.name, metrics), 'Full coverage and target conservation');
      } else if (!optimize(stage)) {headProved = false; break;}
    }
    // Last resorts, directly below the targets: extra weekends, then unapproved back-to-back
    // pairs. A proved zero restores the hard rule; otherwise later rows must allow them.
    const slack: Slack = {adjacent: false, weekends: false};
    if (headProved) for (const level of buildSlack(p, base.ids)) {
      if (level.stage.terms.length) {
        session.addColumns(level.columns); session.addRows(level.rows);
        columns += level.columns.length; rows += level.rows.length;
      }
      if (!optimize(level.stage)) {headProved = false; break;}
      if (level.stage.name === 'adjacent') slack.adjacent = metrics.adjacent > 0;
      else slack.weekends = metrics.extraWeekends > 0;
    }
    if (headProved) {
      const cuts = capacityRows(p, base.ids, 0, slack);
      session.addRows(cuts); rows += cuts.length;
    }
    if (headProved && !p.spacing) finished = true;
    if (headProved && p.spacing) {
      const levels = base.gaps.concat(Infinity);
      const fixedMinimum = minimum(validateAssignment(p, p.duties.map(d => d.lock ?? null)));
      // Inserting duties between fixed intervals cannot improve their minimum gap, unless
      // back-to-back duties may fill the whole space between them (no gap remains).
      let lo = levels.indexOf(minimum(metrics));
      let hi = fixedMinimum === Infinity || slack.adjacent ? levels.length : levels.indexOf(fixedMinimum) + 1;
      if (lo < 0) throw Error('Missing incumbent gap threshold');
      let thresholdCount = 0, offset = rows;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2), floor = levels[mid];
        session.deleteRows(offset, thresholdCount);
        const constraints = thresholdRows(p, base.ids, floor, slack);
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
          const constraints = thresholdRows(p, base.ids, floor, slack);
          session.addRows(constraints); rows += constraints.length;
          finished = true;
        }
        else {
          // The flows enforce the proved minimum gap while the quality levels and the
          // seed are solved; the gap-count (leximin) stages follow them as tie-breakers.
          const flows = buildFlows(p, base.ids, floor, slack);
          session.addColumns(flows.columns); session.addRows(flows.rows);
          columns += flows.columns.length; rows += flows.rows.length;
          qualityDone = true; finished = runQuality();
          if (finished) for (const stage of flows.stages) if (!optimize(stage)) {finished = false; break;}
        }
      } else {
        stages.push({name: 'minimum-gap', status: termination, statusCode: 0, objective: floor,
          bound: minimumGap.upper ?? Infinity, gap: Infinity, nodes: 0, elapsedMs: 0,
          memoryBytes: adapter.memoryBytes, proved: false});
      }
    }
    if (finished && !qualityDone) {qualityDone = true; finished = runQuality();}
  } finally {session.dispose();}
  return {assignment, metrics, stages, thresholds, minimumGap, provedPrefix: prefix(),
    complete: metrics.deficits.every(n => n === 0) && assignment.every(e => e !== null),
    allStagesProved: finished, termination: finished ? 'optimal' : termination,
    buildMs, elapsedMs: performance.now() - started, baseColumns: base.columns.length,
    binaryColumns: base.columns.filter(c => c.binary).length, columns, rows, peakRows: Math.max(peakRows, rows),
    modelsCreated: adapter.modelsCreated - created, startsSubmitted: adapter.startsSubmitted - submitted,
    memoryBytes: adapter.memoryBytes, activeModels: adapter.activeModels};
}
