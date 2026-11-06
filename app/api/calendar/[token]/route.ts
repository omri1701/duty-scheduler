// Personal calendar subscription feed (decision 2026-11-06): /api/calendar/<token>.ics
import {feedResponse, postgrestLoader, rateLimiter} from '../../../../lib/calendar/feed-route.ts';
export const dynamic = 'force-dynamic';

const limit = rateLimiter();
type Context = {params: Promise<{token: string}>};

async function handle(request: Request, {params}: Context) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return new Response('Not configured', {status: 503, headers: {'Cache-Control': 'no-store'}});
  let load;
  try {load = postgrestLoader(url, key);} catch {return new Response('Not configured', {status: 503, headers: {'Cache-Control': 'no-store'}});}
  return feedResponse(request, (await params).token, {load, limit});
}
export const GET = handle;
export const HEAD = handle;
