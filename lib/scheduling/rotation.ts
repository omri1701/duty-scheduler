import {dayOf} from '../rota/calendar-dates.ts';
import {GenerationError} from './types.ts';

/** One published month's primaries, as the current publication shows them. */
export type PublishedMonth = {month: string; duties: {startDate: string; primary: string | null}[]};

/**
 * Weekend rotation state derived from published months: how many weekend turns each
 * member has taken in the current cycle. A cycle ends once every member seen in it
 * has had a weekend; everyone's count then drops by one. Members with no published
 * duty in the current cycle join the next one: while the cycle is in progress they
 * count as if they had already had their turn, so they are never "due first".
 * Either half of a split weekend is a turn; two halves in one month are one turn.
 * The month being generated is excluded. Lower counts receive weekends first.
 */
export function weekendRotation(history: PublishedMonth[], members: string[], month: string): Record<string, number> {
  const ids = new Set(members);
  if (ids.size !== members.length) throw new GenerationError('duplicate-member');
  const counts = new Map(members.map(id => [id, 0])), seen = new Set<string>();
  const months = [...history].filter(m => m.month !== month).sort((a, b) => a.month.localeCompare(b.month));
  if (new Set(months.map(m => m.month)).size !== months.length) throw new GenerationError('duplicate-history-month');
  for (const m of months) {
    const turns = new Set<string>();
    for (const d of m.duties) {
      if (!d.primary || !ids.has(d.primary)) continue;
      seen.add(d.primary);
      if ([5, 6].includes(dayOf(d.startDate))) turns.add(d.primary);
    }
    for (const id of turns) counts.set(id, counts.get(id)! + 1);
    if (seen.size && [...seen].every(id => counts.get(id)! >= 1)) {
      for (const id of members) counts.set(id, Math.max(0, counts.get(id)! - 1));
      seen.clear();
    }
  }
  const inProgress = [...seen].some(id => counts.get(id)! >= 1);
  return Object.fromEntries(members.map(id => [id, seen.has(id) ? counts.get(id)! : Math.max(counts.get(id)!, inProgress ? 1 : 0)]));
}
