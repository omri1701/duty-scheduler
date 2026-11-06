-- Web push notifications, the settings screen and each member's language (decision
-- 2026-11-06). Adds duty_members.language (NULL until the member chooses; only the
-- caller's own row, through duty_set_language), four own-rows-only tables (switches,
-- devices, the notification log and its deliveries), checked RPCs that never touch the
-- workspace revision, event triggers on publication, published edits, swaps and
-- sign-ups, and the scheduler entry point duty_private.push_tick(). pg_net, pg_cron and
-- the Vault secrets are hosted setup steps (supabase/admin/push-scheduler.sql), not
-- part of this migration; without them notifications are recorded but never sent.

ALTER TABLE public.duty_members ADD COLUMN language text;
ALTER TABLE public.duty_members ADD CONSTRAINT duty_members_language_check CHECK ((language = ANY (ARRAY['en'::text, 'he'::text])));

-- Source: schemas/tables/duty_notifications.sql
-- Web push (decision 2026-11-06). Members read only their own rows; every write goes
-- through a checked RPC (settings, devices) or SECURITY DEFINER triggers and the
-- scheduler (notifications, deliveries). Nothing here holds constraint notes.

-- Per-member switches; a missing row means every default (all on, 18:00 and 08:30).
CREATE TABLE public.duty_notification_settings (
    member_id uuid NOT NULL,
    deadlines boolean DEFAULT true NOT NULL,
    published boolean DEFAULT true NOT NULL,
    swaps boolean DEFAULT true NOT NULL,
    edits boolean DEFAULT true NOT NULL,
    evening boolean DEFAULT true NOT NULL,
    evening_time time without time zone DEFAULT '18:00:00'::time without time zone NOT NULL,
    morning boolean DEFAULT true NOT NULL,
    morning_time time without time zone DEFAULT '08:30:00'::time without time zone NOT NULL,
    members boolean DEFAULT true NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT duty_notification_settings_minutes_check CHECK (((EXTRACT(second FROM evening_time) = (0)::numeric) AND (EXTRACT(second FROM morning_time) = (0)::numeric)))
);

ALTER TABLE ONLY public.duty_notification_settings
    ADD CONSTRAINT duty_notification_settings_pkey PRIMARY KEY (member_id);

ALTER TABLE ONLY public.duty_notification_settings
    ADD CONSTRAINT duty_notification_settings_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.duty_members(id) ON DELETE CASCADE;

ALTER TABLE public.duty_notification_settings ENABLE ROW LEVEL SECURITY;

-- One row per device (browser push subscription). An endpoint belongs to whoever
-- registered it last; the push service's 404/410 deletes it.
CREATE TABLE public.duty_push_subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    member_id uuid NOT NULL,
    endpoint text NOT NULL,
    p256dh text NOT NULL,
    auth text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT duty_push_subscriptions_endpoint_check CHECK (((length(endpoint) >= 20) AND (length(endpoint) <= 1000) AND (endpoint ~ '^https://[^/?#@]+/'::text))),
    CONSTRAINT duty_push_subscriptions_p256dh_check CHECK ((p256dh ~ '^[A-Za-z0-9_-]{80,100}$'::text)),
    CONSTRAINT duty_push_subscriptions_auth_check CHECK ((auth ~ '^[A-Za-z0-9_-]{16,44}$'::text))
);

ALTER TABLE ONLY public.duty_push_subscriptions
    ADD CONSTRAINT duty_push_subscriptions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.duty_push_subscriptions
    ADD CONSTRAINT duty_push_subscriptions_endpoint_key UNIQUE (endpoint);

CREATE INDEX duty_push_subscriptions_member ON public.duty_push_subscriptions USING btree (member_id, last_seen_at DESC);

ALTER TABLE ONLY public.duty_push_subscriptions
    ADD CONSTRAINT duty_push_subscriptions_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.duty_members(id) ON DELETE CASCADE;

ALTER TABLE public.duty_push_subscriptions ENABLE ROW LEVEL SECURITY;

-- What was decided for whom: one row per member and event. The unique dedupe key
-- makes every trigger and scheduler run idempotent. Params hold only dates, the
-- month, a version number and (for admins) a joining member's name; the text is
-- written in the member's language when it is sent (lib/push/messages.ts).
CREATE TABLE public.duty_push_notifications (
    id bigint NOT NULL GENERATED ALWAYS AS IDENTITY,
    member_id uuid NOT NULL,
    kind text NOT NULL,
    dedupe_key text NOT NULL,
    params jsonb DEFAULT '{}'::jsonb NOT NULL,
    url text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_at timestamp with time zone,
    CONSTRAINT duty_push_notifications_kind_check CHECK ((kind = ANY (ARRAY['deadline_3'::text, 'deadline_1'::text, 'published'::text, 'republished'::text, 'edit'::text, 'swap_new'::text, 'swap_accepted'::text, 'swap_awaiting_admin'::text, 'swap_declined'::text, 'swap_rejected'::text, 'swap_approved'::text, 'remind_evening'::text, 'remind_morning'::text, 'member_waiting'::text, 'test'::text]))),
    CONSTRAINT duty_push_notifications_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'dispatched'::text, 'skipped'::text, 'expired'::text]))),
    CONSTRAINT duty_push_notifications_url_check CHECK ((url ~ '^/\?[a-z]+=[A-Za-z0-9=&_-]*$'::text)),
    CONSTRAINT duty_push_notifications_params_check CHECK (((jsonb_typeof(params) = 'object'::text) AND (length((params)::text) <= 500)))
);

ALTER TABLE ONLY public.duty_push_notifications
    ADD CONSTRAINT duty_push_notifications_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.duty_push_notifications
    ADD CONSTRAINT duty_push_notifications_dedupe_key_key UNIQUE (dedupe_key);

CREATE INDEX duty_push_notifications_member ON public.duty_push_notifications USING btree (member_id, created_at DESC);

CREATE INDEX duty_push_notifications_pending ON public.duty_push_notifications USING btree (created_at) WHERE (status = 'pending'::text);

ALTER TABLE ONLY public.duty_push_notifications
    ADD CONSTRAINT duty_push_notifications_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.duty_members(id) ON DELETE CASCADE;

ALTER TABLE public.duty_push_notifications ENABLE ROW LEVEL SECURITY;

-- One row per notification and device. 'sending' carries the pg_net request whose
-- response settles it. Only explicit refusals before any send are retried
-- ('failed'); a lost response is 'unknown' and never resent, so nothing repeats.
CREATE TABLE public.duty_push_deliveries (
    id bigint NOT NULL GENERATED ALWAYS AS IDENTITY,
    notification_id bigint NOT NULL,
    subscription_id uuid,
    status text DEFAULT 'queued'::text NOT NULL,
    request_id bigint,
    http_status integer,
    attempts integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT duty_push_deliveries_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'sending'::text, 'sent'::text, 'failed'::text, 'gone'::text, 'rejected'::text, 'unknown'::text, 'abandoned'::text])))
);

ALTER TABLE ONLY public.duty_push_deliveries
    ADD CONSTRAINT duty_push_deliveries_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.duty_push_deliveries
    ADD CONSTRAINT duty_push_deliveries_notification_subscription_key UNIQUE (notification_id, subscription_id);

CREATE INDEX duty_push_deliveries_open ON public.duty_push_deliveries USING btree (status, updated_at) WHERE (status = ANY (ARRAY['queued'::text, 'sending'::text, 'failed'::text]));

CREATE INDEX duty_push_deliveries_request ON public.duty_push_deliveries USING btree (request_id);

CREATE INDEX duty_push_deliveries_subscription ON public.duty_push_deliveries USING btree (subscription_id);

ALTER TABLE ONLY public.duty_push_deliveries
    ADD CONSTRAINT duty_push_deliveries_notification_id_fkey FOREIGN KEY (notification_id) REFERENCES public.duty_push_notifications(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.duty_push_deliveries
    ADD CONSTRAINT duty_push_deliveries_subscription_id_fkey FOREIGN KEY (subscription_id) REFERENCES public.duty_push_subscriptions(id) ON DELETE SET NULL;

ALTER TABLE public.duty_push_deliveries ENABLE ROW LEVEL SECURITY;

-- Source: schemas/functions/duty_private/push_events.sql
-- Records one notification for one member, once (the dedupe key), only when they
-- can receive it: a signed-in, approved, active member with a registered device who
-- has not switched that kind off. Returns whether a new row was recorded.
CREATE FUNCTION duty_private.push_enqueue(p_member uuid, p_kind text, p_key text, p_params jsonb, p_url text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare s public.duty_notification_settings; wanted boolean;
begin
 if p_member is null or not exists(select 1 from public.duty_members where id=p_member and auth_user_id is not null and status='approved' and active)
  or not exists(select 1 from public.duty_push_subscriptions where member_id=p_member) then return false; end if;
 select * into s from public.duty_notification_settings where member_id=p_member;
 wanted:=case
  when p_kind in ('deadline_3','deadline_1') then coalesce(s.deadlines,true)
  when p_kind in ('published','republished') then coalesce(s.published,true)
  when p_kind like 'swap\_%' then coalesce(s.swaps,true)
  when p_kind='edit' then coalesce(s.edits,true)
  when p_kind='remind_evening' then coalesce(s.evening,true)
  when p_kind='remind_morning' then coalesce(s.morning,true)
  when p_kind='member_waiting' then coalesce(s.members,true)
  when p_kind='test' then true
  else false end;
 if not wanted then return false; end if;
 insert into public.duty_push_notifications(member_id,kind,dedupe_key,params,url) values(p_member,p_kind,p_key,coalesce(p_params,'{}'::jsonb),p_url)
 on conflict(dedupe_key) do nothing;
 return found;
end $$;

-- Publishing a month tells everyone; a later change to a published month that is
-- not an approved swap (an admin's published-duty edit, or deleting the live
-- version) tells each member whose duty, cover or points changed. The member who
-- made the change is not told. A notification problem never blocks the change.
CREATE FUNCTION duty_private.push_month_events() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare actor uuid:=auth.uid(); today date:=(now() at time zone 'Asia/Jerusalem')::date; r record; v integer;
begin
 begin
  if old.status='draft' and new.status='published' then
   select p.version into v from public.duty_publications p where p.id=new.current_publication_id;
   for r in select id from public.duty_members where status='approved' and active and auth_user_id is not null and id is distinct from actor loop
    perform duty_private.push_enqueue(r.id,case when old.current_publication_id is null then 'published' else 'republished' end,
     'published:'||new.current_publication_id||':'||r.id,jsonb_build_object('month',new.month,'version',v),'/?tab=schedule&month='||new.month);
   end loop;
  -- A swap approved in this same transaction has its own notices (resolved_at is the
  -- transaction time); any other change of the live version (an admin's edit, deleting
  -- the live version) tells whoever's duty changed.
  elsif old.status='published' and new.status='published'
   and not exists(select 1 from public.duty_swap_requests s where s.result_publication_id=new.current_publication_id and s.status='approved' and s.resolved_at=now()) then
   for r in
    with o as (select day,end_day,primary_id,secondary_id,points from public.duty_assignments where publication_id=old.current_publication_id),
     n as (select day,end_day,primary_id,secondary_id,points from public.duty_assignments where publication_id=new.current_publication_id),
     d as (select coalesce(n.day,o.day) as day,o.primary_id as op,o.secondary_id as os,n.primary_id as np,n.secondary_id as ns,
       (o.points is distinct from n.points or o.end_day is distinct from n.end_day) as reshaped
      from o full join n on n.day=o.day where coalesce(n.day,o.day)>=today),
     affected as (
      select d.day,x.member from d cross join lateral (values (d.op),(d.np)) x(member) where d.op is distinct from d.np
      union select d.day,x.member from d cross join lateral (values (d.os),(d.ns)) x(member) where d.os is distinct from d.ns
      union select d.day,x.member from d cross join lateral (values (d.np),(d.ns)) x(member) where d.reshaped)
    select a.member,min(a.day) as first_day,count(distinct a.day) as days from affected a
    where a.member is not null and a.member is distinct from actor group by a.member
   loop
    perform duty_private.push_enqueue(r.member,'edit','edit:'||old.current_publication_id||':'||new.current_publication_id||':'||r.member,
     jsonb_build_object('month',new.month,'day',r.first_day,'count',r.days),'/?tab=schedule&month='||new.month);
   end loop;
  end if;
 exception when others then
  raise warning 'duty push (month %): %',new.month,sqlerrm;
 end;
 return null;
end $$;

-- Swap requests tell only the people involved: who must answer a new request, the
-- other parties when someone accepts, everyone involved when it is declined,
-- rejected or approved, and the admins when it waits for their approval. The
-- explanation text is never sent; only the two dates.
CREATE FUNCTION duty_private.push_swap_events() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare actor uuid:=auth.uid(); params jsonb; url text; who uuid; side text; answered uuid; round text;
begin
 begin
  params:=jsonb_build_object('month',new.month,'fromDay',new.from_day,'toDay',new.to_day,'request',new.id);
  -- Each round of a request gets its own keys: a new counterpart (this transaction's
  -- time) or a new acceptance (its timestamp), so a request asked again is told again.
  round:=to_char(now() at time zone 'UTC','YYYYMMDDHH24MISSUS');
  url:='/?tab=schedule&month='||new.month;
  if tg_op='INSERT' then
   if new.status='awaiting_engineer' then
    foreach who in array array[new.other_id,case when new.proposed_by is not null then new.requester_id end] loop
     if who is not null and who is distinct from actor then perform duty_private.push_enqueue(who,'swap_new','swap:'||new.id||':new:'||who,params,url); end if;
    end loop;
   end if;
  else
   -- The published duty changed hands while waiting: its new holder is asked, and the
   -- requester of an admin's proposal, who must accept again.
   if new.status='awaiting_engineer' and new.other_id is distinct from old.other_id then
    foreach who in array array[new.other_id,case when new.proposed_by is not null and new.requester_accepted_at is null then new.requester_id end] loop
     if who is not null and who is distinct from actor then perform duty_private.push_enqueue(who,'swap_new','swap:'||new.id||':new:'||round||':'||who,params,url); end if;
    end loop;
   end if;
   side:=case when new.accepted_by is not null and old.accepted_by is null then 'other'
    when new.requester_accepted_at is not null and old.requester_accepted_at is null then 'requester' end;
   if side is not null then
    answered:=case side when 'other' then new.other_id else new.requester_id end;
    foreach who in array array[new.requester_id,new.other_id,new.proposed_by] loop
     -- An admin asked to approve in the same step hears that instead.
     if who is not null and who is distinct from actor and who is distinct from answered
      and not (new.status='awaiting_admin' and old.status<>'awaiting_admin' and exists(select 1 from public.duty_members m join public.duty_roles r on r.code=m.role
       where m.id=who and r.can_manage and m.status='approved' and m.active)) then
      perform duty_private.push_enqueue(who,'swap_accepted','swap:'||new.id||':accepted-'||side||':'
       ||to_char(case side when 'other' then new.accepted_at else new.requester_accepted_at end at time zone 'UTC','YYYYMMDDHH24MISSUS')||':'||who,params,url);
     end if;
    end loop;
   end if;
   if new.status is distinct from old.status then
    if new.status='awaiting_admin' then
     for who in select m.id from public.duty_members m join public.duty_roles r on r.code=m.role
      where r.can_manage and m.status='approved' and m.active and m.id is distinct from actor loop
      perform duty_private.push_enqueue(who,'swap_awaiting_admin','swap:'||new.id||':admin:'||to_char(new.accepted_at at time zone 'UTC','YYYYMMDDHH24MISSUS')||':'||who,params,url);
     end loop;
    elsif new.status in ('declined','rejected','approved') then
     foreach who in array array[new.requester_id,new.other_id,new.proposed_by] loop
      if who is not null and who is distinct from actor then
       perform duty_private.push_enqueue(who,'swap_'||new.status,'swap:'||new.id||':'||new.status||':'||who,params,url);
      end if;
     end loop;
    end if;
   end if;
  end if;
 exception when others then
  raise warning 'duty push (swap %): %',new.id,sqlerrm;
 end;
 return null;
end $$;

-- A new sign-up waits for approval: every admin who wants to know is told.
CREATE FUNCTION duty_private.push_member_events() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare who uuid;
begin
 begin
  for who in select m.id from public.duty_members m join public.duty_roles r on r.code=m.role
   where r.can_manage and m.status='approved' and m.active loop
   perform duty_private.push_enqueue(who,'member_waiting','member:'||new.id||':'||who,jsonb_build_object('name',left(new.name,80)),'/?tab=team');
  end loop;
 exception when others then
  raise warning 'duty push (member %): %',new.id,sqlerrm;
 end;
 return null;
end $$;

-- Source: schemas/functions/duty_private/push_settings.sql
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
-- times are HH:MM in Asia/Jerusalem. No workspace revision: it is personal.
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
 if coalesce(p_settings->>'eveningTime','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or coalesce(p_settings->>'morningTime','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
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

-- Queues one test notification to the caller's own devices (at most one a minute).
CREATE FUNCTION duty_private.send_test_notification() RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
 if not duty_private.is_member() then raise exception 'Member access required' using errcode='42501'; end if;
 if not exists(select 1 from public.duty_push_subscriptions where member_id=auth.uid()) then raise exception 'push-no-device'; end if;
 return duty_private.push_enqueue(auth.uid(),'test','test:'||auth.uid()||':'||to_char(now() at time zone 'UTC','YYYYMMDDHH24MI'),'{}'::jsonb,'/?tab=schedule');
end $$;

-- Source: schemas/functions/duty_private/push_delivery.sql
-- Timed notifications in Asia/Jerusalem, recorded once each (dedupe keys):
-- * constraint deadline: from 10:00 three days before the deadline date, to everyone;
--   from 10:00 the day before, only to members with no constraints in that month.
--   Only for months not yet published.
-- * duty reminders: the evening before (default 18:00) and the morning of the duty
--   (default 08:30), for the primary engineer and emergency cover of the duties the
--   team sees (duty_private.current_duties: each date from its owning month). Each has a three-hour window, so a late run still reminds once.
CREATE FUNCTION duty_private.push_schedule(p_now timestamp with time zone) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare local timestamp:=p_now at time zone 'Asia/Jerusalem'; today date:=(p_now at time zone 'Asia/Jerusalem')::date; r record; added integer:=0;
begin
 for r in
  select m.month,m.deadline,w.kind,x.id as member from public.duty_months m
  cross join lateral (values ('deadline_3',(m.deadline-3)+time '10:00',(m.deadline-1)+time '10:00'),
   ('deadline_1',(m.deadline-1)+time '10:00',(m.deadline+1)::timestamp)) w(kind,fire,until)
  join public.duty_members x on x.status='approved' and x.active and x.auth_user_id is not null
  where m.status='draft' and m.current_publication_id is null and local>=w.fire and local<w.until
   and (w.kind='deadline_3' or not exists(select 1 from public.duty_constraints c where c.member_id=x.id
    and c.day>=to_date(m.month,'YYYY-MM') and c.day<(to_date(m.month,'YYYY-MM')+interval '1 month')))
 loop
  if duty_private.push_enqueue(r.member,r.kind,r.kind||':'||r.month||':'||r.deadline||':'||r.member,
   jsonb_build_object('month',r.month,'deadline',r.deadline),'/?tab=availability&month='||r.month) then added:=added+1; end if;
 end loop;
 for r in
  select a.day,a.end_day,p.member,p.role,k.kind from duty_private.current_duties() a
  cross join lateral (values (a.primary_id,'primary'),(a.secondary_id,'secondary')) p(member,role)
  left join public.duty_notification_settings s on s.member_id=p.member
  cross join lateral (values ('remind_evening',(a.day-1)+coalesce(s.evening_time,time '18:00')),
   ('remind_morning',a.day+coalesce(s.morning_time,time '08:30'))) k(kind,fire)
  where p.member is not null and a.day between today-1 and today+1 and local>=k.fire and local<k.fire+interval '3 hours'
 loop
  if duty_private.push_enqueue(r.member,r.kind,r.kind||':'||r.day||':'||r.role||':'||r.member,
   jsonb_build_object('day',r.day,'endDay',r.end_day,'role',r.role),'/?tab=schedule&month='||to_char(r.day,'YYYY-MM')) then added:=added+1; end if;
 end loop;
 return added;
end $$;

-- Settles one sender request from its pg_net response. The sender answers 200 with
-- an outcome per delivery after it has tried them; 401/404/503 mean it refused
-- before sending anything, so those are retried. Anything else, or a delivery the
-- answer does not mention, may have been sent and is never resent.
CREATE FUNCTION duty_private.push_settle(p_request bigint, p_status integer, p_content text, p_timed_out boolean) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare body jsonb; item jsonb;
begin
 if p_status=200 and not coalesce(p_timed_out,false) then
  begin body:=p_content::jsonb; exception when others then body:=null; end;
  for item in select value from jsonb_array_elements(case when jsonb_typeof(body->'results')='array' then body->'results' else '[]'::jsonb end) loop
   continue when jsonb_typeof(item)<>'object' or coalesce(item->>'id','') !~ '^[0-9]{1,18}$';
   update public.duty_push_deliveries set status=case item->>'outcome' when 'sent' then 'sent' when 'gone' then 'gone' when 'retry' then 'failed'
     when 'unknown' then 'unknown' else 'rejected' end,
    http_status=case when coalesce(item->>'status','') ~ '^[0-9]{1,3}$' then (item->>'status')::integer end,updated_at=now()
   where id=(item->>'id')::bigint and request_id=p_request and status='sending';
  end loop;
  update public.duty_push_notifications set sent_at=coalesce(sent_at,now())
  where id in (select notification_id from public.duty_push_deliveries where request_id=p_request and status='sent');
  -- The push service says this device is gone (404/410): forget it.
  delete from public.duty_push_subscriptions where id in (select subscription_id from public.duty_push_deliveries where request_id=p_request and status='gone');
  update public.duty_push_deliveries set status='unknown',updated_at=now() where request_id=p_request and status='sending';
 elsif not coalesce(p_timed_out,false) and p_status in (401,404,503) then
  update public.duty_push_deliveries set status='failed',http_status=p_status,updated_at=now() where request_id=p_request and status='sending';
 else
  update public.duty_push_deliveries set status='unknown',http_status=p_status,updated_at=now() where request_id=p_request and status='sending';
 end if;
end $$;

-- Reads finished pg_net responses (when pg_net is installed) and settles them.
-- A request with no response after ten minutes is 'unknown'; a refusal retried
-- three times, or a delivery whose device is gone or moved to another member, is abandoned.
CREATE FUNCTION duty_private.push_reconcile(p_now timestamp with time zone) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare request bigint; rid bigint; code integer; body text; timed boolean;
begin
 if to_regclass('net._http_response') is not null then
  for request in select distinct request_id from public.duty_push_deliveries where status='sending' and request_id is not null loop
   rid:=null;
   execute 'select id,status_code,content,timed_out from net._http_response where id=$1' into rid,code,body,timed using request;
   if rid is not null then perform duty_private.push_settle(request,code,body,timed); end if;
  end loop;
 end if;
 update public.duty_push_deliveries set status='unknown',updated_at=p_now where status='sending' and updated_at<p_now-interval '10 minutes';
 update public.duty_push_deliveries set status='abandoned',updated_at=p_now
 where (status='failed' and attempts>=3) or (status in ('queued','failed') and subscription_id is null);
 update public.duty_push_deliveries d set status='abandoned',updated_at=p_now from public.duty_push_subscriptions s,public.duty_push_notifications n
 where s.id=d.subscription_id and n.id=d.notification_id and s.member_id<>n.member_id and d.status in ('queued','failed');
end $$;

-- Sends what is due through the protected sender (Vault secrets duty_push_url and
-- duty_push_secret, optional duty_push_bypass for Vercel deployment protection), in
-- batches of 50 over pg_net. Without pg_net or that configuration nothing is sent.
-- Notifications still waiting after six hours expire instead of arriving late.
CREATE FUNCTION duty_private.push_dispatch(p_now timestamp with time zone) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare target text; secret text; bypass text; headers jsonb; batch jsonb; picked bigint[]; request bigint; requests integer:=0;
begin
 update public.duty_push_notifications set status='expired' where status='pending' and created_at<p_now-interval '6 hours';
 if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null or to_regclass('vault.decrypted_secrets') is null then return 0; end if;
 execute $sql$select max(decrypted_secret) filter (where name='duty_push_url'),max(decrypted_secret) filter (where name='duty_push_secret'),
  max(decrypted_secret) filter (where name='duty_push_bypass') from vault.decrypted_secrets where name in ('duty_push_url','duty_push_secret','duty_push_bypass')$sql$
  into target,secret,bypass;
 if secret is null or length(secret)<32 or target is null or (target !~ '^https://[^/?#@]+/' and target !~ '^http://(localhost|127\.0\.0\.1|host\.docker\.internal)(:[0-9]+)?/') then return 0; end if;
 insert into public.duty_push_deliveries(notification_id,subscription_id)
 select n.id,s.id from public.duty_push_notifications n join public.duty_push_subscriptions s on s.member_id=n.member_id where n.status='pending'
 on conflict do nothing;
 -- A swap ask or approval request that was answered, cancelled or invalidated before
 -- sending (for example by an admin's edit in the same step) is no longer sent.
 update public.duty_push_notifications n set status='skipped' where n.status='pending' and n.kind in ('swap_new','swap_awaiting_admin')
  and not exists(select 1 from public.duty_swap_requests r where r.id::text=n.params->>'request'
   and r.status=case n.kind when 'swap_new' then 'awaiting_engineer' else 'awaiting_admin' end
   and (n.kind='swap_awaiting_admin' or n.member_id=r.other_id or (n.member_id=r.requester_id and r.proposed_by is not null)));
 delete from public.duty_push_deliveries d using public.duty_push_notifications n where n.id=d.notification_id and n.status='skipped' and d.status='queued';
 update public.duty_push_notifications n set status=case when exists(select 1 from public.duty_push_deliveries d where d.notification_id=n.id) then 'dispatched' else 'skipped' end
 where n.status='pending';
 headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||secret)
  ||case when bypass is not null then jsonb_build_object('x-vercel-protection-bypass',bypass) else '{}'::jsonb end;
 for i in 1..10 loop
  picked:=null; batch:=null;
  with due as (
   select d.id from public.duty_push_deliveries d
   join public.duty_push_subscriptions s on s.id=d.subscription_id join public.duty_push_notifications n on n.id=d.notification_id
   -- A device that moved to another member (shared phone) never gets the earlier member's notifications.
   where s.member_id=n.member_id and (d.status='queued' or (d.status='failed' and d.attempts<3 and d.updated_at<=p_now-make_interval(mins=>(2^d.attempts)::integer)))
   order by d.id limit 50 for update of d skip locked)
  select array_agg(d.id order by d.id),jsonb_agg(jsonb_build_object('id',d.id::text,'endpoint',s.endpoint,'keys',jsonb_build_object('p256dh',s.p256dh,'auth',s.auth),
    'lang',coalesce(m.language,'en'),'kind',n.kind,'params',n.params,'url',n.url,'tag','duty-'||n.id) order by d.id)
  into picked,batch
  from due join public.duty_push_deliveries d on d.id=due.id join public.duty_push_subscriptions s on s.id=d.subscription_id
  join public.duty_push_notifications n on n.id=d.notification_id join public.duty_members m on m.id=n.member_id;
  exit when picked is null;
  request:=net.http_post(url:=target,body:=jsonb_build_object('messages',batch),params:='{}'::jsonb,headers:=headers,timeout_milliseconds:=25000);
  update public.duty_push_deliveries set status='sending',request_id=request,attempts=attempts+1,updated_at=p_now where id=any(picked);
  requests:=requests+1;
 end loop;
 return requests;
end $$;

-- The scheduler's single entry point (pg_cron, every minute; see
-- supabase/admin/push-scheduler.sql). Overlapping runs skip; keeps 90 days of log.
CREATE FUNCTION duty_private.push_tick() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare scheduled integer; requests integer;
begin
 if not pg_try_advisory_xact_lock(hashtext('duty_private.push_tick')) then return jsonb_build_object('skipped',true); end if;
 perform duty_private.push_reconcile(now());
 scheduled:=duty_private.push_schedule(now());
 requests:=duty_private.push_dispatch(now());
 delete from public.duty_push_notifications where created_at<now()-interval '90 days';
 return jsonb_build_object('scheduled',scheduled,'requests',requests);
end $$;

-- Source: schemas/functions/public/duty_push.sql
CREATE FUNCTION public.duty_set_language(p_language text) RETURNS void
    LANGUAGE sql
    SET search_path TO ''
    AS $$select duty_private.set_language(p_language)$$;

CREATE FUNCTION public.duty_notification_settings() RETURNS jsonb
    LANGUAGE sql
    SET search_path TO ''
    AS $$select duty_private.notification_settings()$$;

CREATE FUNCTION public.duty_set_notification_settings(p_settings jsonb) RETURNS jsonb
    LANGUAGE sql
    SET search_path TO ''
    AS $$select duty_private.set_notification_settings(p_settings)$$;

CREATE FUNCTION public.duty_save_push_subscription(p_endpoint text, p_p256dh text, p_auth text) RETURNS void
    LANGUAGE sql
    SET search_path TO ''
    AS $$select duty_private.save_push_subscription(p_endpoint,p_p256dh,p_auth)$$;

CREATE FUNCTION public.duty_delete_push_subscription(p_endpoint text) RETURNS void
    LANGUAGE sql
    SET search_path TO ''
    AS $$select duty_private.delete_push_subscription(p_endpoint)$$;

CREATE FUNCTION public.duty_send_test_notification() RETURNS boolean
    LANGUAGE sql
    SET search_path TO ''
    AS $$select duty_private.send_test_notification()$$;

-- Source: schemas/triggers/duty_push_events.sql
-- Event notifications, recorded in the same transaction as the change (a rolled-back
-- change notifies nobody). Sending happens later, from push_tick.
CREATE TRIGGER duty_push_month_events AFTER UPDATE OF status, current_publication_id ON public.duty_months FOR EACH ROW WHEN (((old.current_publication_id IS DISTINCT FROM new.current_publication_id) AND (new.current_publication_id IS NOT NULL))) EXECUTE FUNCTION duty_private.push_month_events();
CREATE TRIGGER duty_push_swap_events AFTER INSERT OR UPDATE OF status, other_id, accepted_by, requester_accepted_at ON public.duty_swap_requests FOR EACH ROW EXECUTE FUNCTION duty_private.push_swap_events();
CREATE TRIGGER duty_push_member_events AFTER INSERT ON public.duty_members FOR EACH ROW WHEN ((new.status = 'pending'::text)) EXECUTE FUNCTION duty_private.push_member_events();

-- Source: schemas/policies/duty_notifications.sql
-- Own rows only, for every member including admins.
CREATE POLICY notification_settings_read ON public.duty_notification_settings FOR SELECT TO authenticated USING ((member_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY push_subscriptions_read ON public.duty_push_subscriptions FOR SELECT TO authenticated USING ((member_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY push_notifications_read ON public.duty_push_notifications FOR SELECT TO authenticated USING ((member_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY push_deliveries_read ON public.duty_push_deliveries FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.duty_push_notifications n
  WHERE ((n.id = duty_push_deliveries.notification_id) AND (n.member_id = ( SELECT auth.uid() AS uid))))));

-- Source: schemas/grants/tables.sql
-- Web push: members read only their own rows (RLS); writes go through checked RPCs,
-- the event triggers and the scheduler.
REVOKE ALL ON TABLE public.duty_notification_settings FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.duty_notification_settings TO authenticated;
REVOKE ALL ON TABLE public.duty_push_subscriptions FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.duty_push_subscriptions TO authenticated;
REVOKE ALL ON TABLE public.duty_push_notifications FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.duty_push_notifications TO authenticated;
REVOKE ALL ON TABLE public.duty_push_deliveries FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.duty_push_deliveries TO authenticated;

-- Source: schemas/grants/functions.sql
REVOKE ALL ON FUNCTION duty_private.set_language(text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION duty_private.set_language(text) TO authenticated;
REVOKE ALL ON FUNCTION public.duty_set_language(text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.duty_set_language(text) TO authenticated;

REVOKE ALL ON FUNCTION duty_private.notification_settings() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION duty_private.notification_settings() TO authenticated;
REVOKE ALL ON FUNCTION public.duty_notification_settings() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.duty_notification_settings() TO authenticated;

REVOKE ALL ON FUNCTION duty_private.set_notification_settings(jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION duty_private.set_notification_settings(jsonb) TO authenticated;
REVOKE ALL ON FUNCTION public.duty_set_notification_settings(jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.duty_set_notification_settings(jsonb) TO authenticated;

REVOKE ALL ON FUNCTION duty_private.save_push_subscription(text, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION duty_private.save_push_subscription(text, text, text) TO authenticated;
REVOKE ALL ON FUNCTION public.duty_save_push_subscription(text, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.duty_save_push_subscription(text, text, text) TO authenticated;

REVOKE ALL ON FUNCTION duty_private.delete_push_subscription(text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION duty_private.delete_push_subscription(text) TO authenticated;
REVOKE ALL ON FUNCTION public.duty_delete_push_subscription(text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.duty_delete_push_subscription(text) TO authenticated;

REVOKE ALL ON FUNCTION duty_private.send_test_notification() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION duty_private.send_test_notification() TO authenticated;
REVOKE ALL ON FUNCTION public.duty_send_test_notification() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.duty_send_test_notification() TO authenticated;

-- Internal: triggers and the pg_cron scheduler (runs as the owner). No client access.
REVOKE ALL ON FUNCTION duty_private.push_enqueue(uuid, text, text, jsonb, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION duty_private.push_month_events() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION duty_private.push_swap_events() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION duty_private.push_member_events() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION duty_private.push_schedule(timestamp with time zone) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION duty_private.push_settle(bigint, integer, text, boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION duty_private.push_reconcile(timestamp with time zone) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION duty_private.push_dispatch(timestamp with time zone) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION duty_private.push_tick() FROM PUBLIC, anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
