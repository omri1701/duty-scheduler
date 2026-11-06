-- The personal calendar feed (decision 2026-11-06), the only function the anonymous role
-- may execute: calendar apps cannot sign in. The caller proves the feed by its raw token,
-- which is hashed here (a stored hash alone opens nothing). It returns only that member's
-- own current published duties (primary or emergency cover), within 92 days back and 400
-- days ahead of today in Israel, and only while the member is approved and active. Never
-- other members, names, constraints or notes. NULL for an unknown, reset or inactive feed.
CREATE FUNCTION duty_private.calendar_feed(p_token text) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
 with feed as (
  select f.member_id,f.language from public.duty_calendar_feeds f
  join public.duty_members m on m.id=f.member_id and m.status='approved' and m.active and not m.is_temporary
  where p_token ~ '^[0-9a-f]{64}$' and f.token_hash=sha256(convert_to(p_token,'UTF8'))
 ), today as (select (now() at time zone 'Asia/Jerusalem')::date as day)
 select jsonb_build_object('language',feed.language,
  -- A stable, non-identifying key for event UIDs: survives token resets, reveals no member ID.
  'key',left(encode(sha256(convert_to('duty-calendar:'||feed.member_id::text,'UTF8')),'hex'),20),
  'duties',coalesce((select jsonb_agg(jsonb_build_object('day',a.day,'endDay',a.end_day,
    'role',case when a.primary_id=feed.member_id then 'primary' else 'emergency' end,
    'title',a.title,'points',case when a.primary_id=feed.member_id then a.points end,'publishedAt',p.published_at) order by a.day,a.primary_id=feed.member_id desc)
   from duty_private.current_duties() a join public.duty_publications p on p.id=a.publication_id, today
   where feed.member_id in (a.primary_id,a.secondary_id) and a.end_day>today.day-92 and a.day<today.day+400),'[]'::jsonb))
 from feed
$$;
