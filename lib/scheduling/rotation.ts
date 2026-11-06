import {dayOf, monthNext} from '../rota/calendar-dates.ts';
import {canonicalDuties} from './calendar.ts';
import {GenerationError, type Member, type WaveMember, type WeekendWave} from './types.ts';

export type {WaveMember, WeekendWave} from './types.ts';

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
 * `joinFrom` (member → YYYY-MM): that member's duties before the month are ignored, so a
 * member rejoining the rotation counts exactly like a new one (decision 2026-11-05).
 */
export function weekendRotation(history: PublishedMonth[], members: string[], month: string,
  joinFrom: Readonly<Record<string, string>> = {}): Record<string, number> {
  const ids = new Set(members);
  if (ids.size !== members.length) throw new GenerationError('duplicate-member');
  const counts = new Map(members.map(id => [id, 0])), seen = new Set<string>();
  const months = [...history].filter(m => m.month !== month).sort((a, b) => a.month.localeCompare(b.month));
  if (new Set(months.map(m => m.month)).size !== months.length) throw new GenerationError('duplicate-history-month');
  for (const m of months) {
    const turns = new Set<string>();
    for (const d of m.duties) {
      if (!d.primary || !ids.has(d.primary) || (joinFrom[d.primary] && m.month < joinFrom[d.primary])) continue;
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

/**
 * Cross-month weekday rotation state derived from the same published months: how many
 * Sunday–Thursday duties each member has taken on each weekday (index 0 = Sunday … 4 =
 * Thursday) in the current cycle. A cycle ends once every member seen in it has covered all
 * five weekdays at least once; every count then drops by one. Members with no published duty
 * in the current cycle join the next one: while the cycle is in progress they count one on
 * every weekday (neutral for their own choice, never "due first" against the team). Weekend
 * duties never count here. The month being generated is excluded. Lower counts receive that
 * weekday first.
 */
export function weekdayRotation(history: PublishedMonth[], members: string[], month: string): Record<string, number[]> {
  const ids = new Set(members);
  if (ids.size !== members.length) throw new GenerationError('duplicate-member');
  const counts = new Map(members.map(id => [id, [0, 0, 0, 0, 0]])), seen = new Set<string>();
  const months = [...history].filter(m => m.month !== month).sort((a, b) => a.month.localeCompare(b.month));
  if (new Set(months.map(m => m.month)).size !== months.length) throw new GenerationError('duplicate-history-month');
  for (const m of months) {
    for (const d of m.duties) {
      if (!d.primary || !ids.has(d.primary)) continue;
      seen.add(d.primary);
      const dow = dayOf(d.startDate);
      if (dow <= 4) counts.get(d.primary)![dow]++;
    }
    if (seen.size && [...seen].every(id => counts.get(id)!.every(n => n >= 1))) {
      for (const id of members) counts.set(id, counts.get(id)!.map(n => Math.max(0, n - 1)));
      seen.clear();
    }
  }
  const inProgress = [...seen].some(id => counts.get(id)!.some(n => n >= 1));
  return Object.fromEntries(members.map(id => [id, seen.has(id) ? counts.get(id)! : counts.get(id)!.map(n => Math.max(n, inProgress ? 1 : 0))]));
}

/** How far a member's place may move from one cycle to the next: with N weekend members the
 * next weekend falls N − 2 … N + 2 weekend duties after the last one (decision 2026-11-06). */
export const WAVE_SPREAD = 2;
/** Wave costs: a member outside their band costs WAVE_OUT plus the distance, so the fewest
 * members leave their band and each by the fewest places (the blocked member takes the nearest
 * free place; everyone else keeps theirs). A member still in their first month costs WAVE_HOLD. */
export const WAVE_OUT = 100, WAVE_HOLD = 1000;
export function waveCost(w: WaveMember | undefined, tick: number) {
  if (w?.hold) return WAVE_HOLD;
  if (w?.from === undefined || w.to === undefined) return 0;
  const away = Math.max(0, w.from - tick, tick - w.to);
  return away ? WAVE_OUT + away : 0;
}

/**
 * Cross-month weekend wave derived from published months (decision 2026-11-06). A clock
 * counts every weekend duty, a whole weekend or either half, as one tick; a month missing from
 * the history still counts its weekends. With N weekend members, each member's next weekend
 * should land in the band N − 2 … N + 2 ticks after their last one, so their place in the
 * cycle moves at most two places and the order changes lightly from round to round (the
 * seed chooses inside the band). `after` is who held the tick right before the member's last
 * weekend: following the same person again is avoided, more weakly. A new member, or one
 * rejoining weekends (`joinFrom`), waits out their first month (`hold`) and then has no band,
 * so they take a seeded place in the next cycle. A band already a full cycle overdue (a long
 * absence) is dropped the same way. The turn counts (weekendRotation) still decide who is due.
 */
export function weekendWave(history: PublishedMonth[], members: string[], month: string,
  joinFrom: Readonly<Record<string, string>> = {}): WeekendWave {
  const ids = new Set(members);
  if (ids.size !== members.length) throw new GenerationError('duplicate-member');
  const months = history.filter(m => m.month < month).sort((a, b) => a.month.localeCompare(b.month));
  if (new Set(months.map(m => m.month)).size !== months.length) throw new GenerationError('duplicate-history-month');
  const counted = (id: string | null, m: string): id is string => !!id && ids.has(id) && !(joinFrom[id] && m < joinFrom[id]);
  const ticks: (string | null)[] = [], joined = new Set<string>();
  const unpublished = (until: string, from?: string) => {
    for (let m = from; m && m < until; m = monthNext(m)) ticks.push(...canonicalDuties(m, {}).filter(d => d.weekendId).map(() => null));
  };
  for (const [k, m] of months.entries()) {
    unpublished(m.month, k ? monthNext(months[k - 1].month) : undefined);
    const weekends = m.duties.filter(d => [5, 6].includes(dayOf(d.startDate))).sort((a, b) => a.startDate.localeCompare(b.startDate));
    for (const d of weekends) ticks.push(counted(d.primary, m.month) ? d.primary : null);
    for (const d of m.duties) if (counted(d.primary, m.month)) joined.add(d.primary);
  }
  unpublished(month, months.length ? monthNext(months.at(-1)!.month) : undefined);
  const n = members.length, wave: Record<string, WaveMember> = {};
  for (const id of members) {
    // A member's first month: rejoining from this month, or new to a team that has history.
    if (joinFrom[id] ? joinFrom[id] >= month : joined.size > 0 && !joined.has(id)) {wave[id] = {hold: true}; continue;}
    const last = ticks.lastIndexOf(id), at = last - ticks.length;
    if (last < 0 || at + n + WAVE_SPREAD < -n) {wave[id] = {}; continue;}
    const before = ticks[last - 1];
    wave[id] = {from: at + n - WAVE_SPREAD, to: at + n + WAVE_SPREAD, ...(before && before !== id ? {after: before} : {})};
  }
  const previous = ticks.at(-1);
  return {members: wave, ...(previous ? {previous} : {})};
}

/** Both rotation states for one Generate run, over the participating members. Non-weekend
 * members never take a weekend, so they are left out of the weekend rotation: they never
 * count as due and never hold a cycle open. One who cleared the setting rejoins level, like
 * a new member: duties before `weekendsFrom` don't count for them (decision 2026-11-05).
 * The weekday rotation includes everyone. */
export function generationRotations(history: PublishedMonth[], members: Member[], month: string) {
  const eligible = members.filter(m => m.active && m.approved && m.eligible), takers = eligible.filter(m => !m.noWeekends);
  const joinFrom = Object.fromEntries(takers.flatMap(m => m.weekendsFrom ? [[m.id, m.weekendsFrom]] : []));
  return {weekendRotation: weekendRotation(history, takers.map(m => m.id), month, joinFrom),
    weekendWave: weekendWave(history, takers.map(m => m.id), month, joinFrom),
    weekdayRotation: weekdayRotation(history, eligible.map(m => m.id), month)};
}
