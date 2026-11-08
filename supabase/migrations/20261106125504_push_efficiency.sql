-- Web push efficiency (decision 2026-11-06): the clock runs every 15 minutes, so reminder
-- times are quarter hours; event alerts are handed to pg_net at commit instead of waiting
-- for the clock; an idle run reads no secret and makes no HTTP request; the clock keeps
-- 7 days of its pg_cron history. Stored off-step times move down to their quarter hour.
UPDATE public.duty_notification_settings
   SET evening_time=make_time(extract(hour FROM evening_time)::integer,(extract(minute FROM evening_time)::integer/15)*15,0),
       morning_time=make_time(extract(hour FROM morning_time)::integer,(extract(minute FROM morning_time)::integer/15)*15,0)
 WHERE extract(minute FROM evening_time)::integer%15<>0 OR extract(minute FROM morning_time)::integer%15<>0;
ALTER TABLE public.duty_notification_settings DROP CONSTRAINT duty_notification_settings_minutes_check;
ALTER TABLE public.duty_notification_settings ADD CONSTRAINT duty_notification_settings_minutes_check CHECK (((EXTRACT(second FROM evening_time) = (0)::numeric) AND (EXTRACT(second FROM morning_time) = (0)::numeric) AND ((EXTRACT(minute FROM evening_time))::integer % 15 = 0) AND ((EXTRACT(minute FROM morning_time))::integer % 15 = 0)));

CREATE OR REPLACE FUNCTION duty_private.set_notification_settings(p_settings jsonb) RETURNS jsonb
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


CREATE OR REPLACE FUNCTION duty_private.push_dispatch(p_now timestamp with time zone) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare target text; secret text; bypass text; headers jsonb; batch jsonb; picked bigint[]; request bigint; requests integer:=0;
begin
 update public.duty_push_notifications set status='expired' where status='pending' and created_at<p_now-interval '6 hours';
 if not exists(select 1 from public.duty_push_notifications where status='pending')
  and not exists(select 1 from public.duty_push_deliveries where status='queued' or (status='failed' and attempts<3 and updated_at<=p_now-make_interval(mins=>(2^attempts)::integer))) then
  return 0;
 end if;
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


CREATE OR REPLACE FUNCTION duty_private.push_tick() RETURNS jsonb
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
 if to_regclass('cron.job_run_details') is not null then
  begin
   execute $q$delete from cron.job_run_details where end_time<now()-interval '7 days' and jobid in (select jobid from cron.job where jobname='duty-push-tick')$q$;
  exception when others then
   raise warning 'duty push (cron history): %',sqlerrm;
  end;
 end if;
 return jsonb_build_object('scheduled',scheduled,'requests',requests);
end $$;


CREATE FUNCTION duty_private.push_dispatch_now() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
 if current_setting('duty.push_dispatched',true) is distinct from 'on' then
  perform set_config('duty.push_dispatched','on',true);
  begin
   -- One sender at a time: the clock's run holds the same lock.
   perform pg_advisory_xact_lock(hashtext('duty_private.push_tick'));
   perform duty_private.push_dispatch(now());
  exception when others then
   raise warning 'duty push (dispatch): %',sqlerrm;
  end;
 end if;
 return null;
end $$;


REVOKE ALL ON FUNCTION duty_private.push_dispatch_now() FROM PUBLIC, anon, authenticated, service_role;

CREATE CONSTRAINT TRIGGER duty_push_dispatch_now AFTER INSERT ON public.duty_push_notifications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.kind <> ALL (ARRAY['deadline_3'::text, 'deadline_1'::text, 'remind_evening'::text, 'remind_morning'::text]))) EXECUTE FUNCTION duty_private.push_dispatch_now();

NOTIFY pgrst, 'reload schema';
