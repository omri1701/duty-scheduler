import {addDays, dayOf, type Assignment, type Duty} from './engine.ts';

/** Display-only: adjacent duties with the same primary read as one bar across their dates.
 * Nothing here changes a duty, its points, its owner month or what a tap edits. */
export type StreakCell = {
  position: 'only' | 'start' | 'middle' | 'end';
  /** The streak continues from the previous calendar row (this duty starts on a Sunday). */
  breakBefore: boolean;
  /** The streak continues on the next calendar row (this duty ends on a Saturday). */
  breakAfter: boolean;
  /** The member's name shows on the first cell of the streak and again after a row break. */
  showName: boolean;
  /** The special title shows once, on the streak's first special duty. */
  showTitle: boolean;
  /** Total extra points of the streak's special duties, shown once on its last day. */
  badge?: number;
};
/** Extra points beyond the duty's ordinary weight (1, or 0.5 per weekend date). */
export const extraPoints = (d: Duty) => d.points - (d.weekendId ? (d.end === addDays(d.start, 2) ? 1 : 0.5) : 1);

export function streakCells(duties: readonly Duty[], assignments: Record<string, Assignment>): Record<string, StreakCell> {
  const sorted = [...duties].sort((a, b) => a.start.localeCompare(b.start)), result: Record<string, StreakCell> = {};
  const primary = (d: Duty) => assignments[d.id]?.primary || '';
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j].end === sorted[j + 1].start && primary(sorted[j]) && primary(sorted[j]) === primary(sorted[j + 1])) j++;
    const chain = sorted.slice(i, j + 1), specials = chain.filter(d => d.kind === 'special');
    const total = specials.reduce((sum, d) => sum + extraPoints(d), 0);
    chain.forEach((d, k) => {
      const breakBefore = k > 0 && dayOf(d.start) === 0, breakAfter = k < chain.length - 1 && dayOf(addDays(d.end, -1)) === 6;
      result[d.id] = {position: chain.length === 1 ? 'only' : k === 0 ? 'start' : k === chain.length - 1 ? 'end' : 'middle',
        breakBefore, breakAfter, showName: k === 0 || breakBefore, showTitle: specials[0] === d,
        ...(specials.length && k === chain.length - 1 ? {badge: total} : {})};
    });
    i = j + 1;
  }
  return result;
}
