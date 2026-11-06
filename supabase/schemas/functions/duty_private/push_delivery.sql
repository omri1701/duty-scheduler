-- Timed notifications in Asia/Jerusalem, recorded once each (dedupe keys):
-- * constraint deadline: from 10:00 three days before the deadline date, to everyone;
--   from 10:00 the day before, only to members with no constraints in that month.
--   Only for months not yet published.
-- * duty reminders: the evening before (default 18:00) and the morning of the duty
--   (default 08:30), for the primary engineer and emergency cover of the current
--   publication. Each has a three-hour window, so a late run still reminds once.
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
  select a.day,a.end_day,p.member,p.role,k.kind from public.duty_months m
  join public.duty_assignments a on a.publication_id=m.current_publication_id
  cross join lateral (values (a.primary_id,'primary'),(a.secondary_id,'secondary')) p(member,role)
  left join public.duty_notification_settings s on s.member_id=p.member
  cross join lateral (values ('remind_evening',(a.day-1)+coalesce(s.evening_time,time '18:00')),
   ('remind_morning',a.day+coalesce(s.morning_time,time '08:30'))) k(kind,fire)
  where p.member is not null and a.day between today and today+1 and local>=k.fire and local<k.fire+interval '3 hours'
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
-- three times, or a delivery whose device is gone, is abandoned.
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
 update public.duty_push_notifications n set status=case when exists(select 1 from public.duty_push_deliveries d where d.notification_id=n.id) then 'dispatched' else 'skipped' end
 where n.status='pending';
 headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||secret)
  ||case when bypass is not null then jsonb_build_object('x-vercel-protection-bypass',bypass) else '{}'::jsonb end;
 for i in 1..10 loop
  picked:=null; batch:=null;
  with due as (
   select d.id from public.duty_push_deliveries d
   where d.subscription_id is not null and (d.status='queued' or (d.status='failed' and d.attempts<3 and d.updated_at<=p_now-make_interval(mins=>(2^d.attempts)::integer)))
   order by d.id limit 50 for update skip locked)
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
