import {approvedPair} from '../scheduling/solver/problem.ts';
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
  return {prepared, ids, total, locked, projection,
    candidates: projection.projected.candidates.filter(c => ids.includes(c.debtorId) && ids.includes(c.creditorId)),
    key: inputKey({schedule, seniority: snapshotKey(input.seniority), ledger: projection.sourceFingerprint, cutoff: projection.cutoffMs})};
}
export type Context = ReturnType<typeof context>;

export function validTargets(c: Context, targets: Record<string, number>) {
  return Object.keys(targets).length === c.ids.length && c.ids.every(id =>
    Number.isSafeInteger(targets[id]) && targets[id] >= c.locked[id]) && sum(Object.values(targets)) === c.total;
}

/** Smallest allocation step: whole points unless the month has half-point duties. */
export function grain(c: Context) {
  const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
  return c.prepared.duties.reduce((g, d) => gcd(g, d.units), 0) || 2;
}

/** A simple availability ceiling, never a feasibility proof: the most units of
 * duties a member may take (available, not locked to someone else), without two
 * back-to-back duties unless approved. Own locked points always fit. */
export function ceilings(c: Context): Record<string, number> {
  const {duties} = c.prepared.problem;
  return Object.fromEntries(c.ids.map((id, e) => {
    let take = 0, skip = 0, previous = -1; // best totals with/without the previous duty taken
    duties.forEach((d, i) => {
      if (!d.eligible.includes(e) || (d.lock !== undefined && d.lock !== e)) return;
      const best = Math.max(take, skip);
      const joined = previous >= 0 && duties[previous].end === d.start && !approvedPair(c.prepared.problem, previous, i);
      [take, skip] = [(joined ? skip : best) + d.units, best]; previous = i;
    });
    return [id, Math.max(take, skip, c.locked[id])];
  }));
}
