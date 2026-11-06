// The personal calendar feed endpoint (decision 2026-11-06), independent of Next.js so it
// can be tested directly. Calendar apps cannot sign in: the URL's token is the credential,
// checked by duty_calendar_feed in the database with the publishable key only (never a
// service-role key). Unknown, reset or inactive feeds get the same 404.
import {buildCalendar, parseFeed, type Feed} from './ics.ts';
import {validatePublicKey} from '../supabase/environment.ts';

export const TOKEN = /^[0-9a-f]{64}$/;
export type LoadFeed = (token: string) => Promise<Feed | null>;

/** Calls the checked feed RPC through PostgREST as the anonymous role. */
export function postgrestLoader(url: string, key: string, fetcher: typeof fetch = fetch): LoadFeed {
  validatePublicKey(url, key);
  // Legacy local anon keys are JWTs and go in Authorization too; publishable keys never do.
  const headers: Record<string, string> = {apikey: key, 'Content-Type': 'application/json', Accept: 'application/json',
    ...(key.startsWith('sb_publishable_') ? {} : {Authorization: `Bearer ${key}`})};
  return async token => {
    const response = await fetcher(`${url.replace(/\/$/, '')}/rest/v1/rpc/duty_calendar_feed`, {method: 'POST', headers, body: JSON.stringify({p_token: token}), cache: 'no-store'});
    if (!response.ok) throw Error('calendar-feed-unavailable');
    return parseFeed(await response.json());
  };
}

/** A small per-instance limit per feed URL. Calendar apps refresh every few minutes at most;
 * this only stops a runaway client from hammering the database. */
export function rateLimiter(limit = 30, windowMs = 5 * 60_000, maxKeys = 5_000) {
  const hits = new Map<string, {start: number; count: number}>();
  return (key: string, now = Date.now()): number => {
    const entry = hits.get(key);
    if (!entry || now - entry.start >= windowMs) {
      if (hits.size >= maxKeys) for (const [k, v] of hits) if (now - v.start >= windowMs || hits.size >= maxKeys) hits.delete(k);
      hits.set(key, {start: now, count: 1});
      return 0;
    }
    entry.count++;
    return entry.count > limit ? Math.ceil((entry.start + windowMs - now) / 1000) : 0;
  };
}

const PRIVATE = {'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff'};
const text = (status: number, body: string, extra: Record<string, string> = {}) =>
  new Response(body, {status, headers: {...PRIVATE, 'Content-Type': 'text/plain; charset=utf-8', ...extra}});

async function etagOf(body: string) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)));
  return `"${btoa(String.fromCharCode(...digest.slice(0, 18))).replace(/\+/g, '-').replace(/\//g, '_')}"`;
}

export async function feedResponse(request: Request, segment: string, deps: {load: LoadFeed; limit: (key: string) => number}): Promise<Response> {
  const token = segment.replace(/\.ics$/, '');
  if (!TOKEN.test(token)) return text(404, 'Not found');
  const wait = deps.limit(token);
  if (wait > 0) return text(429, 'Too many requests', {'Retry-After': String(wait)});
  let feed: Feed | null;
  try {feed = await deps.load(token);}
  catch {return text(503, 'Calendar temporarily unavailable', {'Retry-After': '300'});}
  if (!feed) return text(404, 'Not found');
  const body = buildCalendar(feed, `${new URL(request.url).origin}/`);
  const etag = await etagOf(body);
  // Private: the URL is a secret, so no shared cache may keep it after a reset. Clients may
  // keep it five minutes, then revalidate cheaply with the ETag.
  const headers = {...PRIVATE, 'Cache-Control': 'private, max-age=60', ETag: etag, 'Content-Type': 'text/calendar; charset=utf-8',
    'Content-Disposition': 'inline; filename="duties.ics"'};
  if (request.headers.get('if-none-match')?.split(',').map(v => v.trim().replace(/^W\//, '')).includes(etag)) return new Response(null, {status: 304, headers});
  return new Response(request.method === 'HEAD' ? null : body, {status: 200, headers});
}
