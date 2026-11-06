// Personal calendar feed (decision 2026-11-06): RFC 5545 output, the feed route and links.
// The database side (token hash, own duties only, reset) is supabase/tests/calendar-feed.sql.
import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCalendar, escapeText, foldLine, parseFeed} from '../lib/calendar/ics.ts';
import {feedResponse, postgrestLoader, rateLimiter} from '../lib/calendar/feed-route.ts';
import {feedUrl, googleUrl, webcalUrl} from '../lib/calendar/links.ts';

const KEY = '0123456789abcdef0123', TOKEN = 'ab'.repeat(32), APP = 'https://duty.example.test/';
const at = '2026-10-30T08:00:00+00:00';
const duty = (day, endDay, extra = {}) => ({day, endDay, role: 'primary', title: '', points: 1, publishedAt: at, ...extra});
const feed = (duties, language = 'en') => ({language, key: KEY, duties});
const encoder = new TextEncoder();

/** RFC 5545 basics: CRLF lines of at most 75 octets, folded with one space, balanced
 * components, required properties, valid DATE values and unique UIDs. Returns unfolded lines. */
function validate(ics) {
  assert.ok(ics.endsWith('\r\n'), 'ends with CRLF');
  assert.ok(!/\r(?!\n)|(?<!\r)\n/.test(ics), 'only CRLF line breaks');
  const physical = ics.slice(0, -2).split('\r\n');
  for (const line of physical) assert.ok(encoder.encode(line).length <= 75, `line over 75 octets: ${line}`);
  const lines = ics.slice(0, -2).replace(/\r\n /g, '').split('\r\n');
  const stack = [];
  for (const line of lines) {
    assert.match(line, /^[A-Z-]+(;[A-Z-]+=[^:;]+)*:/, `content line: ${line}`);
    if (line.startsWith('BEGIN:')) stack.push(line.slice(6));
    if (line.startsWith('END:')) assert.equal(stack.pop(), line.slice(4), 'balanced components');
  }
  assert.equal(stack.length, 0);
  assert.equal(lines[0], 'BEGIN:VCALENDAR'); assert.equal(lines.at(-1), 'END:VCALENDAR');
  assert.ok(lines.includes('VERSION:2.0') && lines.some(l => l.startsWith('PRODID:')));
  const events = ics.replace(/\r\n /g, '').split('BEGIN:VEVENT').slice(1);
  const uids = new Set();
  for (const event of events) {
    for (const name of ['UID', 'DTSTAMP', 'DTSTART;VALUE=DATE', 'DTEND;VALUE=DATE', 'SUMMARY']) assert.match(event, new RegExp(`\\r\\n${name}:`), `${name} in event`);
    const uid = /\r\nUID:([^\r]+)/.exec(event)[1];
    assert.ok(!uids.has(uid), 'unique UID'); uids.add(uid);
    assert.match(event, /\r\nDTSTAMP:\d{8}T\d{6}Z\r\n/);
    const [, start] = /DTSTART;VALUE=DATE:(\d{8})/.exec(event), [, end] = /DTEND;VALUE=DATE:(\d{8})/.exec(event);
    assert.ok(end > start, 'DTEND after DTSTART');
  }
  return lines;
}
const events = ics => ics.replace(/\r\n /g, '').split('BEGIN:VEVENT').slice(1).map(e => Object.fromEntries(e.split('\r\n').filter(Boolean).filter(l => !l.startsWith('END:')).map(l => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1)])));

test('text values escape backslashes, semicolons, commas and newlines, and drop control characters', () => {
  assert.equal(escapeText('a\\b;c,d\ne\r\nf\rg\u0007h\ti'), 'a\\\\b\\;c\\,d\\ne\\nf\\ng' + 'h i');
  const [event] = events(buildCalendar(feed([duty('2026-11-02', '2026-11-03', {title: 'Holiday, coverage; \\ test', points: 3})]), APP));
  assert.equal(event.SUMMARY, 'Holiday\\, coverage\\; \\\\ test · 3 points');
});

test('lines fold at 75 octets without splitting a UTF-8 character', () => {
  const long = 'SUMMARY:' + 'תורנות '.repeat(30);
  const folded = foldLine(long);
  for (const line of folded.split('\r\n')) assert.ok(encoder.encode(line).length <= 75);
  assert.equal(folded.replace(/\r\n /g, ''), long);
  assert.ok(!folded.includes('�'));
  for (const part of folded.split('\r\n ')) assert.equal(new TextDecoder('utf-8', {fatal: true}).decode(encoder.encode(part)), part);
  assert.equal(foldLine('X'.repeat(75)), 'X'.repeat(75));
  assert.equal(foldLine('X'.repeat(76)), 'X'.repeat(75) + '\r\n X');
  // An emoji (4 octets, two UTF-16 units) stays whole.
  assert.ok(foldLine('X'.repeat(73) + '😀').startsWith('X'.repeat(73) + '\r\n 😀'));
});

test('duties are all-day events on their Israel dates, with exclusive ends and stable UIDs', () => {
  const ics = buildCalendar(feed([duty('2026-11-02', '2026-11-03'), duty('2026-11-06', '2026-11-08')]), APP);
  validate(ics);
  const [weekday, weekend] = events(ics);
  assert.equal(weekday['DTSTART;VALUE=DATE'], '20261102'); assert.equal(weekday['DTEND;VALUE=DATE'], '20261103');
  assert.equal(weekend['DTSTART;VALUE=DATE'], '20261106'); assert.equal(weekend['DTEND;VALUE=DATE'], '20261108');
  assert.equal(weekday.SUMMARY, 'Duty'); assert.equal(weekend.SUMMARY, 'Weekend duty');
  assert.equal(weekday.UID, `20261102-primary-${KEY}@duty-scheduler`);
  assert.equal(weekday.DTSTAMP, '20261030T080000Z');
  assert.match(weekend.DESCRIPTION, /^Fri 6 Nov 09:00 – Sun 8 Nov 09:00 \(Israel time\)\\n1 point\\nOpen Duty Scheduler: https:\/\/duty\.example\.test\/$/);
  assert.equal(weekend.URL, APP);
  // Rendering the same feed twice gives the same bytes (stable ETag); an edit keeps the UID.
  assert.equal(buildCalendar(feed([duty('2026-11-06', '2026-11-08')]), APP), buildCalendar(feed([duty('2026-11-06', '2026-11-08')]), APP));
  const [edited] = events(buildCalendar(feed([duty('2026-11-06', '2026-11-07', {points: 0.5})]), APP));
  assert.equal(edited.UID, weekend.UID);
  assert.ok(ics.includes('X-WR-TIMEZONE:Asia/Jerusalem\r\n'));
});

test('split weekends are two events, each half named; emergency cover has its own UID and no points', () => {
  const ics = buildCalendar(feed([duty('2026-11-13', '2026-11-14', {points: 0.5}), duty('2026-11-14', '2026-11-15', {points: 0.5}),
    duty('2026-11-14', '2026-11-15', {role: 'emergency', points: null})]), APP);
  validate(ics);
  const [friday, saturday, cover] = events(ics);
  assert.equal(friday.SUMMARY, 'Weekend duty (Friday)'); assert.equal(saturday.SUMMARY, 'Weekend duty (Saturday)');
  assert.equal(friday['DTEND;VALUE=DATE'], '20261114'); assert.equal(saturday['DTSTART;VALUE=DATE'], '20261114');
  assert.match(friday.DESCRIPTION, /\\n0\.5 points\\n/);
  assert.equal(cover.SUMMARY, 'Emergency cover');
  assert.equal(cover.UID, `20261114-emergency-${KEY}@duty-scheduler`);
  assert.doesNotMatch(cover.DESCRIPTION, /point/);
  // Extra points show in the title only when they differ from the duty's usual points.
  const [holiday] = events(buildCalendar(feed([duty('2026-11-20', '2026-11-22', {title: 'Weekend holiday', points: 3})]), APP));
  assert.equal(holiday.SUMMARY, 'Weekend holiday · 3 points');
  assert.match(holiday.DESCRIPTION, /^Weekend duty\\nFri 20 Nov/);
});

test('Hebrew feeds use Hebrew names, dates and points, still valid UTF-8 within 75 octets', () => {
  const ics = buildCalendar(feed([duty('2026-11-13', '2026-11-14', {points: 0.5}), duty('2026-11-06', '2026-11-08'),
    duty('2026-11-02', '2026-11-03', {title: 'חג, כיסוי מיוחד; ארוך מאוד מאוד מאוד מאוד מאוד', points: 3}), duty('2026-11-14', '2026-11-15', {role: 'emergency', points: null})], 'he'), APP);
  validate(ics);
  const list = events(ics);
  assert.equal(list[0].SUMMARY, 'תורנות סוף שבוע (שישי)');
  assert.equal(list[1].SUMMARY, 'תורנות סוף שבוע');
  assert.equal(list[2].SUMMARY, 'חג\\, כיסוי מיוחד\\; ארוך מאוד מאוד מאוד מאוד מאוד · 3 נקודות');
  assert.equal(list[3].SUMMARY, 'כיסוי חירום');
  assert.match(list[1].DESCRIPTION, /שעון ישראל/); assert.match(list[1].DESCRIPTION, /נקודה אחת/);
  assert.ok(ics.includes('X-WR-CALNAME:התורנויות שלי\r\n'));
});

test('an empty feed is still a valid calendar, and malformed RPC data is refused', () => {
  validate(buildCalendar(feed([]), APP));
  assert.equal(parseFeed(null), null);
  assert.deepEqual(parseFeed(feed([duty('2026-11-02', '2026-11-03')])), feed([duty('2026-11-02', '2026-11-03')]));
  for (const bad of [[], {language: 'fr', key: KEY, duties: []}, {language: 'en', key: 'short', duties: []}, feed([duty('2026-11-02', '2026-11-05')]),
    feed([duty('2026-11-03', '2026-11-05')]), feed([duty('2026-11-02', '2026-11-03', {role: 'emergency', points: 1})]), feed([duty('2026-11-02', '2026-11-03', {points: null})]),
    feed([duty('2026-11-02', '2026-11-03', {title: 'x'.repeat(61)})]), feed([duty('2026-13-02', '2026-11-03')]), feed([duty('2026-11-02', '2026-11-03', {publishedAt: 'never'})])])
    assert.throws(() => parseFeed(bad), /invalid-calendar-feed/);
});

const request = (path = `/api/calendar/${TOKEN}.ics`, init = {}) => new Request(`https://duty.example.test${path}`, init);
const always = () => 0;

test('the route serves the calendar privately with an ETag, and answers 304 when unchanged', async () => {
  const seen = [];
  const load = async token => {seen.push(token); return feed([duty('2026-11-02', '2026-11-03')]);};
  const response = await feedResponse(request(), `${TOKEN}.ics`, {load, limit: always});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/calendar; charset=utf-8');
  assert.equal(response.headers.get('cache-control'), 'private, max-age=300');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.match(response.headers.get('x-robots-tag'), /noindex/);
  const body = await response.text();
  validate(body);
  assert.match(body, /URL:https:\/\/duty\.example\.test\/\r\n/);
  assert.deepEqual(seen, [TOKEN]);
  const etag = response.headers.get('etag');
  assert.match(etag, /^"[\w-]{24}"$/);
  const cached = await feedResponse(request(undefined, {headers: {'If-None-Match': `W/${etag}`}}), TOKEN, {load, limit: always});
  assert.equal(cached.status, 304); assert.equal(await cached.text(), '');
  const head = await feedResponse(request(undefined, {method: 'HEAD'}), TOKEN, {load, limit: always});
  assert.equal(head.status, 200); assert.equal(head.headers.get('etag'), etag);
});

test('the route refuses malformed, unknown, limited and unavailable feeds without details', async () => {
  let loads = 0;
  const load = async () => {loads++; return null;};
  for (const segment of ['short', TOKEN.toUpperCase(), `${TOKEN}x`, `${TOKEN}.ics.ics`, '../duty_load']) {
    const response = await feedResponse(request(), segment, {load, limit: always});
    assert.equal(response.status, 404); assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal(loads, 0, 'malformed tokens never reach the database');
  const unknown = await feedResponse(request(), TOKEN, {load, limit: always});
  assert.equal(unknown.status, 404); assert.equal(await unknown.text(), 'Not found'); assert.equal(unknown.headers.get('cache-control'), 'no-store');
  const limited = await feedResponse(request(), TOKEN, {load, limit: () => 42});
  assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '42');
  const down = await feedResponse(request(), TOKEN, {load: async () => {throw Error('calendar-feed-unavailable');}, limit: always});
  assert.equal(down.status, 503); assert.equal(down.headers.get('cache-control'), 'no-store'); assert.doesNotMatch(await down.text(), /calendar-feed|postgres|rpc/i);
});

test('the loader calls only duty_calendar_feed with the publishable key, never a service key', async () => {
  const calls = [];
  const fetcher = async (url, init) => {calls.push({url, init}); return Response.json(feed([duty('2026-11-02', '2026-11-03')]));};
  const load = postgrestLoader('https://qhndiuahuxczujxxitsm.supabase.co', 'sb_publishable_synthetic_only', fetcher);
  assert.deepEqual(await load(TOKEN), feed([duty('2026-11-02', '2026-11-03')]));
  assert.equal(calls[0].url, 'https://qhndiuahuxczujxxitsm.supabase.co/rest/v1/rpc/duty_calendar_feed');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), {p_token: TOKEN});
  assert.equal(calls[0].init.headers.apikey, 'sb_publishable_synthetic_only');
  assert.equal(calls[0].init.headers.Authorization, undefined);
  assert.equal(await postgrestLoader('https://qhndiuahuxczujxxitsm.supabase.co', 'sb_publishable_x', async () => Response.json(null))(TOKEN), null);
  await assert.rejects(postgrestLoader('https://qhndiuahuxczujxxitsm.supabase.co', 'sb_publishable_x', async () => new Response('{}', {status: 500}))(TOKEN), /calendar-feed-unavailable/);
  assert.throws(() => postgrestLoader('https://qhndiuahuxczujxxitsm.supabase.co', 'sb_secret_never'), 'a secret key is refused');
});

test('the rate limit allows ordinary refreshes and resets after its window', () => {
  const limit = rateLimiter(3, 1000, 2);
  assert.deepEqual([0, 1, 2, 3].map(i => limit('a', i)), [0, 0, 0, 1]);
  assert.equal(limit('b', 10), 0, 'other feeds are independent');
  assert.equal(limit('a', 1000), 0, 'a new window');
  assert.equal(limit('c', 2000), 0, 'old keys are evicted at the cap');
});

test('subscription links: https feed, webcal for Apple, Google add-by-URL', () => {
  const url = feedUrl('https://duty.example.test/', TOKEN);
  assert.equal(url, `https://duty.example.test/api/calendar/${TOKEN}.ics`);
  assert.equal(webcalUrl(url), `webcal://duty.example.test/api/calendar/${TOKEN}.ics`);
  assert.equal(googleUrl(url), `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(`webcal://duty.example.test/api/calendar/${TOKEN}.ics`)}`);
});
