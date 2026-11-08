import {approvedPair, boundaryBlocked, boundaryTouches} from '../scheduling/solver/problem.ts';
import {prepareGeneration, inputKey, snapshotKey} from '../scheduling/domain.ts';
import {canonicalDuties, coverageStart} from '../scheduling/calendar.ts';
import {project} from '../compensation/index.ts';
import type {AllocationInput} from './types.ts';

export const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
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
  // Manual allocation/lock review remains available after opening. Do not project
  // actual accounting backwards; Generate enforces its separate time window.
  const projection = project(input.events, input.now, Math.max(input.now, coverageStart(schedule.month, schedule.calendar)));
  // Non-weekend members, and the weekend points only the others can take (decision 2026-11-05).
  const nonWeekend = new Set(prepared.members.filter(m => m.noWeekends).map(m => m.id));
  const lockOf = new Map((schedule.locks ?? []).map(l => [l.dutyId, l.engineer]));
  // A split weekend never changes planning (decision 2026-11-07): fair shares, uneven credit
  // and the duty step see each split as the weekend it came from (its halves' sum), locked or
  // not; duty_private.confirm_allocation merges the same way. The exact-points check uses
  // Generate's own duties: an unlocked split is one weekend again, a locked one stays split.
  const merge = (joined: (weekendId: string) => boolean) => {
    const out: PlanningDuty[] = [];
    for (const d of prepared.duties) {
      const last = out.at(-1);
      if (d.weekendId && last?.weekendId === d.weekendId && joined(d.weekendId)) last.units += d.units;
      else out.push({id: d.id, units: d.units, ...(d.weekendId ? {weekendId: d.weekendId} : {})});
    }
    return out;
  };
  const weights = merge(() => true).map(d => d.units);
  const splitLocked = (weekendId: string) => prepared.duties.some(d => d.weekendId === weekendId && lockOf.has(d.id));
  const generated = merge(weekendId => !splitLocked(weekendId));
  const weekendDuties = generated.filter(d => d.weekendId && !lockOf.has(d.id)).map(d => d.units).sort((a, b) => b - a);
  const weekendFree = sum(weekendDuties);
  return {prepared, ids, total, locked, nonWeekend, weekendFree, weekendDuties, weights, generated, projection, seniority: [...input.seniority],
    candidates: projection.projected.candidates.filter(c => ids.includes(c.debtorId) && ids.includes(c.creditorId)),
    key: inputKey({schedule, seniority: snapshotKey(input.seniority), ledger: projection.sourceFingerprint, cutoff: projection.cutoffMs})};
}
export type Context = ReturnType<typeof context>;
/** A duty as planning sees it: a split weekend's halves may be one weekend again. */
export type PlanningDuty = {id: string; units: number; weekendId?: string};

export function validTargets(c: Context, targets: Record<string, number>) {
  return Object.keys(targets).length === c.ids.length && c.ids.every(id =>
    Number.isSafeInteger(targets[id]) && targets[id] >= c.locked[id]) && sum(Object.values(targets)) === c.total;
}

/** Smallest allocation step: whole points unless the month has half-point duties (a split
 * weekend's halves count as their weekend). */
export function grain(c: Context) {
  const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
  return c.weights.reduce((g, units) => gcd(g, units), 0) || 2;
}

/** The hard availability ceiling, never a feasibility proof: the units of every duty a
 * member may take (available, not locked to someone else, not overlapping their own duty
 * in a neighbouring month). Generate fills such a target with back-to-back duties (touching
 * a neighbouring month's too) and extra weekends as a last resort. Own locked points always fit. */
export function availability(c: Context): Record<string, number> {
  const {problem} = c.prepared;
  return Object.fromEntries(c.ids.map((id, e) => [id, Math.max(c.locked[id], sum(problem.duties.map((d, i) =>
    d.eligible.includes(e) && (d.lock === undefined || d.lock === e) && !boundaryBlocked(problem, e, i) ? d.units : 0)))]));
}
export const availableCeilings = (input: AllocationInput) => availability(context(input));

/** The spaced ceiling, never a feasibility proof: the most units of duties a member may
 * take (available, not locked to someone else) without two back-to-back duties unless
 * approved. Automatic repayments stay within it; a target above it needs back-to-back
 * days. Own locked points always fit. */
export function ceilings(c: Context): Record<string, number> {
  const {duties} = c.prepared.problem;
  return Object.fromEntries(c.ids.map((id, e) => {
    let take = 0, skip = 0, previous = -1; // best totals with/without the previous duty taken
    duties.forEach((d, i) => {
      if (!d.eligible.includes(e) || (d.lock !== undefined && d.lock !== e) || boundaryBlocked(c.prepared.problem, e, i) ||
        boundaryTouches(c.prepared.problem, e, i)) return;
      const best = Math.max(take, skip);
      const joined = previous >= 0 && duties[previous].end === d.start && !approvedPair(c.prepared.problem, previous, i);
      [take, skip] = [(joined ? skip : best) + d.units, best]; previous = i;
    });
    return [id, Math.max(take, skip, c.locked[id])];
  }));
}
