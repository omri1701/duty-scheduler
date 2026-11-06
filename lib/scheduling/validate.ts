import {dayOf} from '../rota/calendar-dates.ts';
import {canonicalDuties, halfUnits, handover} from './calendar.ts';
import {prepareGeneration, type PreparedGeneration} from './domain.ts';
import {waveCost} from './rotation.ts';
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
  let coverage = 0, special = 0, preferred = 0, rotation = 0, repeats = 0, weekdayCost = 0, extraWeekends = 0, adjacent = 0, patterns = 0, thursdays = 0;
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
    const touched = new Set<string>(); // live and working copies of one neighbouring duty are one guard
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
      // Touching the same member's duty in the neighbouring month is a back-to-back day: a
      // last resort, allowed like one inside the month (decision 2026-11-01). A locked duty
      // still needs its boundary review, and an overlap is never possible.
      const touching = d.start === end || d.end === start;
      if (!touching || (lock && !approved)) fail('neighbor-conflict', d.id);
      if (!lock) touched.add(`${n.ownerMonth}/${n.start}/${n.end}`);
    }
    adjacent += touched.size;
  }
  for (const [e, member] of members.entries()) {
    const selected = duties.filter(d => assignments[d.id].primary === member.id);
    const weekends = new Set(selected.flatMap(d => d.weekendId ? [d.weekendId] : []));
    // Extra weekends and back-to-back duties are last resorts, counted rather than rejected.
    const approved = input.approvals?.find(v => v.rule === 'weekends' && v.engineer === member.id);
    const extra = Math.max(0, weekends.size - (approved?.rule === 'weekends' ? approved.weekends.length : 1));
    extraWeekends += extra * (extra + 1) / 2;
    rotation += weekends.size * (input.weekendRotation?.[member.id] ?? 0); // per weekend, like the model
    // A Thursday and a weekend (either half) in one month count once per member.
    if (weekends.size && selected.some(d => !d.weekendId && dayOf(d.startDate) === 4)) thursdays++;
    const weekdays = new Map<number, number>();
    for (const d of selected) if (!d.weekendId) {
      weekdays.set(dayOf(d.startDate), (weekdays.get(dayOf(d.startDate)) ?? 0) + 1);
      weekdayCost += input.weekdayRotation?.[member.id]?.[dayOf(d.startDate)] ?? 0;
    }
    for (const n of weekdays.values()) repeats += Math.max(0, n - 1);
    const spans: number[] = []; // start-to-start days of each spacing gap
    const days = (from: number, to: number) => Math.round((to - from) / 1440);
    for (let k = 1; k < selected.length; k++) {
      const previous = selected[k - 1], current = selected[k], gap = current.start - previous.end;
      if (gap < 0) fail('overlapping-primary', current.id);
      if (gap === 0 && !input.approvals?.some(v => v.rule === 'consecutive' &&
        v.duties[0] === previous.id && v.duties[1] === current.id)) adjacent++;
      if (gap > 0) {gaps.push(gap); spans.push(days(previous.start, current.start));}
    }
    if (!selected.length) continue;
    // Only an approved locked handover touches a neighbour; like an approved pair it is no gap.
    const before = (input.neighbors ?? []).filter(n => n.engineer === member.id && handover(n.end) <= duties[0].start);
    const after = (input.neighbors ?? []).filter(n => n.engineer === member.id && handover(n.start) >= duties.at(-1)!.end);
    const first = before.length ? selected[0].start - Math.max(...before.map(n => handover(n.end))) : 0;
    const last = after.length ? Math.min(...after.map(n => handover(n.start))) - selected.at(-1)!.end : 0;
    if (first > 0) gaps.push(first);
    if (last > 0) gaps.push(last);
    // Weekday staircases: at most one step forward (8 or 15 days, start to start) and one back
    // (6 or 13) per member, counting the nearest neighbouring-month duties; a neighbouring
    // month's own step next to this month counts as the first one.
    const byEnd = [...before].sort((a, b) => handover(a.end) - handover(b.end)), byStart = [...after].sort((a, b) => handover(a.start) - handover(b.start));
    if (first > 0) spans.push(days(handover(byEnd.at(-1)!.start), selected[0].start));
    if (last > 0) spans.push(days(selected.at(-1)!.start, handover(byStart[0].start)));
    const direction = (n: number) => n === 8 || n === 15 ? 1 : n === 6 || n === 13 ? -1 : 0;
    // Distinct neighbouring facts only: live and working copies of one duty are one.
    const distinct = (list: typeof before) => [...new Map(list.map(n => [`${n.start}/${n.end}`, n])).values()];
    const [b0, b1] = distinct(byEnd).slice(-2), [a0, a1] = distinct(byStart).slice(0, 2);
    const carried = [[b0, b1], [a0, a1]].flatMap(([x, y]) => x && y && handover(y.start) > handover(x.end) ? [direction(days(handover(x.start), handover(y.start)))] : []);
    for (const d of [1, -1]) {
      const steps = spans.filter(s => direction(s) === d).length;
      if (steps) patterns += steps - 1 + Number(carried.includes(d));
    }
    if (totals[e] < 0) fail('invalid-accounting');
  }
  // Weekend wave: each weekend duty is one tick in calendar order (see rotation.ts).
  let wave = 0, follows = 0;
  const weekendIds = duties.filter(d => d.weekendId).map(d => d.id);
  for (const [t, id] of weekendIds.entries()) {
    const primary = assignments[id].primary, state = primary && input.weekendWave && Object.hasOwn(input.weekendWave.members, primary) ? input.weekendWave.members[primary] : undefined;
    if (!primary || !input.weekendWave) continue;
    wave += waveCost(state, t);
    const before = t ? assignments[weekendIds[t - 1]].primary : input.weekendWave.previous;
    if (state?.after && before === state.after) follows++;
  }
  for (const m of members) {
    const state = input.weekendWave && Object.hasOwn(input.weekendWave.members, m.id) ? input.weekendWave.members[m.id] : undefined;
    if (state?.to !== undefined && state.to < weekendIds.length && !weekendIds.some(id => assignments[id].primary === m.id)) wave += waveCost(state, weekendIds.length);
  }
  const deficits = members.map((m, e) => halfUnits(input.targets[m.id]) - totals[e]);
  const missing = duties.filter(d => assignments[d.id].primary === null).reduce((sum, d) => sum + d.units, 0);
  if (deficits.reduce((sum, v) => sum + v, 0) !== missing) fail('point-conservation');
  return {coverage, special, units: totals.reduce((sum, v) => sum + v, 0), deficits, gaps: gaps.sort((a, b) => a - b),
    rotation, preferred, repeats, weekdays: weekdayCost, extraWeekends, adjacent, wave, follows, patterns, thursdays};
}
/** Generate's own output only: a non-weekend member on a weekend duty the manager did not
 * lock to them. Manual calendar edits stay the manager's call, so validatePrepared (which
 * also checks saved and published months) does not apply this rule. duty_private.save_generation
 * applies the same rule. */
export function requireWeekendEligibility(prepared: PreparedGeneration, assignments: PrimaryAssignments) {
  for (const d of prepared.duties) {
    const id = assignments[d.id]?.primary;
    if (d.weekendId && id && prepared.locks.get(d.id) !== id && prepared.input.members.some(m => m.id === id && m.noWeekends)) {
      throw new GenerationError('non-weekend-primary', {dutyId: d.id, engineer: id});
    }
  }
}
export function validateGeneration(input: GenerationInput, assignments: PrimaryAssignments) {
  return validatePrepared(prepareGeneration(input), assignments);
}
