// The signed-in member's own calendar feed (decision 2026-11-06): status, create/reset and
// language, through the checked RPCs. The raw token is returned only by a reset.
import type {DutyClient} from './rpc.ts';
import type {FeedLanguage} from '../calendar/ics.ts';

export type CalendarStatus = {createdAt: string; language: FeedLanguage} | null;
export type CalendarLink = {token: string; createdAt: string; language: FeedLanguage};

function status(value: unknown): CalendarStatus {
  if (value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v !== 'object' || typeof v.createdAt !== 'string' || (v.language !== 'en' && v.language !== 'he')) throw Error('invalid-calendar-feed');
  return {createdAt: v.createdAt, language: v.language};
}

export async function calendarStatus(client: DutyClient): Promise<CalendarStatus> {
  const {data, error} = await client.rpc('duty_calendar_status');
  if (error) throw error;
  return status(data ?? null);
}

export async function resetCalendar(client: DutyClient, language: FeedLanguage): Promise<CalendarLink> {
  const {data, error} = await client.rpc('duty_calendar_reset', {p_language: language});
  if (error) throw error;
  const saved = status(data), token = (data as {token?: unknown} | null)?.token;
  if (!saved || typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) throw Error('invalid-calendar-feed');
  return {...saved, token};
}

export async function setCalendarLanguage(client: DutyClient, language: FeedLanguage): Promise<void> {
  const {error} = await client.rpc('duty_calendar_language', {p_language: language});
  if (error) throw error;
}

// The raw link is kept only on this device, so it can be copied again here; the database
// keeps just its hash. Sign-out forgets it (forgetCalendarLinks).
const PREFIX = 'duty-calendar-link:';
export function rememberedLink(member: string, createdAt: string): string | null {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFIX + member) ?? 'null') as {token?: unknown; createdAt?: unknown} | null;
    return saved && saved.createdAt === createdAt && typeof saved.token === 'string' && /^[0-9a-f]{64}$/.test(saved.token) ? saved.token : null;
  } catch {return null;}
}
export function rememberLink(member: string, link: CalendarLink) {
  try {localStorage.setItem(PREFIX + member, JSON.stringify({token: link.token, createdAt: link.createdAt}));} catch {}
}
export function forgetCalendarLinks() {
  try {for (const key of Object.keys(localStorage)) if (key.startsWith(PREFIX)) localStorage.removeItem(key);} catch {}
}
