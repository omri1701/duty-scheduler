import type {DutyRow, Snapshot, SwapRequest} from '@/lib/supabase/snapshot';
import {swapNeedsAction, visibleSwapRequests} from '@/lib/supabase/swaps';
import {addDays, dayOf} from '@/lib/rota/calendar-dates';

export type MyDuty = {row: DutyRow; month: string; role: 'primary' | 'cover'; kind: 'weekday' | 'weekend' | 'holiday'};

const ownerMonth = (day: string) => (dayOf(day) === 6 ? addDays(day, -1) : day).slice(0, 7);

/** The signed-in member's published duties that haven't ended, soonest first. */
export function myUpcomingDuties(raw: Snapshot, me: string, today: string): MyDuty[] {
  const current = new Set(raw.months.map(m => m.current_publication_id).filter(Boolean));
  return raw.assignments
    .filter(r => r.publication_id && current.has(r.publication_id) && r.end_day > today && (r.primary_id === me || r.secondary_id === me))
    .sort((a, b) => a.day.localeCompare(b.day))
    .map(row => ({row, month: ownerMonth(row.day), role: row.primary_id === me ? 'primary' : 'cover',
      kind: row.extra_points > 0 || (row.saturday_extra_points ?? 0) > 0 || row.title ? 'holiday' : [5, 6].includes(dayOf(row.day)) ? 'weekend' : 'weekday'}));
}

export const daysBetween = (from: string, to: string) => Math.round((Date.parse(to + 'T12:00:00Z') - Date.parse(from + 'T12:00:00Z')) / 86400000);

/** "Today", "Tomorrow" or "In 4 days" (never "in 1 day"), plus the date. */
export function dutyWhen(day: string, today: string, lang: 'en' | 'he') {
  const diff = daysBetween(today, day);
  const date = new Date(day + 'T12:00:00Z').toLocaleDateString(lang === 'en' ? 'en-GB' : 'he-IL', {weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC'});
  const long = new Date(day + 'T12:00:00Z').toLocaleDateString(lang === 'en' ? 'en-GB' : 'he-IL', {weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC'});
  const label = diff <= 0 ? (lang === 'en' ? 'Today' : 'היום') : diff === 1 ? (lang === 'en' ? 'Tomorrow' : 'מחר')
    : lang === 'en' ? `In ${diff} days` : diff === 2 ? 'בעוד יומיים' : `בעוד ${diff} ימים`;
  return {label, date, long, diff};
}

/** The greeting for the hour in Israel. */
export function greeting(now: Date, lang: 'en' | 'he') {
  const hour = Number(new Intl.DateTimeFormat('en-GB', {hour: 'numeric', hour12: false, timeZone: 'Asia/Jerusalem'}).format(now));
  if (hour >= 5 && hour < 12) return lang === 'en' ? 'Good morning' : 'בוקר טוב';
  if (hour >= 12 && hour < 17) return lang === 'en' ? 'Good afternoon' : 'צהריים טובים';
  if (hour >= 17 && hour < 22) return lang === 'en' ? 'Good evening' : 'ערב טוב';
  return lang === 'en' ? 'Hello' : 'שלום';
}

/** Swap requests that wait for the member's answer (or, for admins, their approval). */
export function waitingSwaps(raw: Snapshot, me: string, admin: boolean): SwapRequest[] {
  const temporary = new Set(raw.members.filter(m => m.is_temporary).map(m => m.id));
  return visibleSwapRequests(raw.swapRequests ?? [], me, admin, temporary).filter(r => swapNeedsAction(r, me, admin, temporary));
}

/** The next month whose constraints are still open for the member. */
export function constraintsDue(raw: Snapshot, today: string, admin: boolean) {
  return raw.months
    .filter(m => m.month >= today.slice(0, 7) && m.status !== 'published' && (admin || m.deadline >= today))
    .sort((a, b) => a.month.localeCompare(b.month))[0] ?? null;
}
