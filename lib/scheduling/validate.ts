import {dayOf} from '../rota/calendar-dates.ts';
import {canonicalDuties, halfUnits, handover} from './calendar.ts';
import {prepareGeneration, type PreparedGeneration} from './domain.ts';
import {GenerationError, type GenerationInput} from './types.ts';
import type {Metrics} from './solver/problem.ts';

export type PrimaryAssignments = Record<string, {primary: string | null; secondary?: string}>;
/** Recomputes domain rules from source facts, without normalized eligibility,
 * model rows, flow variables, solver tolerances or solver validation helpers. */
export function validatePrepared(prepared: PreparedGeneration, assignments: PrimaryAssignments): Metrics {
  const {input, members} = prepared;
  const duties = canonicalDuties(input.month, input.calendar);
  const fail = (code: string, dutyId?: string): never => {throw new GenerationError(code, {dutyId});};
  if (Object.keys(assignments).length !== duties.length || Object.keys(assignments).some(id => !duties.some(d => d.id === id))) fail('assignment-coverage-shape');
  const totals = members.map(() => 0), gaps: number[] = [];
  let coverage = 0, special = 0, preferred = 0, rotation = 0, repeats = 0, weekdayCost = 0, extraWeekends = 0, adjacent = 0;
  for (const d of duties) {
    const a = assignments[d.id];
    if (!a || a.secondary !== input.secondary?.[d.id]) fail('secondary-changed', d.id);
    const lock = input.locks?.find(l => l.dutyId === d.id);
    if (lock && a.primary !== lock.engineer) fail('lock-changed', d.id);
    if (a.primary === null) continue;
    const e = members.findIndex(m => m.id === a.primary);
    if (e < 0 || a.primary === a.secondary) fail('ineligible-primary', d.id);
    const denied = d.dates.filter(date => input.constraints?.[a.primary!]?.[date] === 'no');
    if (denied.length && !(lock?.engineer === a.primary && input.approvals?.some(v => v.rule === 'availability' &&
      v.dutyId === d.id && v.engineer === a.primary && denied.every(date => v.dates.includes(date))))) fail('unavailable-primary', d.id);
    totals[e] += d.units; coverage += d.dates.length; special += d.specialDates.length;
    preferred += d.dates.filter(date => input.constraints?.[a.primary!]?.[date] === 'prefer').length;
    if (totals[e] > halfUnits(input.targets[a.primary])) fail('target-exceeded', d.id);
    for (const n of input.neighbors ?? []) {
      if (n.engineer !== a.primary) continue;
      const start = handover(n.start), end = handover(n.end);
      if (d.start > end || start > d.end) continue;
      // Deduplication may retain either source label: approval of the exact same
      // owner/interval/identity fact acknowledges both copies of that guard.
      const approved = input.approvals?.some(v => {
        if (v.rule !== 'boundary' || v.dutyId !== d.id) return false;
        const reviewed = input.neighbors?.find(b => b.id === v.neighborId);
        return reviewed?.ownerMonth === n.ownerMonth && reviewed.start === n.start && reviewed.end === n.end && reviewed.engineer === n.engineer;
      });
      if (!(lock && approved && (d.start === end || d.end === start))) fail('neighbor-conflict', d.id);
    }
  }
  for (const [e, member] of members.entries()) {
    const selected = duties.filter(d => assignments[d.id].primary === member.id);
    const weekends = new Set(selected.flatMap(d => d.weekendId ? [d.weekendId] : []));
    // Extra weekends and back-to-back duties are last resorts, counted rather than rejected.
    const approved = input.approvals?.find(v => v.rule === 'weekends' && v.engineer === member.id);
    const extra = Math.max(0, weekends.size - (approved?.rule === 'weekends' ? approved.weekends.length : 1));
    extraWeekends += extra * (extra + 1) / 2;
    rotation += weekends.size * (input.weekendRotation?.[member.id] ?? 0); // per weekend, like the model
    const weekdays = new Map<number, number>();
    for (const d of selected) if (!d.weekendId) {
      weekdays.set(dayOf(d.startDate), (weekdays.get(dayOf(d.startDate)) ?? 0) + 1);
      weekdayCost += input.weekdayRotation?.[member.id]?.[dayOf(d.startDate)] ?? 0;
    }
    for (const n of weekdays.values()) repeats += Math.max(0, n - 1);
    for (let k = 1; k < selected.length; k++) {
      const previous = selected[k - 1], current = selected[k], gap = current.start - previous.end;
      if (gap < 0) fail('overlapping-primary', current.id);
      if (gap === 0 && !input.approvals?.some(v => v.rule === 'consecutive' &&
        v.duties[0] === previous.id && v.duties[1] === current.id)) adjacent++;
      if (gap > 0) gaps.push(gap);
    }
    if (!selected.length) continue;
    // Only an approved locked handover touches a neighbour; like an approved pair it is no gap.
    const before = (input.neighbors ?? []).filter(n => n.engineer === member.id && handover(n.end) <= duties[0].start);
    const after = (input.neighbors ?? []).filter(n => n.engineer === member.id && handover(n.start) >= duties.at(-1)!.end);
    const first = before.length ? selected[0].start - Math.max(...before.map(n => handover(n.end))) : 0;
    const last = after.length ? Math.min(...after.map(n => handover(n.start))) - selected.at(-1)!.end : 0;
    if (first > 0) gaps.push(first);
    if (last > 0) gaps.push(last);
    if (totals[e] < 0) fail('invalid-accounting');
  }
  const deficits = members.map((m, e) => halfUnits(input.targets[m.id]) - totals[e]);
  const missing = duties.filter(d => assignments[d.id].primary === null).reduce((sum, d) => sum + d.units, 0);
  if (deficits.reduce((sum, v) => sum + v, 0) !== missing) fail('point-conservation');
  return {coverage, special, units: totals.reduce((sum, v) => sum + v, 0), deficits, gaps: gaps.sort((a, b) => a - b),
    rotation, preferred, repeats, weekdays: weekdayCost, extraWeekends, adjacent};
}
export function validateGeneration(input: GenerationInput, assignments: PrimaryAssignments) {
  return validatePrepared(prepareGeneration(input), assignments);
}
