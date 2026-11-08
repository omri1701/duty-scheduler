import {addDays, dates, dayOf, monthNext} from '../rota/calendar-dates.ts';
import {GenerationError, type Calendar, type CanonicalDuty} from './types.ts';

export function requireDate(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date.slice(0, 4) < '1900' || date.slice(0, 4) > '9998' ||
    !Number.isFinite(Date.parse(date)) || new Date(date + 'T12:00:00Z').toISOString().slice(0, 10) !== date) {
    throw new GenerationError('invalid-date', {date});
  }
}
export function halfUnits(points: number) {
  if (!Number.isFinite(points) || points < 0 || !Number.isSafeInteger(points * 2) || points * 2 > 1e9) {
    throw new GenerationError('invalid-half-points', {points});
  }
  return points * 2;
}

const jerusalem = new Intl.DateTimeFormat('en-GB', {timeZone: 'Asia/Jerusalem',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'});
/** Actual UTC minute of the unambiguous local 09:00 handover. Never add 24h. */
export function handover(date: string) {
  requireDate(date);
  const desired = Date.parse(date + 'T09:00:00Z');
  let instant = desired;
  for (let i = 0; i < 3; i++) {
    const p = Object.fromEntries(jerusalem.formatToParts(instant).map(v => [v.type, v.value]));
    const local = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`);
    if (local === desired) return instant / 60000;
    instant += desired - local;
  }
  throw new GenerationError('invalid-handover', {date});
}

export function canonicalDuties(month: string, calendar: Calendar): CanonicalDuty[] {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new GenerationError('invalid-month');
  requireDate(month + '-01');
  const specials = [...(calendar.specials ?? [])].sort((a, b) => a.start.localeCompare(b.start));
  const specialIds = new Set<string>();
  for (const [i, s] of specials.entries()) {
    requireDate(s.start); requireDate(s.end); halfUnits(s.extra);
    if (!s.id || specialIds.has(s.id) || s.start >= s.end || s.end > addDays(s.start, 14) ||
      s.extra > 20 || (i > 0 && specials[i - 1].end > s.start)) throw new GenerationError('invalid-special', {id: s.id});
    specialIds.add(s.id);
  }
  const splits = new Set(calendar.splitWeekends ?? []);
  if (splits.size !== (calendar.splitWeekends ?? []).length) throw new GenerationError('duplicate-split');
  for (const d of splits) {requireDate(d); if (dayOf(d) !== 5) throw new GenerationError('split-not-friday', {date: d});}
  const marked = new Set(calendar.specialDates ?? []);
  for (const d of marked) requireDate(d);
  const next = monthNext(month) + '-01';
  const result: CanonicalDuty[] = [], end = dayOf(next) === 6 ? addDays(next, 1) : next;
  // Every holiday date adds its own extra: a weekday is 2 + 2·extra units, a Friday or
  // Saturday 1 + 2·extra. A weekend touched by a special stays one combined duty worth the
  // sum of its two dates; only an explicit split separates the halves, each keeping its own
  // date's units, so splitting never changes the weekend's total.
  const extraAt = (date: string) => specials.find(s => s.start <= date && date < s.end)?.extra ?? 0;
  for (let date = month + '-01'; date < end;) {
    const dow = dayOf(date);
    if (dow === 6 && date === month + '-01') {date = addDays(date, 1); continue;}
    const weekendId = dow === 5 ? date : dow === 6 ? addDays(date, -1) : undefined;
    const split = weekendId && splits.has(weekendId);
    const combined = dow === 5 && !split, until = addDays(date, combined ? 2 : 1);
    const covered = dates(date, until);
    const units = covered.reduce((sum, d) => sum + (weekendId ? 1 : 2) + halfUnits(extraAt(d)), 0);
    result.push({id: date, ownerMonth: month, startDate: date, endDate: until, dates: covered,
      start: handover(date), end: handover(until), units,
      specialDates: covered.filter(d => marked.has(d) || specials.some(s => s.start <= d && d < s.end)),
      ...(weekendId ? {weekendId} : {}), ...(combined ? {saturdayUnits: 1 + halfUnits(extraAt(addDays(date, 1)))} : {})});
    date = until;
  }
  return result;
}
export const coverageStart = (month: string, calendar: Calendar) => canonicalDuties(month, calendar)[0].start * 60000;
export function requireGenerationWindow(month: string, calendar: Calendar, now: number) {
  if (!Number.isSafeInteger(now)) throw new GenerationError('invalid-now');
  if (now >= coverageStart(month, calendar)) throw new GenerationError('generation-window-closed');
}
