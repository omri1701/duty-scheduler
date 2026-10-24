import {buildModel} from '../scheduling/solver/model.ts';
import {decodeAssignment, validateAssignment} from '../scheduling/solver/problem.ts';
import type {Column, Row, Term, SolverAdapter, Settings} from '../scheduling/solver/highs-adapter.ts';
import {defaultSettings} from '../scheduling/solver/settings.ts';
import {prepareGeneration, inputKey, snapshotKey} from '../scheduling/domain.ts';
import {canonicalDuties, coverageStart} from '../scheduling/calendar.ts';
import {validateGeneration, type PrimaryAssignments} from '../scheduling/validate.ts';
import {project} from '../compensation/index.ts';
import type {AllocationInput, Stage, Check} from './types.ts';

export const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
export const scale = (terms: Term[], factor: number): Term[] => terms.map(([v, k]) => [v * factor, k]);
export const terms = (input: Term[]): Term[] => {
  const totals = new Map<string, number>();
  for (const [v, k] of input) totals.set(k, (totals.get(k) ?? 0) + v);
  return [...totals].filter(([, v]) => v).map(([k, v]) => [v, k]);
};
export const value = (t: Term[], values: Record<string, number>) => sum(t.map(([v, k]) => v * values[k]));
export const units = (v: number) => {
  if (!Number.isSafeInteger(v) || v < 0 || v > 1e9) throw Error('invalid-allocation-units');
  return v;
};
export function context(input: AllocationInput) {
  const schedule = structuredClone(input.schedule), duties = canonicalDuties(schedule.month, schedule.calendar);
  const ids = schedule.members.filter(m => m.active && m.approved && m.eligible).map(m => m.id).sort();
  if (!ids.length || input.seniority.length !== ids.length || new Set(input.seniority).size !== ids.length ||
    input.seniority.some(id => !ids.includes(id))) throw Error('invalid-allocation-seniority');
  const total = units(sum(duties.map(d => d.units)));
  const locked = Object.fromEntries(ids.map(id => [id, sum((schedule.locks ?? []).filter(l => l.engineer === id)
    .map(l => duties.find(d => d.id === l.dutyId)?.units ?? 0))]));
  // A balanced seed for source validation only; it is never an ordinary baseline.
  const seed = {...locked}; seed[ids[0]] += total - sum(Object.values(seed));
  const prepared = prepareGeneration({...schedule, targets: Object.fromEntries(ids.map(id => [id, seed[id] / 2]))});
  const projection = project(input.events, input.now, coverageStart(schedule.month, schedule.calendar));
  return {prepared, ids, total, locked, projection,
    candidates: projection.projected.candidates.filter(c => ids.includes(c.debtorId) && ids.includes(c.creditorId)),
    key: inputKey({schedule, seniority: snapshotKey(input.seniority), ledger: projection.sourceFingerprint, cutoff: projection.cutoffMs})};
}
export type Context = ReturnType<typeof context>;

/** One shared work budget, never a fresh time allowance per objective/counterpart. */
export function budget(settings: Partial<Settings> = {}) {
  const config = {...defaultSettings, ...settings}, start = performance.now();
  if (!Number.isSafeInteger(config.seed) || config.seed < 0 || config.seed > 2147483647 ||
    !Number.isFinite(config.seconds) || config.seconds < 0 || config.seconds > 30 ||
    !Number.isSafeInteger(config.nodes) || config.nodes < 0 || config.nodes > 2147483647) throw Error('invalid-allocation-settings');
  return {next: () => ({...config, seconds: Math.max(0, config.seconds - (performance.now() - start) / 1000)}),
    used: (nodes: number) => {config.nodes = Math.max(-1, config.nodes - nodes);}};
}
export type Budget = ReturnType<typeof budget>;

/** All planner columns are binary, including binary encodings of integer units.
 * Validate the entire witness and objective before fixing a lexicographic stage. */
export function model(adapter: SolverAdapter, work: Budget) {
  const session = adapter.createSession(), columns: Column[] = [], rows: Row[] = [], stages: Stage[] = [];
  let incumbent: Record<string, number> | null = null;
  const addColumns = (cs: Column[]) => {
    cs = cs.map(c => ({...c, binary: true})); columns.push(...cs); session.addColumns(cs);
  };
  const addRows = (rs: Row[]) => {
    rs = rs.map(r => ({...r, terms: terms(r.terms)})); rows.push(...rs); session.addRows(rs);
  };
  const integer = (name: string, max: number): Term[] => {
    const result: Term[] = [];
    for (let bit = 1; bit <= max; bit *= 2) {
      const key = `${name}_${bit}`; addColumns([{name: key}]); result.push([bit, key]);
    }
    if (result.length) addRows([{terms: result, upper: max}]);
    return result;
  };
  const optimize = (name: string, objective: Term[]) => {
    const t = terms(objective), settings = work.next();
    if (settings.seconds <= 0 || settings.nodes < 0) {stages.push({name, status: 'budget', objective: null, proved: false}); return false;}
    session.setObjective(t);
    const r = session.run(settings); work.used(r.nodes);
    let v: number | null = null;
    if (r.values) {
      const checked: Record<string, number> = {};
      for (const c of columns) {
        const n = r.values[c.name];
        if (!Number.isFinite(n) || Math.min(Math.abs(n), Math.abs(n - 1)) > 1e-8) throw Error('noninteger-allocation-witness');
        checked[c.name] = Math.abs(n) < 1e-8 ? 0 : 1;
        if (checked[c.name] < (c.lower ?? 0) || checked[c.name] > (c.upper ?? 1)) throw Error('allocation-column-bound');
      }
      for (const row of rows) {
        const n = value(row.terms, checked);
        if (n < (row.lower ?? -Infinity) || n > (row.upper ?? Infinity)) throw Error('allocation-row-violation');
      }
      v = value(t, checked);
      if (!Number.isSafeInteger(v) || r.objective === null || Math.abs(v - r.objective) > 1e-7) throw Error('allocation-objective-mismatch');
      incumbent = checked;
    }
    const proved = v !== null && r.status === 'optimal' && r.gap === 0 && r.bound > v - 1 && r.bound <= v + 1e-7;
    stages.push({name, status: r.status, objective: v, proved});
    if (proved) addRows([{terms: t, lower: v!, upper: v!}]);
    return proved;
  };
  return {addColumns, addRows, integer, optimize, stages, get values() {return incumbent;}, dispose: () => session.dispose()};
}

export function assignments(c: Context, values: Record<string, number>, targets: Record<string, number>) {
  const p = {...c.prepared.problem, targets: c.ids.map(id => targets[id])};
  const a = decodeAssignment(p, values); validateAssignment(p, a);
  const result: PrimaryAssignments = Object.fromEntries(c.prepared.duties.map((d, i) => [d.id, {
    primary: a[i] === null ? null : c.ids[a[i]!],
    ...(c.prepared.input.secondary?.[d.id] ? {secondary: c.prepared.input.secondary[d.id]} : {}),
  }]));
  const metrics = validateGeneration({...c.prepared.input,
    targets: Object.fromEntries(c.ids.map(id => [id, targets[id] / 2]))}, result);
  return {result, metrics, actual: Object.fromEntries(c.ids.map((id, e) => [id, targets[id] - metrics.deficits[e]]))};
}

export function validTargets(c: Context, targets: Record<string, number>) {
  return Object.keys(targets).length === c.ids.length && c.ids.every(id =>
    Number.isSafeInteger(targets[id]) && targets[id] >= c.locked[id]) && sum(Object.values(targets)) === c.total;
}
export type Funding = {engineer: string; units: number; ordinaryUnits: number};
export function checkTargets(adapter: SolverAdapter, c: Context, targets: Record<string, number>, work: Budget,
  floors: Record<string, number> = {}, funding: Funding[] = []): Check {
  const diagnostics = [...c.prepared.diagnostics.filter(d => !['insufficient-individual-capacity',
    'unreachable-target-combination', 'shared-capacity-shortage'].includes(d.code))];
  if (!validTargets(c, targets)) return {feasibility: 'invalid', assignments: null, coverage: 0, special: 0, assignedUnits: 0,
    actualUnits: {}, stages: [], diagnostics: [...diagnostics, {code: 'repair-allocation-total-or-lock-floor', certainty: 'fact'}]};
  const p = {...c.prepared.problem, targets: c.ids.map(id => targets[id])}, base = buildModel(p), m = model(adapter, work);
  try {
    m.addColumns(base.columns); m.addRows(base.rows);
    for (const [id, floor] of Object.entries(floors)) m.addRows([{terms: p.duties.flatMap((d, i) =>
      d.eligible.includes(c.ids.indexOf(id)) ? [[d.units, `x_${c.ids.indexOf(id)}_${i}`] as Term] : []), lower: floor}]);
    const funded = funding.map((f, i) => m.integer(`funded_${i}`, Math.min(f.units, c.total)));
    for (const [e, id] of c.ids.entries()) {
      const requests = funding.flatMap((f, i) => f.engineer === id ? [i] : []);
      if (!requests.length) continue;
      const active = `funding-active_${e}`, t = requests.flatMap(i => funded[i]); m.addColumns([{name: active}]);
      m.addRows([{terms: [...t, [-c.total, active]], upper: 0},
        {terms: [...p.duties.flatMap((d, i) => d.eligible.includes(e) ? [[d.units, `x_${e}_${i}`] as Term] : []),
          ...scale(t, -1), [-c.total, active]], lower: funding[requests[0]].ordinaryUnits - c.total}]);
    }
    for (const stage of [...base.stages, ...funded.map((t, i) => ({name: `funding:${i}`, terms: scale(t, -1)}))]) {
      if (!m.optimize(stage.name, stage.terms)) break;
    }
    if (!m.values) return {feasibility: 'unknown', assignments: null, coverage: 0, special: 0, assignedUnits: 0,
      actualUnits: {}, stages: m.stages, diagnostics: [...diagnostics, {code: 'allocation-feasibility-unproved', certainty: 'unproved'}]};
    const a = assignments(c, m.values, targets), full = a.metrics.coverage === sum(p.duties.map(d => d.days));
    const proved = base.stages.every(s => m.stages.some(stage => stage.name === s.name && stage.proved));
    if (funding.length && !m.stages.every(s => s.proved)) diagnostics.push({code: 'repayment-optimum-unproved', certainty: 'unproved'});
    for (const id of c.ids) if (a.actual[id] < targets[id]) diagnostics.push({code: 'unfunded-target',
      certainty: 'fact', engineer: id, units: targets[id] - a.actual[id]});
    for (const d of c.prepared.duties) if (a.result[d.id].primary === null) diagnostics.push({code: 'uncovered-duty',
      certainty: 'fact', dutyId: d.id, dates: d.dates, units: d.units});
    if (!full) diagnostics.push({code: proved ? 'allocation-requires-partial-output' : 'allocation-feasibility-unproved',
      certainty: proved ? 'proved' : 'unproved'});
    return {feasibility: full ? 'complete' : proved ? 'partial' : 'unknown', assignments: a.result,
      coverage: a.metrics.coverage, special: a.metrics.special, assignedUnits: a.metrics.units,
      actualUnits: a.actual, stages: m.stages, diagnostics};
  } finally {m.dispose();}
}
