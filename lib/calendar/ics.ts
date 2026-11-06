// Personal calendar feed (decision 2026-11-06): RFC 5545 text for one member's own
// published duties, from duty_calendar_feed. Pure: no storage, network or clock.
// Duties are all-day events on their Israel calendar dates (a duty runs 09:00 to the next
// day's 09:00 in Asia/Jerusalem, which the description says), so no time-zone conversion
// can move a duty to the wrong day. DTEND is exclusive, like the duty row's end_day.

export type FeedLanguage = 'en' | 'he';
export type FeedDuty = {day: string; endDay: string; role: 'primary' | 'emergency'; title: string; points: number | null; publishedAt: string};
export type Feed = {language: FeedLanguage; key: string; duties: FeedDuty[]};

const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const DAY_MS = 86_400_000;
const time = (day: string) => Date.parse(`${day}T00:00:00Z`);
const weekday = (day: string) => new Date(time(day)).getUTCDay();

/** Validates the RPC's JSON. Anything unexpected is refused rather than half-rendered. */
export function parseFeed(value: unknown): Feed | null {
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw Error('invalid-calendar-feed');
  const {language, key, duties} = value as Record<string, unknown>;
  if ((language !== 'en' && language !== 'he') || typeof key !== 'string' || !/^[0-9a-f]{20}$/.test(key) || !Array.isArray(duties)) throw Error('invalid-calendar-feed');
  return {language, key, duties: duties.map(item => {
    if (typeof item !== 'object' || item === null) throw Error('invalid-calendar-feed');
    const {day, endDay, role, title, points, publishedAt} = item as Record<string, unknown>;
    if (typeof day !== 'string' || typeof endDay !== 'string' || !DATE.test(day) || !DATE.test(endDay)) throw Error('invalid-calendar-feed');
    const span = (time(endDay) - time(day)) / DAY_MS;
    if (!(span === 1 || (span === 2 && weekday(day) === 5))) throw Error('invalid-calendar-feed');
    if ((role !== 'primary' && role !== 'emergency') || typeof title !== 'string' || title.length > 60) throw Error('invalid-calendar-feed');
    if (role === 'primary' ? typeof points !== 'number' || !Number.isFinite(points) || points < 0 : points !== null) throw Error('invalid-calendar-feed');
    if (typeof publishedAt !== 'string' || Number.isNaN(Date.parse(publishedAt))) throw Error('invalid-calendar-feed');
    return {day, endDay, role, title, points: points as number | null, publishedAt};
  })};
}

/** TEXT value escaping (RFC 5545 3.3.11); other control characters are dropped. */
export function escapeText(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n').replace(/\t/g, ' ');
}

const encoder = new TextEncoder();
/** Folds a content line at 75 octets (RFC 5545 3.1), never inside a UTF-8 character. */
export function foldLine(line: string): string {
  const parts: string[] = [];
  let current = '', size = 0, limit = 75;
  for (const char of line) {
    const bytes = encoder.encode(char).length;
    if (size + bytes > limit) {parts.push(current); current = ''; size = 0; limit = 74;}
    current += char; size += bytes;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

const compactDate = (day: string) => day.replaceAll('-', '');
const stamp = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const number = (value: number) => String(Math.round(value * 100) / 100);

type Shape = 'day' | 'weekend' | 'friday' | 'saturday';
function shape(duty: FeedDuty): Shape {
  if (duty.endDay !== plusDays(duty.day, 1)) return 'weekend';
  return weekday(duty.day) === 5 ? 'friday' : weekday(duty.day) === 6 ? 'saturday' : 'day';
}
const plusDays = (day: string, days: number) => new Date(time(day) + days * DAY_MS).toISOString().slice(0, 10);
const standardPoints = (s: Shape) => (s === 'friday' || s === 'saturday' ? 0.5 : 1);

const LABELS = {
  en: {calendar: 'My duties', description: 'Your own published duties from Duty Scheduler.', day: 'Duty', weekend: 'Weekend duty',
    friday: 'Weekend duty (Friday)', saturday: 'Weekend duty (Saturday)', emergency: 'Emergency cover', israel: 'Israel time', open: 'Open Duty Scheduler',
    points: (n: number) => (n === 1 ? '1 point' : `${number(n)} points`), locale: 'en-GB'},
  he: {calendar: 'התורנויות שלי', description: 'התורנויות שפורסמו לך בלוח התורנויות.', day: 'תורנות', weekend: 'תורנות סוף שבוע',
    friday: 'תורנות סוף שבוע (שישי)', saturday: 'תורנות סוף שבוע (שבת)', emergency: 'כיסוי חירום', israel: 'שעון ישראל', open: 'לפתיחת לוח התורנויות',
    points: (n: number) => (n === 1 ? 'נקודה אחת' : `${number(n)} נקודות`), locale: 'he-IL'},
} as const;

function handover(day: string, language: FeedLanguage) {
  return new Intl.DateTimeFormat(LABELS[language].locale, {weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC'}).format(new Date(time(day)));
}

/** One VEVENT's content lines. The UID is stable for the same member, start date and role,
 * so a changed duty replaces its event and a swapped-away duty simply disappears. */
export function eventLines(duty: FeedDuty, feed: Feed, appUrl: string): string[] {
  const l = LABELS[feed.language], s = shape(duty), emergency = duty.role === 'emergency';
  const kind = emergency ? l.emergency : l[s];
  const extra = !emergency && duty.points !== null && duty.points !== standardPoints(s);
  const summary = [duty.title.trim() || kind, ...(extra ? [l.points(duty.points!)] : [])].join(' · ');
  const description = [
    ...(duty.title.trim() ? [kind] : []),
    `${handover(duty.day, feed.language)} 09:00 – ${handover(duty.endDay, feed.language)} 09:00 (${l.israel})`,
    ...(!emergency && duty.points !== null ? [l.points(duty.points)] : []),
    `${l.open}: ${appUrl}`,
  ].join('\n');
  const modified = stamp(duty.publishedAt);
  return ['BEGIN:VEVENT', `UID:${compactDate(duty.day)}-${duty.role}-${feed.key}@duty-scheduler`, `DTSTAMP:${modified}`, `LAST-MODIFIED:${modified}`,
    `DTSTART;VALUE=DATE:${compactDate(duty.day)}`, `DTEND;VALUE=DATE:${compactDate(duty.endDay)}`,
    `SUMMARY:${escapeText(summary)}`, `DESCRIPTION:${escapeText(description)}`, `URL:${appUrl}`,
    'TRANSP:TRANSPARENT', 'STATUS:CONFIRMED', 'END:VEVENT'];
}

/** The complete iCalendar object: CRLF line ends, folded lines, a final CRLF. */
export function buildCalendar(feed: Feed, appUrl: string): string {
  const l = LABELS[feed.language];
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Duty Scheduler//Personal duty feed//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `NAME:${escapeText(l.calendar)}`, `X-WR-CALNAME:${escapeText(l.calendar)}`, `X-WR-CALDESC:${escapeText(l.description)}`,
    'X-WR-TIMEZONE:Asia/Jerusalem', 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H',
    ...feed.duties.flatMap(duty => eventLines(duty, feed, appUrl)), 'END:VCALENDAR'];
  return lines.map(foldLine).join('\r\n') + '\r\n';
}
