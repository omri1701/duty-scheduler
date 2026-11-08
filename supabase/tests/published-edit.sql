-- Empty disposable LOCAL only. Synthetic fixtures; always rolls back.
-- Published duty edit: admin only, revision/publication checks, availability
-- re-check, one canonical Temporary debt, none for Permanent, exact half points.
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
-- 1 admin, 2 Avi, 3 Dana, 4 Eli, 5 approved but inactive, 6 pending.
insert into auth.users(id,email) select ('62000000-0000-0000-0000-'||lpad(i::text,12,'0'))::uuid,'edit-'||i||'@example.invalid' from generate_series(1,6) i;
insert into public.duty_members(id,email,name,role,status,active)
select id,email,'Synthetic '||right(id::text,1),case when right(id::text,1)='1' then 'admin' else 'engineer' end,
case when right(id::text,1)='6' then 'pending' else 'approved' end,right(id::text,1) not in ('5','6') from auth.users;
insert into public.duty_constraints(member_id,day,kind,note) values('62000000-0000-0000-0000-000000000003','2099-01-20','no','PRIVATE-EDIT-NOTE');
create function pg_temp.id(n int) returns uuid language sql as $$select ('62000000-0000-0000-0000-00000000000'||n)::uuid$$;
create function pg_temp.as_member(n int) returns void language sql as $$select set_config('request.jwt.claim.sub',pg_temp.id(n)::text,true)$$;
create function pg_temp.rev() returns bigint language sql security definer as $$select revision from public.duty_workspace where id$$;
create function pg_temp.pub() returns uuid language sql security definer as $$select current_publication_id from public.duty_months where month='2099-01'$$;
create function pg_temp.row(p_day date, p_publication uuid default null) returns public.duty_assignments language sql security definer as $$select * from public.duty_assignments where publication_id=coalesce(p_publication,pg_temp.pub()) and day=p_day$$;
create function pg_temp.allocation() returns public.duty_allocations language sql security definer as $$select * from public.duty_allocations where publication_id=pg_temp.pub()$$;
-- Open claims as debtor→creditor units, straight from the ledger state.
create function pg_temp.claims() returns jsonb language sql security definer as $$
 select coalesce(jsonb_agg(jsonb_build_object('from',right(c->>'debtorId',1),'to',right(c->>'creditorId',1),'units',(c->>'units')::bigint) order by c->>'debtorId',c->>'creditorId'),'[]')
 from jsonb_array_elements(duty_private.compensation_state()->'claims') c$$;
create function pg_temp.net(n int) returns bigint language plpgsql as $$
begin perform pg_temp.as_member(1);return (public.duty_balance()->'net'->>pg_temp.id(n)::text)::bigint;end$$;
create function pg_temp.edit(p_day date, p_primary int, p_extra numeric, p_saturday numeric, p_kind text, p_reason text default '') returns jsonb language plpgsql as $$
begin perform pg_temp.as_member(1);return public.duty_edit_published_duty(pg_temp.pub(),p_day,pg_temp.id(p_primary),p_extra,p_saturday,p_kind,pg_temp.rev(),p_reason);end$$;
create function pg_temp.schedule(p_month text) returns jsonb language sql security definer as $$
 select jsonb_build_object('team','[]'::jsonb,'months',jsonb_build_object(p_month,jsonb_build_object('deadline',(p_month||'-01')::date-8,'status','draft','generated',true)),
 'duties',coalesce((select jsonb_agg(to_jsonb(a) order by day) from public.duty_assignments a where publication_id is null and duty_private.duty_owner(a.day)=p_month),'[]'::jsonb));
$$;
grant execute on function pg_temp.id(int),pg_temp.as_member(int),pg_temp.rev(),pg_temp.pub(),pg_temp.row(date,uuid),pg_temp.allocation(),pg_temp.claims(),pg_temp.net(int),
 pg_temp.edit(date,int,numeric,numeric,text,text),pg_temp.schedule(text) to authenticated;
-- January 2099: Avi on every duty; Fridays are combined weekends (Friday + Saturday = 1 point).
insert into public.duty_months(month,deadline) values('2099-01','2098-12-24');
insert into public.duty_assignments(day,end_day,primary_id)
select d::date,d::date+case when extract(dow from d)=5 then 2 else 1 end,pg_temp.id(2)
from generate_series('2099-01-01'::date,'2099-01-31'::date,interval '1 day') d where extract(dow from d)<>6 and duty_private.duty_owner(d::date)='2099-01';
set local role authenticated;
do $$begin
 perform pg_temp.as_member(1);
 perform public.duty_save_schedule(pg_temp.schedule('2099-01'),pg_temp.rev(),'2099-01');
end$$;
reset role;
-- An allocation snapshot keeps lineage; its lock follows the new engineer.
insert into public.duty_allocations(month,publication_id,allocation,locks,approvals,accounting_fingerprint,calendar_fingerprint)
values('2099-01',pg_temp.pub(),'{}',jsonb_build_array(jsonb_build_object('dutyId','2099-01-13','engineer',pg_temp.id(2))),
 '[{"rule":"availability","dutyId":"2099-01-13"},{"rule":"availability","dutyId":"2099-01-27"}]','synthetic','synthetic');
set local role authenticated;

-- Only admins: engineers, pending and inactive members cannot edit.
do $$declare pub uuid:=pg_temp.pub();begin
 perform pg_temp.as_member(2);
 perform pg_temp.denied(format('select public.duty_edit_published_duty(%L,%L,%L,0,0,%L,%s)',pub,'2099-01-13',pg_temp.id(4),'temporary',pg_temp.rev()),'Admin access required');
 perform pg_temp.denied(format('select duty_private.edit_published_duty(%L,%L,%L,0,0,%L,%s)',pub,'2099-01-13',pg_temp.id(2),'permanent',pg_temp.rev()),'Admin access required');
 perform pg_temp.as_member(6);
 perform pg_temp.denied(format('select public.duty_edit_published_duty(%L,%L,%L,0,0,%L,%s)',pub,'2099-01-13',pg_temp.id(4),'temporary',pg_temp.rev()),'membership is not approved');
 perform pg_temp.as_member(5);
 perform pg_temp.denied(format('select public.duty_edit_published_duty(%L,%L,%L,0,0,%L,%s)',pub,'2099-01-13',pg_temp.id(4),'temporary',pg_temp.rev()),'membership is not approved');
end$$;
reset role;set local role anon;
do $$begin perform pg_temp.denied('select public.duty_edit_published_duty(gen_random_uuid(),''2099-01-13'',gen_random_uuid(),0,0,''temporary'',0)','permission denied');end$$;
reset role;set local role authenticated;

-- Revision and publication checks, validation, and the availability re-check.
do $$declare pub uuid:=pg_temp.pub();rev bigint:=pg_temp.rev();begin
 perform pg_temp.as_member(1);
 perform pg_temp.denied(format('select public.duty_edit_published_duty(%L,%L,%L,0,0,%L,%s)',pub,'2099-01-13',pg_temp.id(4),'temporary',rev-1),'team data changed');
 perform pg_temp.denied(format('select public.duty_edit_published_duty(%L,%L,%L,0,0,%L,%s)',gen_random_uuid(),'2099-01-13',pg_temp.id(4),'temporary',rev),'publication changed');
 perform pg_temp.denied('select pg_temp.edit(''2099-01-13'',4,0,0,''forever'')','Temporary or Permanent');
 perform pg_temp.denied('select pg_temp.edit(''2099-01-13'',2,0,0,''temporary'')','Nothing changed');
 perform pg_temp.denied('select pg_temp.edit(''2099-01-13'',5,0,0,''temporary'')','active approved engineer');
 perform pg_temp.denied('select pg_temp.edit(''2099-01-13'',4,0.3,0,''temporary'')','half points');
 perform pg_temp.denied('select pg_temp.edit(''2099-01-13'',4,0,0.5,''temporary'')','half points');
 perform pg_temp.denied('select pg_temp.edit(''2099-01-13'',4,21,0,''temporary'')','half points');
 perform pg_temp.denied('select pg_temp.edit(''2099-01-17'',4,0,0,''temporary'')','duty in this published month');
 perform pg_temp.denied('select pg_temp.edit(''2099-01-20'',3,0,0,''temporary'')','Availability conflict');
 perform pg_temp.denied('select pg_temp.edit(''2099-01-20'',3,0,0,''temporary'',''   '')','Availability conflict');
 perform pg_temp.denied(format('select pg_temp.edit(%L,3,0,0,%L,%L)','2099-01-20','temporary',E'\t\n'||U&'\00A0\3000'),'Availability conflict');
 if pg_temp.rev()<>rev or pg_temp.pub()<>pub or pg_temp.claims()<>'[]' then raise exception 'A refused edit wrote data';end if;
end$$;
-- The accounting helper stays server-only: clients cannot pass their own intents or reasons.
do $$begin
 if has_function_privilege('authenticated','duty_private.compensation_publication(text,uuid,jsonb,boolean,jsonb)','EXECUTE') then raise exception 'compensation_publication is client-callable';end if;
end$$;
-- A reopened month keeps a draft copied from the earlier version: edits wait for it.
reset role;
update public.duty_months set status='draft' where month='2099-01';
set local role authenticated;
do $$begin perform pg_temp.denied('select pg_temp.edit(''2099-01-13'',4,0,0,''temporary'')','open draft');end$$;
reset role;
update public.duty_months set status='published' where month='2099-01';
set local role authenticated;

-- Temporary (default): one new version, exactly one canonical debt Avi → Eli.
do $$declare old_pub uuid:=pg_temp.pub();rev bigint:=pg_temp.rev();result jsonb;a public.duty_allocations;begin
 result:=pg_temp.edit('2099-01-13',4,0,0,'temporary');
 if result->>'publication'<>pg_temp.pub()::text or (result->>'version')::int<>2 or pg_temp.rev()<>rev+1 then raise exception 'Edit did not publish version 2: %',result;end if;
 if (pg_temp.row('2099-01-13')).primary_id<>pg_temp.id(4) or (pg_temp.row('2099-01-14')).primary_id<>pg_temp.id(2) then raise exception 'Edit changed the wrong duty';end if;
 if (pg_temp.row('2099-01-13',old_pub)).primary_id<>pg_temp.id(2) then raise exception 'Published history changed';end if;
 a:=pg_temp.allocation();
 if a.source_publication_id<>old_pub or a.locks->0->>'engineer'<>pg_temp.id(4)::text or a.approvals<>'[{"rule":"availability","dutyId":"2099-01-27"}]' then raise exception 'Allocation lineage not carried: %',to_jsonb(a);end if;
 if pg_temp.claims()<>'[{"to":"4","from":"2","units":2}]' then raise exception 'Temporary claims %',pg_temp.claims();end if;
 if pg_temp.net(2)<>-2 or pg_temp.net(4)<>2 then raise exception 'Temporary balance %',public.duty_balance()->'net';end if;
 if not exists(select 1 from jsonb_array_elements(public.duty_balance()->'lines') l where l->>'memberId'=pg_temp.id(4)::text and l->>'kind'='change' and (l->>'units')::int=2 and l->>'month'='2099-01') then raise exception 'Team balance line missing';end if;
end$$;

-- Permanent: a new version and no debt.
do $$begin
 perform pg_temp.edit('2099-01-14',3,0,0,'permanent');
 if (pg_temp.row('2099-01-14')).primary_id<>pg_temp.id(3) then raise exception 'Permanent edit not published';end if;
 if pg_temp.claims()<>'[{"to":"4","from":"2","units":2}]' or pg_temp.net(3)<>0 then raise exception 'Permanent created debt %',pg_temp.claims();end if;
end$$;

-- Extra points: the same engineer earns the added extra with no debt; a later
-- Temporary move owes the duty's full points, half points exact.
do $$begin
 perform pg_temp.edit('2099-01-15',2,1.5,0,'temporary');
 if (pg_temp.row('2099-01-15')).points<>2.5 or pg_temp.claims()<>'[{"to":"4","from":"2","units":2}]' then raise exception 'Extra-only edit %',pg_temp.claims();end if;
 perform pg_temp.edit('2099-01-15',3,1.5,0,'temporary');
 if pg_temp.net(2)<>-7 or pg_temp.net(3)<>5 then raise exception 'Half-point debt %',public.duty_balance()->'net';end if;
end$$;

-- A combined weekend moved with a new Friday extra: the old engineer owes the
-- published point (two half-point dates); the added 0.5 counts for Eli alone.
do $$begin
 perform pg_temp.edit('2099-01-16',4,0.5,0,'temporary');
 if (pg_temp.row('2099-01-16')).points<>1.5 or (pg_temp.row('2099-01-16')).primary_id<>pg_temp.id(4) then raise exception 'Weekend edit not published';end if;
 if pg_temp.net(2)<>-9 or pg_temp.net(4)<>4 then raise exception 'Weekend debt %',public.duty_balance()->'net';end if;
 -- Permanent over a weekend with Saturday extra: no debt for either date.
 perform pg_temp.edit('2099-01-23',3,0,1,'permanent');
 if (pg_temp.row('2099-01-23')).points<>2 or pg_temp.net(2)<>-9 or pg_temp.net(3)<>5 then raise exception 'Permanent weekend %',public.duty_balance()->'net';end if;
end$$;

-- Override with a reason: published with manager_override; the reason stays in the
-- manager-only ledger audit and never reaches the balance.
do $$begin
 perform pg_temp.edit('2099-01-20',3,0,0,'temporary','Dana swapped her clinic day');
 if not (pg_temp.row('2099-01-20')).manager_override or pg_temp.net(3)<>7 then raise exception 'Override edit %',public.duty_balance()->'net';end if;
 if public.duty_balance()::text ~ 'clinic|PRIVATE-' then raise exception 'Balance exposed the reason or a note';end if;
 perform pg_temp.as_member(2);
 if exists(select 1 from public.duty_compensation_events) then raise exception 'Engineer read ledger audit';end if;
end$$;
reset role;
do $$begin
 if (select count(*) from public.duty_publications where month='2099-01')<>8 then raise exception 'Expected eight versions';end if;
 if (select reason from public.duty_compensation_events order by sequence desc limit 1)<>'Published duty edit 2099-01-20 (temporary). Availability override: Dana swapped her clinic day' then raise exception 'Override reason not audited';end if;
 if (select count(*) from public.duty_compensation_events where operation->'after'->'intents' @> '[{"kind":"permanent"}]' and operation->>'kind'='publication')<>6 then raise exception 'Permanent intents should be recorded and carried';end if;
end$$;
rollback;
\echo PASS: published duty edit
