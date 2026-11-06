-- Personal calendar subscription (decision 2026-11-06): each approved member can create a
-- revocable ICS feed URL of their own published duties for Google/Apple Calendar. Only the
-- token's SHA-256 hash is stored; resetting replaces it. The feed route handler calls
-- duty_calendar_feed with the publishable key (no service role), so the anonymous role gets
-- USAGE on duty_private and EXECUTE on exactly that one lookup, nothing else. Existing
-- tables, policies, functions and grants are unchanged.

GRANT USAGE ON SCHEMA duty_private TO anon;

-- Source: schemas/tables/duty_calendar_feeds.sql
-- Personal calendar subscription (decision 2026-11-06). One revocable feed per member:
-- calendar apps cannot sign in, so the feed URL carries a long random token. Only its
-- SHA-256 hash is stored; resetting replaces the hash, so the old URL stops working.
-- Rows are written only by duty_private.calendar_reset/calendar_language for the caller.
CREATE TABLE public.duty_calendar_feeds (
    member_id uuid NOT NULL,
    token_hash bytea NOT NULL,
    language text DEFAULT 'en'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT duty_calendar_feeds_token_hash_check CHECK ((length(token_hash) = 32)),
    CONSTRAINT duty_calendar_feeds_language_check CHECK ((language = ANY (ARRAY['en'::text, 'he'::text])))
);

ALTER TABLE ONLY public.duty_calendar_feeds
    ADD CONSTRAINT duty_calendar_feeds_pkey PRIMARY KEY (member_id);

ALTER TABLE ONLY public.duty_calendar_feeds
    ADD CONSTRAINT duty_calendar_feeds_token_hash_key UNIQUE (token_hash);

ALTER TABLE ONLY public.duty_calendar_feeds
    ADD CONSTRAINT duty_calendar_feeds_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.duty_members(id) ON DELETE CASCADE;

ALTER TABLE public.duty_calendar_feeds ENABLE ROW LEVEL SECURITY;

-- Source: schemas/policies/duty_calendar_feeds.sql
-- A member reads only their own feed row (never anyone else's). The raw token is never stored.
CREATE POLICY calendar_feeds_read ON public.duty_calendar_feeds FOR SELECT TO authenticated USING ((member_id = ( SELECT auth.uid() AS uid)));

-- Source: schemas/functions/duty_private/calendar_feed.sql
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

-- Source: schemas/functions/duty_private/calendar_reset.sql
-- Create or reset the caller's own calendar feed (decision 2026-11-06). Returns the new raw
-- token exactly once; only its hash is stored, so the previous URL stops working at once.
-- Personal, not team data: no workspace revision. 64 hex characters from two random UUIDs
-- (244 random bits, pg_strong_random).
CREATE FUNCTION duty_private.calendar_reset(p_language text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare token text:=replace(gen_random_uuid()::text||gen_random_uuid()::text,'-',''); saved public.duty_calendar_feeds;
begin
 if not duty_private.is_member() then raise exception 'calendar-member-required' using errcode='42501'; end if;
 if p_language is null or p_language not in ('en','he') then raise exception 'invalid-calendar-language'; end if;
 insert into public.duty_calendar_feeds(member_id,token_hash,language,created_at)
 values(auth.uid(),sha256(convert_to(token,'UTF8')),p_language,now())
 on conflict (member_id) do update set token_hash=excluded.token_hash,language=excluded.language,created_at=excluded.created_at
 returning * into saved;
 return jsonb_build_object('token',token,'createdAt',saved.created_at,'language',saved.language);
end $$;

-- Source: schemas/functions/duty_private/calendar_status.sql
-- Whether the caller has a calendar feed, and its language. Never returns the token or hash.
CREATE FUNCTION duty_private.calendar_status() RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
 select case when duty_private.is_member() then (select jsonb_build_object('createdAt',created_at,'language',language)
  from public.duty_calendar_feeds where member_id=auth.uid()) end
$$;

-- Source: schemas/functions/duty_private/calendar_language.sql
-- The caller's feed follows the language they use the app in; the URL stays the same.
CREATE FUNCTION duty_private.calendar_language(p_language text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
 if not duty_private.is_member() then raise exception 'calendar-member-required' using errcode='42501'; end if;
 if p_language is null or p_language not in ('en','he') then raise exception 'invalid-calendar-language'; end if;
 update public.duty_calendar_feeds set language=p_language where member_id=auth.uid();
end $$;

-- Source: schemas/functions/public/duty_calendar_feed.sql
CREATE FUNCTION public.duty_calendar_feed(p_token text) RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$select duty_private.calendar_feed(p_token)$$;

-- Source: schemas/functions/public/duty_calendar_reset.sql
CREATE FUNCTION public.duty_calendar_reset(p_language text) RETURNS jsonb
    LANGUAGE sql
    SET search_path TO ''
    AS $$select duty_private.calendar_reset(p_language)$$;

-- Source: schemas/functions/public/duty_calendar_status.sql
CREATE FUNCTION public.duty_calendar_status() RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$select duty_private.calendar_status()$$;

-- Source: schemas/functions/public/duty_calendar_language.sql
CREATE FUNCTION public.duty_calendar_language(p_language text) RETURNS void
    LANGUAGE sql
    SET search_path TO ''
    AS $$select duty_private.calendar_language(p_language)$$;

-- Source: schemas/grants/tables.sql (calendar feed)
-- Own row only (RLS); writes only through duty_private.calendar_reset/calendar_language.
REVOKE ALL ON TABLE public.duty_calendar_feeds FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.duty_calendar_feeds TO authenticated;
GRANT ALL ON TABLE public.duty_calendar_feeds TO service_role;

-- Source: schemas/grants/functions.sql (calendar feed)
-- Personal calendar feed (decision 2026-11-06). The feed lookup is the only application
-- function the anonymous role may execute: calendar apps cannot sign in, so the route
-- handler calls it with the publishable key and the URL's raw token. The rest are the
-- caller's own create/reset, status and language, for signed-in approved members.
REVOKE ALL ON FUNCTION duty_private.calendar_feed(p_token text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION duty_private.calendar_feed(p_token text) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.duty_calendar_feed(p_token text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.duty_calendar_feed(p_token text) TO anon, authenticated;

REVOKE ALL ON FUNCTION duty_private.calendar_reset(p_language text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION duty_private.calendar_reset(p_language text) TO authenticated;

REVOKE ALL ON FUNCTION public.duty_calendar_reset(p_language text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.duty_calendar_reset(p_language text) TO authenticated;

REVOKE ALL ON FUNCTION duty_private.calendar_status() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION duty_private.calendar_status() TO authenticated;

REVOKE ALL ON FUNCTION public.duty_calendar_status() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.duty_calendar_status() TO authenticated;

REVOKE ALL ON FUNCTION duty_private.calendar_language(p_language text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION duty_private.calendar_language(p_language text) TO authenticated;

REVOKE ALL ON FUNCTION public.duty_calendar_language(p_language text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.duty_calendar_language(p_language text) TO authenticated;
