-- Synthetic fixtures only, on an empty disposable LOCAL database. Always rolls back.
-- Personal calendar feed (decision 2026-11-06): a member creates or resets only their own
-- token; only its hash is stored; the anonymous feed lookup returns only that member's own
-- current published duties in range, never others' duties, names, constraints or notes;
-- a reset token stops working; inactive, pending and unknown feeds return nothing.
begin;
do $$begin
 if exists(select 1 from auth.users) or exists(select 1 from public.duty_members) then raise exception 'Requires empty disposable LOCAL'; end if;
end$$;
-- Freeze only the clock in the installed lookup (today = 6 Nov 2026 in Israel); the rest is real.
do $$declare body text;begin
 select pg_get_functiondef('duty_private.calendar_feed(text)'::regprocedure) into body;
 if position('now()' in body)=0 then raise exception 'Clock injection no longer matches implementation'; end if;
 execute replace(body,'now()','''2026-11-06T12:00:00Z''::timestamptz');
end$$;
insert into auth.users(id,email,email_confirmed_at,is_anonymous) select
 ('76000000-0000-0000-0000-'||lpad(i::text,12,'0'))::uuid,'calendar-test-'||i||'@example.invalid',now(),false from generate_series(1,4) i;
-- 1 admin, 2 Alex, 3 Blair, 4 pending.
insert into public.duty_members(id,email,name,role,status,active) select id,email,'Fixture '||right(id::text,1),
 case when right(id::text,1)='1' then 'admin' else 'engineer' end,
 case when right(id::text,1)='4' then 'pending' else 'approved' end,true from auth.users;
insert into public.duty_constraints(member_id,day,kind,note) values('76000000-0000-0000-0000-000000000002','2026-11-20','no','Secret calendar note');
create function pg_temp.publish(p_month text, p_rows jsonb) returns uuid language plpgsql as $$
declare pub uuid;begin
 insert into public.duty_months(month,deadline,status) values(p_month,(p_month||'-01')::date-7,'published') on conflict (month) do nothing;
 update public.duty_months set publication_sequence=publication_sequence+1 where month=p_month;
 insert into public.duty_publications(month,version,published_by,published_at) select month,publication_sequence,'76000000-0000-0000-0000-000000000001','2026-10-30T08:00:00Z'
  from public.duty_months where month=p_month returning id into pub;
 insert into public.duty_assignments(publication_id,day,end_day,primary_id,secondary_id,title,extra_points)
  select pub,(r->>'day')::date,(r->>'end')::date,(r->>'primary')::uuid,(r->>'secondary')::uuid,coalesce(r->>'title',''),coalesce((r->>'extra')::numeric,0) from jsonb_array_elements(p_rows) r;
 update public.duty_months set current_publication_id=pub where month=p_month;
 return pub;
end$$;
-- An older November version gave Alex 10 Nov; the current one moved it to Blair (a swap).
select pg_temp.publish('2026-11','[{"day":"2026-11-10","end":"2026-11-11","primary":"76000000-0000-0000-0000-000000000002"}]');
select pg_temp.publish('2026-11','[
 {"day":"2026-11-02","end":"2026-11-03","primary":"76000000-0000-0000-0000-000000000002","title":"Holiday, coverage; \\ test","extra":2},
 {"day":"2026-11-03","end":"2026-11-04","primary":"76000000-0000-0000-0000-000000000003"},
 {"day":"2026-11-06","end":"2026-11-08","primary":"76000000-0000-0000-0000-000000000002"},
 {"day":"2026-11-10","end":"2026-11-11","primary":"76000000-0000-0000-0000-000000000003"},
 {"day":"2026-11-13","end":"2026-11-14","primary":"76000000-0000-0000-0000-000000000002"},
 {"day":"2026-11-14","end":"2026-11-15","primary":"76000000-0000-0000-0000-000000000003","secondary":"76000000-0000-0000-0000-000000000002"},
 {"day":"2026-11-16","end":"2026-11-17","primary":"76000000-0000-0000-0000-000000000001"}]');
-- Range: 92 days back (from 6 Aug) and 400 days ahead (before 11 Dec 2027).
select pg_temp.publish('2026-07','[{"day":"2026-07-01","end":"2026-07-02","primary":"76000000-0000-0000-0000-000000000002"}]');
select pg_temp.publish('2026-08','[{"day":"2026-08-10","end":"2026-08-11","primary":"76000000-0000-0000-0000-000000000002"}]');
select pg_temp.publish('2027-12','[{"day":"2027-12-20","end":"2027-12-21","primary":"76000000-0000-0000-0000-000000000002"}]');
-- December is an unpublished draft: working rows never reach a calendar.
insert into public.duty_months(month,deadline) values('2026-12','2026-11-24');
insert into public.duty_assignments(day,end_day,primary_id) values('2026-12-01','2026-12-02','76000000-0000-0000-0000-000000000002');
create function pg_temp.must_fail(command text, pattern text) returns void language plpgsql as $$begin
 begin execute command; exception when others then
  if sqlerrm !~ pattern then raise exception 'Unexpected refusal: %, expected %',sqlerrm,pattern;end if;return;
 end;raise exception 'Unexpected acceptance: %',command;
end$$;
grant execute on function pg_temp.must_fail(text,text) to anon, authenticated;
create temp table tokens(member text primary key, token text) on commit drop;
grant all on tokens to anon, authenticated;

-- The anonymous role reaches only the feed lookup: no table, no other RPC, no token writes.
set local role anon;
select pg_temp.must_fail($c$select public.duty_calendar_reset('en')$c$,'permission denied');
select pg_temp.must_fail($c$select public.duty_calendar_status()$c$,'permission denied');
select pg_temp.must_fail($c$select public.duty_calendar_language('en')$c$,'permission denied');
select pg_temp.must_fail($c$select duty_private.calendar_reset('en')$c$,'permission denied');
select pg_temp.must_fail($c$select public.duty_load()$c$,'permission denied');
select pg_temp.must_fail($c$select duty_private.current_duties()$c$,'permission denied');
select pg_temp.must_fail($c$select duty_private.is_member()$c$,'permission denied');
select pg_temp.must_fail($c$select * from public.duty_calendar_feeds$c$,'permission denied');
select pg_temp.must_fail($c$select * from public.duty_assignments$c$,'permission denied');
do $$begin
 if public.duty_calendar_feed(repeat('0',64)) is not null or public.duty_calendar_feed('') is not null or public.duty_calendar_feed(null) is not null then raise exception 'Unknown token returned a feed'; end if;
end$$;
reset role;

set local role authenticated;
-- A pending member has no feed and cannot make one.
set local request.jwt.claim.sub='76000000-0000-0000-0000-000000000004';
select pg_temp.must_fail($c$select public.duty_calendar_reset('en')$c$,'calendar-member-required');
select pg_temp.must_fail($c$select public.duty_calendar_language('en')$c$,'calendar-member-required');
do $$begin if public.duty_calendar_status() is not null then raise exception 'Pending member status'; end if; end$$;
-- Alex creates their own feed. Status never returns the token or its hash.
set local request.jwt.claim.sub='76000000-0000-0000-0000-000000000002';
do $$begin if public.duty_calendar_status() is not null then raise exception 'Feed before creation'; end if; end$$;
select pg_temp.must_fail($c$select public.duty_calendar_reset('fr')$c$,'invalid-calendar-language');
select pg_temp.must_fail($c$select public.duty_calendar_reset(null)$c$,'invalid-calendar-language');
insert into tokens select 'alex',public.duty_calendar_reset('he')->>'token';
do $$declare s jsonb:=public.duty_calendar_status();begin
 if (select token from tokens where member='alex') !~ '^[0-9a-f]{64}$' then raise exception 'Weak token'; end if;
 if s->>'language'<>'he' or s->>'createdAt' is null or s ? 'token' or s::text ~ 'hash' then raise exception 'Status: %',s; end if;
end$$;
-- Direct writes stay denied, also for one's own row.
select pg_temp.must_fail($c$insert into public.duty_calendar_feeds(member_id,token_hash) values('76000000-0000-0000-0000-000000000002',sha256('x'))$c$,'permission denied');
select pg_temp.must_fail($c$update public.duty_calendar_feeds set language='en'$c$,'permission denied');
select pg_temp.must_fail($c$delete from public.duty_calendar_feeds$c$,'permission denied');
set local request.jwt.claim.sub='76000000-0000-0000-0000-000000000003';
insert into tokens select 'blair',public.duty_calendar_reset('en')->>'token';
set local request.jwt.claim.sub='76000000-0000-0000-0000-000000000001';
insert into tokens select 'admin',public.duty_calendar_reset('en')->>'token';
-- Each member reads only their own row; even an admin sees no one else's.
do $$begin
 if (select count(*) from public.duty_calendar_feeds)<>1 or (select member_id from public.duty_calendar_feeds)<>'76000000-0000-0000-0000-000000000001' then raise exception 'Admin reads other feeds'; end if;
end$$;
set local request.jwt.claim.sub='76000000-0000-0000-0000-000000000002';
do $$begin
 if (select count(*) from public.duty_calendar_feeds)<>1 then raise exception 'Member reads other feeds'; end if;
end$$;
reset role;
do $$begin
 if (select count(*) from public.duty_calendar_feeds)<>3 then raise exception 'Expected three feeds'; end if;
 if (select count(*) from public.duty_calendar_feeds f join tokens t on f.token_hash=sha256(convert_to(t.token,'UTF8')))<>3 then raise exception 'Stored value is not the token hash'; end if;
 if exists(select 1 from public.duty_calendar_feeds f join tokens t on position(convert_to(t.token,'UTF8') in f.token_hash)>0) then raise exception 'Raw token stored'; end if;
end$$;

-- The anonymous feed: Alex's own current published duties in range, primary or emergency.
set local role anon;
do $$declare f jsonb:=public.duty_calendar_feed((select token from tokens where member='alex'));
 days text;begin
 select string_agg((d->>'day')||':'||(d->>'role')||':'||coalesce(d->>'points','-'),',' order by d->>'day') into days from jsonb_array_elements(f->'duties') d;
 if days is distinct from '2026-08-10:primary:1,2026-11-02:primary:3,2026-11-06:primary:1,2026-11-13:primary:0.5,2026-11-14:emergency:-' then raise exception 'Alex feed: %',days; end if;
 if f->>'language'<>'he' or f->>'key' !~ '^[0-9a-f]{20}$' then raise exception 'Feed header: %',f; end if;
 if (select d->>'endDay' from jsonb_array_elements(f->'duties') d where d->>'day'='2026-11-06')<>'2026-11-08'
  or (select d->>'title' from jsonb_array_elements(f->'duties') d where d->>'day'='2026-11-02')<>'Holiday, coverage; \ test' then raise exception 'Duty shape: %',f; end if;
 -- Nothing else about the team or the member: no IDs, names, emails, constraints or notes.
 if f::text ~ '7600000|Fixture|example\.invalid|Secret|note|2026-11-20|2026-12-0|2026-07|2027-12' then raise exception 'Feed leaks: %',f; end if;
 if (select count(*) from jsonb_object_keys(f))<>3 or exists(select 1 from jsonb_array_elements(f->'duties') d, jsonb_object_keys(d) k where k not in ('day','endDay','role','title','points','publishedAt')) then raise exception 'Unexpected fields: %',f; end if;
end$$;
do $$declare f jsonb:=public.duty_calendar_feed((select token from tokens where member='blair'));begin
 if (select string_agg(d->>'day'||':'||(d->>'role'),',' order by d->>'day') from jsonb_array_elements(f->'duties') d)<>'2026-11-03:primary,2026-11-10:primary,2026-11-14:primary' or f->>'language'<>'en' then raise exception 'Blair feed: %',f; end if;
 if f->>'key'=public.duty_calendar_feed((select token from tokens where member='alex'))->>'key' then raise exception 'Keys must differ per member'; end if;
end$$;
-- An admin's feed has only the admin's own duties too.
do $$declare f jsonb:=public.duty_calendar_feed((select token from tokens where member='admin'));begin
 if (select string_agg(d->>'day',',') from jsonb_array_elements(f->'duties') d)<>'2026-11-16' then raise exception 'Admin feed: %',f; end if;
end$$;
-- The hash itself, a different case or a truncated token opens nothing.
do $$declare t text:=(select token from tokens where member='alex');begin
 if public.duty_calendar_feed(encode(sha256(convert_to(t,'UTF8')),'hex')) is not null or public.duty_calendar_feed(upper(t)) is not null
  or public.duty_calendar_feed(left(t,63)) is not null or public.duty_calendar_feed(t||' ') is not null then raise exception 'Variant token accepted'; end if;
end$$;
reset role;

-- Reset: the old URL stops working at once, the new one works, the event key stays.
create temp table before_reset as select public.duty_calendar_feed(token)->>'key' as key, token from tokens where member='alex';
grant select on before_reset to anon;
set local role authenticated;
set local request.jwt.claim.sub='76000000-0000-0000-0000-000000000002';
update tokens set token=public.duty_calendar_reset('he')->>'token' where member='alex';
select public.duty_calendar_language('en');
reset role;
set local role anon;
do $$begin
 if public.duty_calendar_feed((select token from before_reset)) is not null then raise exception 'Reset token still works'; end if;
 if public.duty_calendar_feed((select token from tokens where member='alex'))->>'key'<>(select key from before_reset) then raise exception 'Event key changed on reset'; end if;
 if public.duty_calendar_feed((select token from tokens where member='alex'))->>'language'<>'en' then raise exception 'Language not updated'; end if;
end$$;
reset role;

-- A swap that republishes November updates the feed: 13 Nov moves to Blair.
select pg_temp.publish('2026-11','[{"day":"2026-11-02","end":"2026-11-03","primary":"76000000-0000-0000-0000-000000000002"},
 {"day":"2026-11-13","end":"2026-11-14","primary":"76000000-0000-0000-0000-000000000003"}]');
set local role anon;
do $$declare f jsonb:=public.duty_calendar_feed((select token from tokens where member='alex'));begin
 if (select string_agg(d->>'day',',' order by d->>'day') from jsonb_array_elements(f->'duties') d)<>'2026-08-10,2026-11-02' then raise exception 'After swap: %',f; end if;
end$$;
reset role;

-- Inactive or declined members get nothing; reactivation restores the same URL.
update public.duty_members set active=false where id='76000000-0000-0000-0000-000000000002';
set local role anon;
do $$begin if public.duty_calendar_feed((select token from tokens where member='alex')) is not null then raise exception 'Inactive member feed'; end if; end$$;
reset role;
update public.duty_members set active=true where id='76000000-0000-0000-0000-000000000002';
update public.duty_members set status='rejected' where id='76000000-0000-0000-0000-000000000003';
set local role anon;
do $$begin
 if public.duty_calendar_feed((select token from tokens where member='alex')) is null then raise exception 'Reactivated member feed'; end if;
 if public.duty_calendar_feed((select token from tokens where member='blair')) is not null then raise exception 'Declined member feed'; end if;
end$$;
reset role;
rollback;
