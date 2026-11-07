-- Empty disposable LOCAL only. Synthetic fixtures; always rolls back.
-- Split a published weekend (decision 2026-11-07): admin only, revision/publication checks;
-- split Temporary (the holder owes the taker that half), split Permanent (no debt), per-day
-- points saved as typed, changing a half, joining back (Temporary reverses the debt, Permanent
-- undoes it through H1, never booked twice), the same person stays one weekend, a swap of one
-- half counts the weekend once and joins it, and every net adds up to zero.
\set ON_ERROR_STOP on
begin;
do $$begin
 if exists(select 1 from auth.users) or exists(select 1 from public.duty_members) or exists(select 1 from public.duty_compensation_events) then raise exception 'Requires empty disposable LOCAL';end if;
end$$;
create function pg_temp.denied(statement text, message text) returns void language plpgsql as $$
begin
 begin execute statement;
 exception when others then if sqlerrm !~ message then raise;end if;return;end;
 raise exception 'Unexpected success: %',statement;
end$$;
-- 1 admin, 2 Avi, 3 Dana, 4 Eli, 5 approved but inactive.
insert into auth.users(id,email) select ('63000000-0000-0000-0000-'||lpad(i::text,12,'0'))::uuid,'split-'||i||'@example.invalid' from generate_series(1,5) i;
insert into public.duty_members(id,email,name,role,status,active)
select id,email,'Synthetic '||right(id::text,1),case when right(id::text,1)='1' then 'admin' else 'engineer' end,'approved',right(id::text,1)<>'5' from auth.users;
insert into public.duty_constraints(member_id,day,kind,note) values('63000000-0000-0000-0000-000000000003','2099-01-24','no','PRIVATE-SPLIT-NOTE');
create function pg_temp.id(n int) returns uuid language sql as $$select ('63000000-0000-0000-0000-00000000000'||n)::uuid$$;
create function pg_temp.as_member(n int) returns void language sql as $$select set_config('request.jwt.claim.sub',pg_temp.id(n)::text,true)$$;
create function pg_temp.rev() returns bigint language sql security definer as $$select revision from public.duty_workspace where id$$;
create function pg_temp.pub() returns uuid language sql security definer as $$select current_publication_id from public.duty_months where month='2099-01'$$;
-- The current version's rows of one weekend: day, end, primary digit, points, cover digit.
create function pg_temp.weekend(p_friday date) returns text language sql security definer as $$
 select string_agg(a.day||'/'||(a.end_day-a.day)||'/'||right(a.primary_id::text,1)||'/'||a.points||coalesce('/c'||right(a.secondary_id::text,1),''),' ' order by a.day)
 from public.duty_assignments a where a.publication_id=pg_temp.pub() and a.day in (p_friday,p_friday+1)$$;
create function pg_temp.row_id(p_day date) returns uuid language sql security definer as $$select id from public.duty_assignments where publication_id=pg_temp.pub() and day=p_day$$;
create function pg_temp.claims() returns bigint language sql security definer as $$select jsonb_array_length(coalesce(duty_private.compensation_state()->'claims','[]'))$$;
create function pg_temp.net(n int) returns bigint language plpgsql as $$
begin perform pg_temp.as_member(1);return coalesce((public.duty_balance()->'net'->>pg_temp.id(n)::text)::bigint,0);end$$;
-- Every net adds up to zero, and Avi, Dana and Eli have exactly these.
create function pg_temp.nets(avi bigint, dana bigint, eli bigint, label text) returns void language plpgsql as $$
declare total bigint;begin
 perform pg_temp.as_member(1);
 select coalesce(sum(value::bigint),0) into total from jsonb_each_text(public.duty_balance()->'net');
 if total<>0 or pg_temp.net(2)<>avi or pg_temp.net(3)<>dana or pg_temp.net(4)<>eli then
  raise exception '%: nets % (sum %), expected Avi % Dana % Eli %',label,public.duty_balance()->'net',total,avi,dana,eli;end if;
end$$;
create function pg_temp.split(p_friday date, fri int, fri_extra numeric, sat int, sat_extra numeric, p_kind text, p_reason text default '') returns jsonb language plpgsql as $$
begin perform pg_temp.as_member(1);return public.duty_edit_published_weekend(pg_temp.pub(),p_friday,pg_temp.id(fri),fri_extra,pg_temp.id(sat),sat_extra,p_kind,pg_temp.rev(),p_reason);end$$;
create function pg_temp.returns(p_day date) returns jsonb language plpgsql as $$
begin perform pg_temp.as_member(1);return (select coalesce(jsonb_agg(right(v,1) order by n),'[]') from jsonb_array_elements_text(public.duty_edit_returns(pg_temp.pub(),p_day)) with ordinality o(v,n));end$$;
create function pg_temp.schedule(p_month text) returns jsonb language sql security definer as $$
 select jsonb_build_object('team','[]'::jsonb,'months',jsonb_build_object(p_month,jsonb_build_object('deadline',(p_month||'-01')::date-8,'status','draft','generated',true)),
 'duties',coalesce((select jsonb_agg(to_jsonb(a) order by day) from public.duty_assignments a where publication_id is null and duty_private.duty_owner(a.day)=p_month),'[]'::jsonb));
$$;
grant execute on function pg_temp.id(int),pg_temp.as_member(int),pg_temp.rev(),pg_temp.pub(),pg_temp.weekend(date),pg_temp.row_id(date),pg_temp.claims(),pg_temp.net(int),
 pg_temp.nets(bigint,bigint,bigint,text),pg_temp.split(date,int,numeric,int,numeric,text,text),pg_temp.returns(date),pg_temp.schedule(text) to authenticated;
-- January 2099: Avi on every duty; Fridays 2, 9, 16, 23, 30 are combined weekends. Eli covers the 30th.
insert into public.duty_months(month,deadline) values('2099-01','2098-12-24');
insert into public.duty_assignments(day,end_day,primary_id,secondary_id)
select d::date,d::date+case when extract(dow from d)=5 then 2 else 1 end,pg_temp.id(2),case when d::date='2099-01-30' then pg_temp.id(4) end
from generate_series('2099-01-01'::date,'2099-01-31'::date,interval '1 day') d where extract(dow from d)<>6 and duty_private.duty_owner(d::date)='2099-01';
set local role authenticated;
do $$begin
 perform pg_temp.as_member(1);
 perform public.duty_save_schedule(pg_temp.schedule('2099-01'),pg_temp.rev(),'2099-01');
end$$;

-- Only admins; anon has no access at all.
do $$declare pub uuid:=pg_temp.pub();begin
 perform pg_temp.as_member(2);
 perform pg_temp.denied(format('select public.duty_edit_published_weekend(%L,%L,%L,0,%L,0,%L,%s)',pub,'2099-01-02',pg_temp.id(2),pg_temp.id(3),'temporary',pg_temp.rev()),'Admin access required');
 perform pg_temp.denied(format('select duty_private.edit_published_weekend(%L,%L,%L,0,%L,0,%L,%s)',pub,'2099-01-02',pg_temp.id(2),pg_temp.id(3),'temporary',pg_temp.rev()),'Admin access required');
end$$;
reset role;set local role anon;
do $$begin perform pg_temp.denied('select public.duty_edit_published_weekend(gen_random_uuid(),''2099-01-02'',gen_random_uuid(),0,gen_random_uuid(),0,''temporary'',0)','permission denied');end$$;
reset role;
do $$begin
 if has_function_privilege('authenticated','duty_private.join_weekend_halves(uuid,date)','EXECUTE') or has_function_privilege('anon','duty_private.join_weekend_halves(uuid,date)','EXECUTE')
  or has_function_privilege('service_role','duty_private.join_weekend_halves(uuid,date)','EXECUTE') then raise exception 'join_weekend_halves is client-callable';end if;
 -- Never on a published version, even for its owner.
 perform pg_temp.denied(format('select duty_private.join_weekend_halves(%L,%L)',pg_temp.pub(),'2099-01-02'),'immutable');
end$$;
set local role authenticated;

-- Revision and publication checks and validation; a refused edit writes nothing.
do $$declare pub uuid:=pg_temp.pub();rev bigint:=pg_temp.rev();begin
 perform pg_temp.as_member(1);
 perform pg_temp.denied(format('select public.duty_edit_published_weekend(%L,%L,%L,0,%L,0,%L,%s)',pub,'2099-01-02',pg_temp.id(2),pg_temp.id(3),'temporary',rev-1),'team data changed');
 perform pg_temp.denied(format('select public.duty_edit_published_weekend(%L,%L,%L,0,%L,0,%L,%s)',gen_random_uuid(),'2099-01-02',pg_temp.id(2),pg_temp.id(3),'temporary',rev),'publication changed');
 perform pg_temp.denied('select pg_temp.split(''2099-01-02'',2,0,3,0,''forever'')','Temporary or Permanent');
 perform pg_temp.denied('select pg_temp.split(''2099-01-03'',2,0,3,0,''temporary'')','weekend in this published month');
 perform pg_temp.denied('select pg_temp.split(''2099-01-06'',2,0,3,0,''temporary'')','weekend in this published month');
 perform pg_temp.denied('select pg_temp.split(''2099-01-02'',2,0,2,0,''temporary'')','Nothing changed');
 perform pg_temp.denied('select pg_temp.split(''2099-01-02'',2,0,5,0,''temporary'')','active approved engineer');
 perform pg_temp.denied('select pg_temp.split(''2099-01-02'',2,0.3,3,0,''temporary'')','half points');
 perform pg_temp.denied('select pg_temp.split(''2099-01-02'',2,0,3,20.5,''temporary'')','half points');
 perform pg_temp.denied('select pg_temp.split(''2099-01-23'',2,0,3,0,''temporary'')','Availability conflict');
 perform pg_temp.denied('select pg_temp.split(''2099-01-23'',2,0,3,0,''temporary'',''  '')','Availability conflict');
 -- Eli covers the 30th: he can't also take its Saturday.
 perform pg_temp.denied('select pg_temp.split(''2099-01-30'',2,0,4,0,''temporary'')','emergency cover');
 if pg_temp.rev()<>rev or pg_temp.pub()<>pub or pg_temp.claims()>0 then raise exception 'A refused edit wrote data';end if;
end$$;
reset role;
update public.duty_months set status='draft' where month='2099-01';
set local role authenticated;
do $$begin perform pg_temp.denied('select pg_temp.split(''2099-01-02'',2,0,3,0,''temporary'')','open draft');end$$;
reset role;
update public.duty_months set status='published' where month='2099-01';
set local role authenticated;

-- 1. Split Temporary: Avi keeps Friday, Dana takes Saturday; Avi owes Dana Saturday's half point.
do $$declare old_pub uuid:=pg_temp.pub();result jsonb;begin
 result:=pg_temp.split('2099-01-02',2,0,3,0,'temporary');
 if (result->>'joined')::boolean or (result->>'version')::int<>2 or result->>'publication'<>pg_temp.pub()::text then raise exception 'Split result %',result;end if;
 if pg_temp.weekend('2099-01-02')<>'2099-01-02/1/2/0.5 2099-01-03/1/3/0.5' then raise exception 'Split rows %',pg_temp.weekend('2099-01-02');end if;
 if (select end_day from public.duty_assignments where publication_id=old_pub and day='2099-01-02')<>'2099-01-04' then raise exception 'Published history changed';end if;
 perform pg_temp.nets(-1,1,0,'split Temporary');
 if pg_temp.returns('2099-01-03')<>'["2"]' or pg_temp.returns('2099-01-02')<>'[]' then raise exception 'Returns after split % %',pg_temp.returns('2099-01-03'),pg_temp.returns('2099-01-02');end if;
end$$;

-- 2. Per-day points, saved exactly as typed: Friday 1 point for Avi, Saturday 0.5 to Eli.
do $$begin
 perform pg_temp.split('2099-01-09',2,0.5,4,0,'temporary');
 if pg_temp.weekend('2099-01-09')<>'2099-01-09/1/2/1.0 2099-01-10/1/4/0.5' then raise exception 'Per-day points %',pg_temp.weekend('2099-01-09');end if;
 perform pg_temp.nets(-2,1,1,'per-day points');
 -- Points alone on a split half: no debt, the extra counts for whoever does it.
 perform pg_temp.split('2099-01-09',2,0.5,4,1,'temporary');
 if pg_temp.weekend('2099-01-09')<>'2099-01-09/1/2/1.0 2099-01-10/1/4/1.5' then raise exception 'Half points edit %',pg_temp.weekend('2099-01-09');end if;
 perform pg_temp.nets(-2,1,1,'half points edit');
end$$;

-- 3. Changing a half: Saturday Dana → Eli chains (Avi owes Eli, Dana is square).
do $$begin
 perform pg_temp.split('2099-01-02',2,0,4,0,'temporary');
 if pg_temp.weekend('2099-01-02')<>'2099-01-02/1/2/0.5 2099-01-03/1/4/0.5' then raise exception 'Changed half %',pg_temp.weekend('2099-01-02');end if;
 perform pg_temp.nets(-2,0,2,'changed half');
 if pg_temp.returns('2099-01-03')<>'["3","2"]' then raise exception 'Returns after change %',pg_temp.returns('2099-01-03');end if;
end$$;

-- 4. Join back Temporary (keep Avi): one Friday–Sunday duty again, the half's debt reversed once.
do $$declare result jsonb;begin
 result:=pg_temp.split('2099-01-02',2,0,2,0,'temporary');
 if not (result->>'joined')::boolean or pg_temp.weekend('2099-01-02')<>'2099-01-02/2/2/1' then raise exception 'Join %',pg_temp.weekend('2099-01-02');end if;
 perform pg_temp.nets(-1,0,1,'join back Temporary');
end$$;

-- 5. Split Permanent: Dana takes Friday for good, no debt; joining back Permanent (no
--    Temporary change to undo) is also no debt.
do $$begin
 perform pg_temp.split('2099-01-16',3,0,2,0,'permanent');
 if pg_temp.weekend('2099-01-16')<>'2099-01-16/1/3/0.5 2099-01-17/1/2/0.5' then raise exception 'Permanent split %',pg_temp.weekend('2099-01-16');end if;
 perform pg_temp.nets(-1,0,1,'split Permanent');
 perform pg_temp.split('2099-01-16',3,0,3,0,'permanent');
 if pg_temp.weekend('2099-01-16')<>'2099-01-16/2/3/1' then raise exception 'Permanent join %',pg_temp.weekend('2099-01-16');end if;
 perform pg_temp.nets(-1,0,1,'join back Permanent');
end$$;

-- 6. H1: a Temporary split given back Permanent is that change's undo: the debt cancels.
do $$begin
 perform pg_temp.split('2099-01-23',2,0,4,0,'temporary');
 perform pg_temp.nets(-2,0,2,'split before H1');
 if pg_temp.returns('2099-01-24')<>'["2"]' then raise exception 'H1 returns %',pg_temp.returns('2099-01-24');end if;
 perform pg_temp.split('2099-01-23',2,0,2,0,'permanent');
 if pg_temp.weekend('2099-01-23')<>'2099-01-23/2/2/1' then raise exception 'H1 join %',pg_temp.weekend('2099-01-23');end if;
 perform pg_temp.nets(-1,0,1,'H1 undo');
end$$;

-- 7. The same person on both days stays one weekend, each date's points as typed; cover kept.
do $$declare result jsonb;begin
 result:=pg_temp.split('2099-01-30',2,0,2,1,'temporary');
 if not (result->>'joined')::boolean or pg_temp.weekend('2099-01-30')<>'2099-01-30/2/2/2/c4' then raise exception 'Same person %',pg_temp.weekend('2099-01-30');end if;
 perform pg_temp.nets(-1,0,1,'same person');
end$$;

-- 8. Swap one half: Eli trades the 10th (Saturday half) for Avi's Tuesday the 13th. Avi already
--    has the 9th, so the weekend counts once (no "second weekend"), and the halves join.
do $$declare request uuid;begin
 perform pg_temp.as_member(4);
 perform public.duty_request_swap(pg_temp.row_id('2099-01-10'),pg_temp.row_id('2099-01-13'),'',pg_temp.rev());
 select id into request from public.duty_swap_requests where status='awaiting_engineer';
 perform pg_temp.as_member(2);
 perform public.duty_resolve_swap(request,'accept',pg_temp.rev(),'');
 perform pg_temp.as_member(1);
 perform public.duty_resolve_swap(request,'approve',pg_temp.rev(),'');
 if pg_temp.weekend('2099-01-09')<>'2099-01-09/2/2/2.5' or (select right(primary_id::text,1) from public.duty_assignments where publication_id=pg_temp.pub() and day='2099-01-13')<>'4' then
  raise exception 'Swap of a half %',pg_temp.weekend('2099-01-09');end if;
 if exists(select 1 from public.duty_allocations where publication_id=pg_temp.pub() and locks @> '[{"dutyId":"2099-01-10"}]') then raise exception 'Saturday lock kept';end if;
end$$;
-- Its nets still add up (the swap books only the points difference).
do $$declare total bigint;begin
 perform pg_temp.as_member(1);
 select coalesce(sum(value::bigint),0) into total from jsonb_each_text(public.duty_balance()->'net');
 if total<>0 then raise exception 'Nets after swap %',public.duty_balance()->'net';end if;
end$$;

-- 9. Halves of one weekend swap between their holders (one weekend each); a pending swap of a
--    half is cancelled by the next edit of that weekend.
do $$declare request uuid;begin
 perform pg_temp.split('2099-01-16',3,0,4,0,'temporary');
 perform pg_temp.as_member(4);
 perform public.duty_request_swap(pg_temp.row_id('2099-01-17'),pg_temp.row_id('2099-01-16'),'',pg_temp.rev());
 select id into request from public.duty_swap_requests where status='awaiting_engineer';
 perform pg_temp.split('2099-01-16',3,0.5,4,0,'temporary');
 if (select status from public.duty_swap_requests where id=request)<>'invalidated' then raise exception 'Pending half swap kept';end if;
end$$;

-- 10. Edit duty (one duty) on a weekend whose dates have different histories: Permanent books
--     each date on its own, so giving Saturday back undoes its Temporary debt (H1) and Friday's
--     Permanent change stays debt-free.
do $$declare avi bigint;dana bigint;begin
 avi:=pg_temp.net(2);dana:=pg_temp.net(3);
 perform pg_temp.split('2099-01-30',3,0,2,1,'permanent');
 perform pg_temp.split('2099-01-30',3,0,3,1,'temporary');
 if pg_temp.weekend('2099-01-30')<>'2099-01-30/2/3/2/c4' or pg_temp.net(2)<>avi-3 or pg_temp.net(3)<>dana+3 then raise exception 'Mixed history setup % %',pg_temp.weekend('2099-01-30'),public.duty_balance()->'net';end if;
 if pg_temp.returns('2099-01-30')<>'[]' or pg_temp.returns('2099-01-31')<>'["2"]' then raise exception 'Per-date returns % %',pg_temp.returns('2099-01-30'),pg_temp.returns('2099-01-31');end if;
 perform public.duty_edit_published_duty(pg_temp.pub(),'2099-01-30',pg_temp.id(2),0,1,'permanent',pg_temp.rev(),'');
 if pg_temp.net(2)<>avi or pg_temp.net(3)<>dana then raise exception 'Per-date Permanent % (Avi %, Dana %)',public.duty_balance()->'net',avi,dana;end if;
end$$;

-- Override with a reason: published with manager_override; the reason stays in the manager-only audit.
do $$begin
 perform pg_temp.split('2099-01-23',2,0,3,0,'temporary','Dana asked for it');
 if not (select manager_override from public.duty_assignments where publication_id=pg_temp.pub() and day='2099-01-24') then raise exception 'Override not recorded';end if;
 if public.duty_balance()::text ~ 'asked for it|PRIVATE-' then raise exception 'Balance exposed the reason or a note';end if;
end$$;
reset role;
do $$begin
 if (select reason from public.duty_compensation_events where reason like 'Published weekend edit 2099-01-23%' order by sequence desc limit 1)<>'Published weekend edit 2099-01-23 (two days, temporary). Availability override: Dana asked for it' then raise exception 'Override reason not audited';end if;
 -- The H1 undo was booked as a Temporary edit intent of that date only.
 if not exists(select 1 from public.duty_compensation_events where operation->'after'->'intents' @> '[{"kind":"temporary","capacity":[{"date":"2099-01-24"}]}]') then raise exception 'H1 intent missing';end if;
end$$;
-- 11. A cover joined onto a date it didn't cover needs a reason when unavailable that date.
--     February: the 6th is split, Friday Avi covered by Dana, Saturday Eli covered by Avi;
--     Dana can't do the 7th.
insert into public.duty_months(month,deadline) values('2099-02','2099-01-24');
insert into public.duty_assignments(day,end_day,primary_id,secondary_id)
select d::date,d::date+case when extract(dow from d)=5 and d::date<>'2099-02-06' then 2 else 1 end,
 case when d::date='2099-02-07' then pg_temp.id(4) else pg_temp.id(2) end,case when d::date='2099-02-06' then pg_temp.id(3) when d::date='2099-02-07' then pg_temp.id(2) end
from generate_series('2099-02-01'::date,'2099-02-28'::date,interval '1 day') d where (extract(dow from d)<>6 or d::date='2099-02-07') and duty_private.duty_owner(d::date)='2099-02';
insert into public.duty_constraints(member_id,day,kind,note) values('63000000-0000-0000-0000-000000000003','2099-02-07','no','PRIVATE-COVER-NOTE');
set local role authenticated;
do $$declare pub uuid;begin
 perform pg_temp.as_member(1);
 perform public.duty_save_schedule(pg_temp.schedule('2099-02'),pg_temp.rev(),'2099-02');
 select current_publication_id into pub from public.duty_months where month='2099-02';
 -- Keep Avi: Friday's cover Dana now covers Saturday too.
 perform pg_temp.denied(format('select public.duty_edit_published_weekend(%L,%L,%L,0,%L,0,%L,%s)',pub,'2099-02-06',pg_temp.id(2),pg_temp.id(2),'temporary',pg_temp.rev()),'Availability conflict');
 perform public.duty_edit_published_weekend(pub,'2099-02-06',pg_temp.id(2),0,pg_temp.id(2),0,'temporary',pg_temp.rev(),'Dana covers anyway');
 select current_publication_id into pub from public.duty_months where month='2099-02';
 if not exists(select 1 from public.duty_assignments where publication_id=pub and day='2099-02-06' and end_day='2099-02-08' and secondary_id=pg_temp.id(3) and manager_override) then raise exception 'Joined cover override not recorded';end if;
end$$;
reset role;
rollback;
\echo PASS: published weekend split
