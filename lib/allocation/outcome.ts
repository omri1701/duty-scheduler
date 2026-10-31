import {canonicalDuties} from '../scheduling/calendar.ts';
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

