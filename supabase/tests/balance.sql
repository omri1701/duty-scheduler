-- Empty disposable LOCAL only. Synthetic fixtures; always rolls back.
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
-- 1 admin, 2 Avi, 3 Dana, 4 pending, 5 approved but inactive.
insert into auth.users(id,email) select ('61000000-0000-0000-0000-'||lpad(i::text,12,'0'))::uuid,'balance-'||i||'@example.invalid' from generate_series(1,5) i;
insert into public.duty_members(id,email,name,role,status,active)
select id,email,'Synthetic '||right(id::text,1),case when right(id::text,1)='1' then 'admin' else 'engineer' end,
case when right(id::text,1)='4' then 'pending' else 'approved' end,right(id::text,1) not in ('4','5') from auth.users;
insert into public.duty_constraints(member_id,day,kind,note) values('61000000-0000-0000-0000-000000000003','2099-01-20','no','PRIVATE-BALANCE-NOTE');
create function pg_temp.schedule(p_month text, metadata jsonb default null) returns jsonb language sql security definer as $$
 select jsonb_build_object('team','[]'::jsonb,'months',jsonb_build_object(p_month,jsonb_build_object('deadline',(p_month||'-01')::date-8,'status','draft','generated',true)),
 'duties',coalesce((select jsonb_agg(to_jsonb(a) order by day) from public.duty_assignments a where publication_id is null and duty_private.duty_owner(a.day)=p_month),'[]'::jsonb))
 ||case when metadata is null then '{}'::jsonb else jsonb_build_object('compensation',metadata) end;
$$;
create function pg_temp.rev() returns bigint language sql as $$select revision from public.duty_workspace where id$$;
create function pg_temp.events() returns bigint language sql security definer as $$select count(*) from public.duty_compensation_events$$;
create function pg_temp.as_member(n int) returns void language sql as $$
 select set_config('request.jwt.claim.sub','61000000-0000-0000-0000-00000000000'||n,true);
$$;
-- Reviewed metadata funded from the admin path; the intent/reservation shape is the existing publication contract.
create function pg_temp.meta(intents jsonb, reservations jsonb default '[]') returns jsonb language plpgsql as $$
declare v jsonb;begin
 perform pg_temp.as_member(1);
 v:=public.duty_compensation('{"kind":"reconcile"}',null,null,pg_temp.rev());
 return jsonb_build_object('fingerprint',v->'fingerprint','intents',intents,'reservations',reservations);
end$$;
create function pg_temp.check(n int, expected jsonb, lines jsonb) returns void language plpgsql as $$
declare b jsonb;events bigint;rev bigint;begin
 events:=pg_temp.events();rev:=pg_temp.rev();
 perform pg_temp.as_member(n);
 b:=public.duty_balance();
 if b->'net'<>expected then raise exception 'Member % net %, expected %',n,b->'net',expected;end if;
 if b->'lines'<>lines then raise exception 'Member % lines %, expected %',n,b->'lines',lines;end if;
 if pg_temp.events()<>events or pg_temp.rev()<>rev then raise exception 'Balance read wrote ledger history or revision';end if;
 if b::text ~ 'PRIVATE-' or b ? 'events' then raise exception 'Balance exposed private data';end if;
end$$;
grant execute on function pg_temp.schedule(text,jsonb),pg_temp.rev(),pg_temp.events(),pg_temp.as_member(int),pg_temp.meta(jsonb,jsonb),pg_temp.check(int,jsonb,jsonb) to authenticated;
insert into public.duty_months(month,deadline) values('2099-01','2098-12-24');
insert into public.duty_assignments(day,end_day,primary_id)
select d::date,d::date+1,case when d::date='2099-01-12' then '61000000-0000-0000-0000-000000000003'::uuid else '61000000-0000-0000-0000-000000000002' end
from generate_series('2099-01-01'::date,'2099-02-01'::date,interval '1 day') d where duty_private.duty_owner(d::date)='2099-01';
set local role authenticated;
-- Grants and participation: anonymous, pending and inactive callers receive nothing.
do $$begin
 perform pg_temp.check(1,'{"61000000-0000-0000-0000-000000000001":0,"61000000-0000-0000-0000-000000000002":0,"61000000-0000-0000-0000-000000000003":0,"61000000-0000-0000-0000-000000000004":0,"61000000-0000-0000-0000-000000000005":0}','[]');
 perform pg_temp.as_member(4);perform pg_temp.denied('select public.duty_balance()','Member access required');
 perform pg_temp.as_member(5);perform pg_temp.denied('select public.duty_balance()','Member access required');
 perform pg_temp.as_member(2);perform pg_temp.denied('select duty_private.compensation_state()','permission denied');
end$$;
reset role;set local role anon;
select pg_temp.denied('select public.duty_balance()','permission denied');
reset role;set local role authenticated;
-- Publishing Avi's temporary transfer to Dana shows -1/+1 immediately, before the duty is worked.
do $$declare intent jsonb:='[{"id":"avi-to-dana","kind":"temporary","fromId":"61000000-0000-0000-0000-000000000002","toId":"61000000-0000-0000-0000-000000000003","capacity":[{"date":"2099-01-12","offset":0,"units":2}]}]';begin
 perform public.duty_save_schedule(pg_temp.schedule('2099-01',pg_temp.meta(intent)),pg_temp.rev(),'2099-01');
 perform pg_temp.check(1,'{"61000000-0000-0000-0000-000000000001":0,"61000000-0000-0000-0000-000000000002":-2,"61000000-0000-0000-0000-000000000003":2,"61000000-0000-0000-0000-000000000004":0,"61000000-0000-0000-0000-000000000005":0}',
  '[{"memberId":"61000000-0000-0000-0000-000000000002","counterpartId":"61000000-0000-0000-0000-000000000003","units":-2,"kind":"temporary","date":"2099-01-12","month":null},
    {"memberId":"61000000-0000-0000-0000-000000000003","counterpartId":"61000000-0000-0000-0000-000000000002","units":2,"kind":"temporary","date":"2099-01-12","month":null}]');
 -- Each engineer sees only their own row and relationships.
 perform pg_temp.as_member(2);
 if duty_private.balance()<>public.duty_balance() or (select count(*) from jsonb_object_keys(duty_private.balance()->'net'))<>1 then raise exception 'Direct helper call widened member scope';end if;
 perform pg_temp.check(2,'{"61000000-0000-0000-0000-000000000002":-2}',
  '[{"memberId":"61000000-0000-0000-0000-000000000002","counterpartId":"61000000-0000-0000-0000-000000000003","units":-2,"kind":"temporary","date":"2099-01-12","month":null}]');
 perform pg_temp.check(3,'{"61000000-0000-0000-0000-000000000003":2}',
  '[{"memberId":"61000000-0000-0000-0000-000000000003","counterpartId":"61000000-0000-0000-0000-000000000002","units":2,"kind":"temporary","date":"2099-01-12","month":null}]');
end$$;
-- Reopen and republish without the transfer: the published change nets it out.
do $$declare pub uuid;begin
 perform pg_temp.as_member(1);
 select current_publication_id into pub from public.duty_months where month='2099-01';
 perform public.duty_restore_publication(pub,pg_temp.rev());
 reset role;update public.duty_assignments set primary_id='61000000-0000-0000-0000-000000000002' where publication_id is null and day='2099-01-12';set local role authenticated;
 perform pg_temp.check(2,'{"61000000-0000-0000-0000-000000000002":-2}',
  '[{"memberId":"61000000-0000-0000-0000-000000000002","counterpartId":"61000000-0000-0000-0000-000000000003","units":-2,"kind":"temporary","date":"2099-01-12","month":null}]');
 perform pg_temp.as_member(1);
 perform public.duty_save_schedule(pg_temp.schedule('2099-01'),pg_temp.rev(),'2099-01');
 perform pg_temp.check(2,'{"61000000-0000-0000-0000-000000000002":0}','[]');
 perform pg_temp.check(3,'{"61000000-0000-0000-0000-000000000003":0}','[]');
end$$;
-- Transfer again, then publish a later repayment: the projection returns to zero
-- while the internal ledger keeps the debt actual until the repayment is worked.
do $$declare pub uuid;intent jsonb:='[{"id":"avi-to-dana-again","kind":"temporary","fromId":"61000000-0000-0000-0000-000000000002","toId":"61000000-0000-0000-0000-000000000003","capacity":[{"date":"2099-01-12","offset":0,"units":2}]}]';v jsonb;begin
 perform pg_temp.as_member(1);
 select current_publication_id into pub from public.duty_months where month='2099-01';
 perform public.duty_restore_publication(pub,pg_temp.rev());
 reset role;update public.duty_assignments set primary_id='61000000-0000-0000-0000-000000000003' where publication_id is null and day='2099-01-12';set local role authenticated;
 perform public.duty_save_schedule(pg_temp.schedule('2099-01',pg_temp.meta(intent)),pg_temp.rev(),'2099-01');
 perform pg_temp.check(3,'{"61000000-0000-0000-0000-000000000003":2}',
  '[{"memberId":"61000000-0000-0000-0000-000000000003","counterpartId":"61000000-0000-0000-0000-000000000002","units":2,"kind":"temporary","date":"2099-01-12","month":null}]');
 reset role;insert into public.duty_months(month,deadline) values('2099-02','2099-01-24');
 insert into public.duty_assignments(day,end_day,primary_id)
 select d::date,d::date+1,'61000000-0000-0000-0000-000000000002' from generate_series('2099-02-01'::date,'2099-03-01'::date,interval '1 day') d where duty_private.duty_owner(d::date)='2099-02';
 set local role authenticated;perform pg_temp.as_member(1);
 v:=public.duty_compensation('{"kind":"reconcile"}',null,null,pg_temp.rev());
 perform public.duty_save_schedule(pg_temp.schedule('2099-02',jsonb_build_object('fingerprint',v->'fingerprint','intents','[]'::jsonb,
  'reservations',jsonb_build_array(jsonb_build_object('id','repay-dana','capacity',jsonb_build_object('date','2099-02-02','offset',0,'units',2),'claim',v->'actual'->'claims'->0)))),pg_temp.rev(),'2099-02');
 perform pg_temp.check(2,'{"61000000-0000-0000-0000-000000000002":0}','[]');
 perform pg_temp.check(3,'{"61000000-0000-0000-0000-000000000003":0}','[]');
 perform pg_temp.as_member(1);
 v:=public.duty_compensation('{"kind":"reconcile"}',null,null,pg_temp.rev());
 if v->'actual'->'net'->>'61000000-0000-0000-0000-000000000002'<>'-2' then raise exception 'Display projection changed actual settlement';end if;
 -- A partial view: an unrelated manual claim with a private audit reason.
 perform public.duty_compensation('{"kind":"claim","debtorId":"61000000-0000-0000-0000-000000000001","creditorId":"61000000-0000-0000-0000-000000000003","units":1}','balance-manual','PRIVATE-AUDIT-REASON',pg_temp.rev());
 perform pg_temp.check(3,'{"61000000-0000-0000-0000-000000000003":1}',
  '[{"memberId":"61000000-0000-0000-0000-000000000003","counterpartId":"61000000-0000-0000-0000-000000000001","units":1,"kind":"manual","date":null,"month":null}]');
 perform pg_temp.check(2,'{"61000000-0000-0000-0000-000000000002":0}','[]');
 -- Halves net across people: Avi owes the admin half a point and the admin owes Dana half a point, so Avi owes
 -- Dana directly (carried through the team) and the admin is clear. The lone half stays exact beside Avi's
 -- reserved whole point; nothing rounds, forgives or rebinds it.
 perform pg_temp.as_member(1);
 perform public.duty_compensation('{"kind":"claim","debtorId":"61000000-0000-0000-0000-000000000002","creditorId":"61000000-0000-0000-0000-000000000001","units":1}','balance-chain','PRIVATE-CHAIN-REASON',pg_temp.rev());
 perform pg_temp.check(1,'{"61000000-0000-0000-0000-000000000001":0,"61000000-0000-0000-0000-000000000002":-1,"61000000-0000-0000-0000-000000000003":1,"61000000-0000-0000-0000-000000000004":0,"61000000-0000-0000-0000-000000000005":0}',
  '[{"memberId":"61000000-0000-0000-0000-000000000002","counterpartId":"61000000-0000-0000-0000-000000000003","units":-1,"kind":"routed","date":null,"month":null},
    {"memberId":"61000000-0000-0000-0000-000000000002","counterpartId":"61000000-0000-0000-0000-000000000003","units":-2,"kind":"temporary","date":"2099-01-12","month":null},
    {"memberId":"61000000-0000-0000-0000-000000000002","counterpartId":"61000000-0000-0000-0000-000000000003","units":2,"kind":"repayment","date":"2099-02-02","month":null},
    {"memberId":"61000000-0000-0000-0000-000000000003","counterpartId":"61000000-0000-0000-0000-000000000002","units":1,"kind":"routed","date":null,"month":null},
    {"memberId":"61000000-0000-0000-0000-000000000003","counterpartId":"61000000-0000-0000-0000-000000000002","units":2,"kind":"temporary","date":"2099-01-12","month":null},
    {"memberId":"61000000-0000-0000-0000-000000000003","counterpartId":"61000000-0000-0000-0000-000000000002","units":-2,"kind":"repayment","date":"2099-02-02","month":null}]');
 perform pg_temp.check(2,'{"61000000-0000-0000-0000-000000000002":-1}',
  '[{"memberId":"61000000-0000-0000-0000-000000000002","counterpartId":"61000000-0000-0000-0000-000000000003","units":-1,"kind":"routed","date":null,"month":null},
    {"memberId":"61000000-0000-0000-0000-000000000002","counterpartId":"61000000-0000-0000-0000-000000000003","units":-2,"kind":"temporary","date":"2099-01-12","month":null},
    {"memberId":"61000000-0000-0000-0000-000000000002","counterpartId":"61000000-0000-0000-0000-000000000003","units":2,"kind":"repayment","date":"2099-02-02","month":null}]');
 perform pg_temp.as_member(1);
 v:=public.duty_compensation('{"kind":"reconcile"}',null,null,pg_temp.rev());
 if jsonb_array_length(v->'actual'->'claims')<>2 or (select count(*) from jsonb_array_elements(v->'actual'->'claims') c where jsonb_array_length(c->'path')=2 and c->>'units'='1')<>1
  or (select count(*) from jsonb_array_elements(v->'actual'->'contributions') x where x->>'status'='pending')<>1 then raise exception 'Half-point chain changed the reserved whole point or lost a leg: %',v->'actual'->'claims';end if;
end$$;
reset role;
select 'PASS: member-scoped projected balance, pending/inactive/anonymous denial, read-only access, no private notes or audit reasons, transfer/republish/repayment projection, half-point chain netting';
rollback;
