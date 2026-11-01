import {canonicalDuties} from '../scheduling/calendar.ts';
import type {CompensationEvent} from '../compensation/types.ts';
import type {PrimaryAssignments} from '../scheduling/validate.ts';
import type {AllocationInput} from './types.ts';

/** What Plan the month notes about a generated month, beside the totals: whether
 * anything is scheduled yet, and how many of each member's duties sit back-to-back
 * with another of theirs (Generate's last resort; an approved fixed pair is not
 * counted). Three days in a row count three. */
export function generatedNotes(input: AllocationInput, assignments: PrimaryAssignments) {
  const duties = canonicalDuties(input.schedule.month, input.schedule.calendar), touching = new Set<number>();
  const approved = (a: string, b: string) => input.schedule.approvals?.some(v => v.rule === 'consecutive' && v.duties[0] === a && v.duties[1] === b);
  duties.forEach((d, i) => {
    const next = duties[i + 1], primary = assignments[d.id]?.primary;
    if (next && primary && assignments[next.id]?.primary === primary && d.end === next.start && !approved(d.id, next.id)) {
      touching.add(i); touching.add(i + 1);
    }
  });
  const backToBack: Record<string, number> = {};
  for (const i of touching) {const id = assignments[duties[i].id].primary!; backToBack[id] = (backToBack[id] ?? 0) + 1;}
  return {generated: duties.some(d => assignments[d.id]?.primary), backToBack};
}


/** What changed in the points ledger between two reads of a month's plan, for the note
 * that asks to confirm again (decision 2026-11-01): the months a publication changed and
 * each member's change of balance (half-point units, positive: owed more). The month's
 * own re-plan events are how its plan is read, not a change. */
export function ledgerChange(month: string, before: {events: readonly CompensationEvent[]; net: Readonly<Record<string, number>>},
  after: {events: readonly CompensationEvent[]; net: Readonly<Record<string, number>>}) {
  const known = new Set(before.events.map(e => e.sourceKey));
  const months = [...new Set(after.events.flatMap(e => e.operation.kind === 'publication' && !known.has(e.sourceKey) &&
    !(e.operation.month === month && e.sourceKey.startsWith('replan/')) ? [e.operation.month] : []))].sort();
  const balances = [...new Set([...Object.keys(before.net), ...Object.keys(after.net)])].sort()
    .map(id => [id, (after.net[id] ?? 0) - (before.net[id] ?? 0)] as const).filter(([, units]) => units);
  return {months, balances};
}
