-- The caller's own app language (decision 2026-11-06). Saved in the background when
-- the language changes; no workspace revision, so it never conflicts with an edit.
CREATE FUNCTION duty_private.set_language(p_language text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
 if auth.uid() is null then raise exception 'Sign in first' using errcode='42501'; end if;
 if p_language is null or p_language not in ('en','he') then raise exception 'Choose English or Hebrew'; end if;
 update public.duty_members set language=p_language where auth_user_id=auth.uid() and language is distinct from p_language;
 -- The personal calendar feed follows the same language; its URL stays the same.
 update public.duty_calendar_feeds f set language=p_language from public.duty_members m
  where m.auth_user_id=auth.uid() and f.member_id=m.id and f.language<>p_language;
end $$;

-- The caller's own notification switches (defaults when never saved) and how many
-- devices are registered. Never another member's.
CREATE FUNCTION duty_private.notification_settings() RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare s public.duty_notification_settings;
begin
 if not duty_private.is_member() then raise exception 'Member access required' using errcode='42501'; end if;
 select * into s from public.duty_notification_settings where member_id=auth.uid();
 return jsonb_build_object('deadlines',coalesce(s.deadlines,true),'published',coalesce(s.published,true),'swaps',coalesce(s.swaps,true),
  'edits',coalesce(s.edits,true),'evening',coalesce(s.evening,true),'eveningTime',to_char(coalesce(s.evening_time,time '18:00'),'HH24:MI'),
  'morning',coalesce(s.morning,true),'morningTime',to_char(coalesce(s.morning_time,time '08:30'),'HH24:MI'),'members',coalesce(s.members,true),
  'devices',(select count(*) from public.duty_push_subscriptions where member_id=auth.uid()));
end $$;

-- Replaces the caller's own switches. Every key is required with its exact type;
-- times are quarter hours (HH:00/15/30/45, the clock runs every 15 minutes) in
-- Asia/Jerusalem. No workspace revision: it is personal.
CREATE FUNCTION duty_private.set_notification_settings(p_settings jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare k text;
begin
 if not duty_private.is_member() then raise exception 'Member access required' using errcode='42501'; end if;
 if jsonb_typeof(p_settings) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_settings) given(name)
  where given.name not in ('deadlines','published','swaps','edits','evening','eveningTime','morning','morningTime','members')) then
  raise exception 'Invalid notification settings';
 end if;
 foreach k in array array['deadlines','published','swaps','edits','evening','morning','members'] loop
  if jsonb_typeof(p_settings->k) is distinct from 'boolean' then raise exception 'Invalid notification settings'; end if;
 end loop;
 if coalesce(p_settings->>'eveningTime','') !~ '^([01][0-9]|2[0-3]):(00|15|30|45)$' or coalesce(p_settings->>'morningTime','') !~ '^([01][0-9]|2[0-3]):(00|15|30|45)$' then
  raise exception 'Invalid notification time';
 end if;
 insert into public.duty_notification_settings(member_id,deadlines,published,swaps,edits,evening,evening_time,morning,morning_time,members,updated_at)
 values(auth.uid(),(p_settings->>'deadlines')::boolean,(p_settings->>'published')::boolean,(p_settings->>'swaps')::boolean,(p_settings->>'edits')::boolean,
  (p_settings->>'evening')::boolean,(p_settings->>'eveningTime')::time,(p_settings->>'morning')::boolean,(p_settings->>'morningTime')::time,(p_settings->>'members')::boolean,now())
 on conflict(member_id) do update set deadlines=excluded.deadlines,published=excluded.published,swaps=excluded.swaps,edits=excluded.edits,
  evening=excluded.evening,evening_time=excluded.evening_time,morning=excluded.morning,morning_time=excluded.morning_time,members=excluded.members,updated_at=now();
 return duty_private.notification_settings();
end $$;

-- Registers this device for the caller. Only known browser push services are
-- accepted (the sender never contacts any other host); an endpoint moves to whoever
-- registered it last, and each member keeps their ten most recent devices.
CREATE FUNCTION duty_private.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare host text:=lower(substring(coalesce(p_endpoint,'') from '^https://([^/?#@:]+)(?::443)?/'));
begin
 if not duty_private.is_member() then raise exception 'Member access required' using errcode='42501'; end if;
 if host is null or length(p_endpoint)>1000 or host !~ '^(fcm\.googleapis\.com|([a-z0-9-]+\.)*push\.apple\.com|([a-z0-9-]+\.)*push\.services\.mozilla\.com|[a-z0-9-]+\.notify\.windows\.com)$' then
  raise exception 'push-service-unsupported';
 end if;
 if coalesce(p_p256dh,'') !~ '^[A-Za-z0-9_-]{80,100}$' or coalesce(p_auth,'') !~ '^[A-Za-z0-9_-]{16,44}$' then raise exception 'push-keys-invalid'; end if;
 insert into public.duty_push_subscriptions(member_id,endpoint,p256dh,auth) values(auth.uid(),p_endpoint,p_p256dh,p_auth)
 on conflict(endpoint) do update set member_id=excluded.member_id,p256dh=excluded.p256dh,auth=excluded.auth,last_seen_at=now();
 delete from public.duty_push_subscriptions where id in (select id from public.duty_push_subscriptions where member_id=auth.uid() order by last_seen_at desc,id offset 10);
end $$;

-- Removes one of the caller's own devices (turning notifications off, or signing
-- out on this device). Any signed-in caller, so sign-out never fails here.
CREATE FUNCTION duty_private.delete_push_subscription(p_endpoint text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
 if auth.uid() is null then raise exception 'Sign in first' using errcode='42501'; end if;
 delete from public.duty_push_subscriptions where endpoint=p_endpoint and member_id=auth.uid();
end $$;
