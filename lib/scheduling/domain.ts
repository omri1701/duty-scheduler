import {addDays, dayOf} from '../rota/calendar-dates.ts';
import {canonicalDuties, halfUnits, handover, requireDate} from './calendar.ts';
import {checkProblem, type Problem} from './solver/problem.ts';
import {GenerationError, type Diagnostic, type GenerationInput} from './types.ts';

export const CORE_VERSION = 'duty-generation-v1';
export const MODEL_VERSION = 'highs-leximin-v2';
/** Exact canonical serialization, not a lossy hash. Input arrays are sets of facts. */
function canonicalKey(value: unknown, sets: boolean): string {
  if (Array.isArray(value)) {
    const values = value.map(v => canonicalKey(v, sets));
    return '[' + (sets ? values.sort() : values).join(',') + ']';
  }
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => JSON.stringify(k) + ':' + canonicalKey(v, sets)).join(',') + '}';
  if (typeof value === 'number' && !Number.isFinite(value)) return `number:${value}`;
  return JSON.stringify(value);
}
export const inputKey = (value: unknown) => canonicalKey(value, true);
export const snapshotKey = (value: unknown) => canonicalKey(value, false);
const fail = (code: string, detail: Record<string, unknown> = {}): never => {throw new GenerationError(code, detail);};
const unique = (values: string[], code: string) => {if (new Set(values).size !== values.length) fail(code);};

/** Freeze a caller's source facts and normalize IDs to stable solver coordinates. */
export function prepareGeneration(source: GenerationInput) {
  const input = structuredClone(source), duties = canonicalDuties(input.month, input.calendar);
  if (!input.sourceRevision?.trim()) fail('missing-source-revision');
  unique(input.members.map(e => e.id), 'duplicate-member');
  if (input.members.some(e => !e.id || [e.active, e.approved, e.eligible].some(v => typeof v !== 'boolean'))) fail('invalid-member');
  const members = input.members.filter(e => e.active && e.approved && e.eligible).sort((a, b) => a.id < b.id ? -1 : 1);
  const memberIds = new Set(input.members.map(e => e.id));
  const engineers = new Map(members.map((e, i) => [e.id, i]));
  const indices = new Map(duties.map((d, i) => [d.id, i]));
  if (!members.length || Object.keys(input.targets).length !== members.length ||
    Object.keys(input.targets).some(id => !engineers.has(id)) || members.some(e => !Object.hasOwn(input.targets, e.id))) fail('invalid-target-members');
  const targets = members.map(e => halfUnits(input.targets[e.id]));
  if (targets.reduce((n, v) => n + v, 0) !== duties.reduce((n, d) => n + d.units, 0)) fail('target-total-mismatch');
  for (const [id, constraints] of Object.entries(input.constraints ?? {})) {
    if (!memberIds.has(id)) fail('unknown-constraint-member', {engineer: id});
    for (const [date, value] of Object.entries(constraints)) {
      requireDate(date); if (value !== 'no' && value !== 'prefer') fail('invalid-constraint', {engineer: id, date});
    }
  }
  const locks = new Map<string, string>();
  for (const l of input.locks ?? []) {
    if (!indices.has(l.dutyId) || !engineers.has(l.engineer) || locks.has(l.dutyId)) fail('invalid-lock', {dutyId: l.dutyId});
    locks.set(l.dutyId, l.engineer);
  }
  for (const [dutyId, id] of Object.entries(input.secondary ?? {})) {
    if (!indices.has(dutyId) || !memberIds.has(id)) fail('invalid-secondary', {dutyId, engineer: id});
  }
  const unavailable = (id: string, dutyId: string) => duties[indices.get(dutyId)!].dates.filter(d => input.constraints?.[id]?.[d] === 'no');
  const approvals = input.approvals ?? [];
  unique(approvals.map(a => inputKey(a)), 'duplicate-approval');
  // Boundary IDs refer to input commitments; duplicate live/working facts share a guard.
  const boundaryKeys = new Map<string, string>();
  const guards = new Map<string, {id: string; engineer: number; start: number; end: number; source: string}>();
  const neighborSources = new Map<string, string[]>();
  unique((input.neighbors ?? []).map(n => n.id), 'duplicate-neighbor-id');
  for (const n of input.neighbors ?? []) {
    requireDate(n.start); requireDate(n.end);
    const owner = (dayOf(n.start) === 6 ? addDays(n.start, -1) : n.start).slice(0, 7);
    const start = handover(n.start), end = handover(n.end);
    if (!n.id || !memberIds.has(n.engineer) || !['published', 'working'].includes(n.source) || n.ownerMonth !== owner ||
      owner === input.month || !(n.end === addDays(n.start, 1) || (dayOf(n.start) === 5 && n.end === addDays(n.start, 2))) ||
      !(end <= duties[0].start || start >= duties.at(-1)!.end)) fail('invalid-neighbor', {id: n.id});
    const key = inputKey({ownerMonth: n.ownerMonth, start: n.start, end: n.end, engineer: n.engineer});
    boundaryKeys.set(n.id, key);
    neighborSources.set(key, [...(neighborSources.get(key) ?? []), `${n.ownerMonth}:${n.source}:${n.id}`].sort());
    const engineer = engineers.get(n.engineer);
    if (engineer !== undefined) guards.set(key, {id: key, engineer, start, end, source: ''});
  }
  for (const [key, guard] of guards) guard.source = neighborSources.get(key)!.join(',');
  const exceptions: NonNullable<Problem['exceptions']> = {consecutive: [], boundary: [], weekends: []};
  const scopeKeys: string[] = [];
  for (const a of approvals) {
    if (!a.reason?.trim()) fail('approval-reason-required');
    if (a.rule === 'availability') {
      const denied = indices.has(a.dutyId) ? unavailable(a.engineer, a.dutyId) : [];
      if (locks.get(a.dutyId) !== a.engineer || !denied.length || inputKey(a.dates) !== inputKey(denied)) fail('invalid-availability-approval', {dutyId: a.dutyId});
      scopeKeys.push(`availability:${a.dutyId}`);
    } else if (a.rule === 'consecutive') {
      const [i, j] = a.duties.map(id => indices.get(id));
      if (i === undefined || j === undefined) fail('invalid-pair-approval');
      exceptions.consecutive!.push([i!, j!]);
      scopeKeys.push(`consecutive:${i}:${j}`);
    } else if (a.rule === 'boundary') {
      const i = indices.get(a.dutyId), key = boundaryKeys.get(a.neighborId);
      if (i === undefined || !key || !guards.has(key)) fail('invalid-boundary-approval');
      exceptions.boundary!.push({duty: i!, boundary: key!});
      scopeKeys.push(`boundary:${i}:${key}`);
    } else if (a.rule === 'weekends') {
      const e = engineers.get(a.engineer);
      if (e === undefined || a.weekends.some(w => !duties.some(d => d.weekendId === w))) fail('invalid-weekend-approval');
      exceptions.weekends!.push({engineer: e!, weekends: a.weekends.map(w => handover(w))});
      scopeKeys.push(`weekends:${e}`);
    } else fail('unknown-approval');
  }
  unique(scopeKeys, 'duplicate-approval-scope');
  const diagnostics: Diagnostic[] = [], preferences: NonNullable<Problem['preferences']> = [];
  const problem: Problem = {targets, spacing: true, seededTies: true, preferences,
    boundaries: [...guards.values()].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id)), exceptions,
    duties: duties.map((d, i) => {
      const locked = locks.get(d.id), secondary = input.secondary?.[d.id];
      const eligible = members.flatMap((m, e) => {
        if (m.id === secondary) return [];
        const denied = unavailable(m.id, d.id);
        const approved = locked === m.id && approvals.some(a => a.rule === 'availability' && a.dutyId === d.id && a.engineer === m.id);
        if (denied.length && !approved) return [];
        const preferred = d.dates.filter(date => input.constraints?.[m.id]?.[date] === 'prefer').length;
        if (preferred) preferences.push({duty: i, engineer: e, weight: preferred});
        return [e];
      });
      if (locked && !eligible.includes(engineers.get(locked)!)) fail('ineligible-lock', {dutyId: d.id, engineer: locked});
      if (!eligible.length) diagnostics.push({code: 'no-primary-candidates', certainty: 'proved', dutyId: d.id, dates: d.dates});
      if (secondary && input.members.some(m => m.id === secondary && (!m.active || !m.approved || d.dates.some(date => input.constraints?.[m.id]?.[date] === 'no')))) {
        diagnostics.push({code: 'secondary-needs-publication-review', certainty: 'fact', dutyId: d.id, engineer: secondary});
      }
      return {start: d.start, end: d.end, days: d.dates.length, units: d.units, special: d.specialDates.length, eligible,
        ...(d.weekendId ? {weekend: handover(d.weekendId)} : {}), ...(locked ? {lock: engineers.get(locked)!} : {})};
    })};
  try {checkProblem(problem);} catch (error) {fail('invalid-fixed-input', {reason: error instanceof Error ? error.message : String(error)});}
  // Cheap necessary conditions, explicitly separate from global feasibility.
  for (const [e, member] of members.entries()) {
    const candidates = problem.duties.filter(d => d.eligible.includes(e));
    const capacity = candidates.reduce((sum, d) => sum + d.units, 0);
    if (capacity < targets[e]) diagnostics.push({code: 'insufficient-individual-capacity', certainty: 'proved', engineer: member.id, units: targets[e] - capacity});
    let reachable = new Set([0]);
    for (const d of candidates) reachable = new Set([...reachable, ...[...reachable].map(v => v + d.units).filter(v => v <= targets[e])]);
    if (!reachable.has(targets[e])) diagnostics.push({code: 'unreachable-target-combination', certainty: 'proved', engineer: member.id, units: targets[e]});
  }
  for (let a = 0; a < members.length; a++) for (let b = a + 1; b < members.length; b++) {
    const union = problem.duties.filter(d => d.eligible.includes(a) || d.eligible.includes(b));
    const capacity = union.reduce((sum, d) => sum + d.units, 0), requested = targets[a] + targets[b];
    if (capacity < requested) diagnostics.push({code: 'shared-capacity-shortage', certainty: 'proved',
      engineers: [members[a].id, members[b].id], targetUnits: requested, capacityUnits: capacity,
      dates: duties.filter((_, i) => union.includes(problem.duties[i])).flatMap(d => d.dates)});
  }
  return {input, key: inputKey(input), duties, members, locks, problem, diagnostics, neighborSources};
}
export type PreparedGeneration = ReturnType<typeof prepareGeneration>;
