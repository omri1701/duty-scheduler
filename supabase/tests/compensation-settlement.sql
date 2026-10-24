-- Exact handover, lazy earning, reversals and checked participation transitions.
\set ON_ERROR_STOP on
begin;
do $$begin if exists(select 1 from auth.users) or exists(select 1 from public.duty_members) or exists(select 1 from public.duty_compensation_events) then raise exception 'Requires empty disposable LOCAL';end if;end$$;
create or replace function duty_private.compensation_now() returns bigint language sql volatile set search_path='' as $$
 select (extract(epoch from (timestamp '2099-01-13 09:00' at time zone 'Asia/Jerusalem'))*1000)::bigint-1;
$$;
insert into auth.users(id,email) values('61000000-0000-0000-0000-000000000001','settle-manager@example.invalid'),('61000000-0000-0000-0000-000000000002','settle-debtor@example.invalid'),('61000000-0000-0000-0000-000000000003','settle-creditor@example.invalid');
insert into public.duty_members(id,email,name,role,status,active) select id,email,'Synthetic',case when right(id::text,1)='1' then 'admin' else 'engineer' end,'approved',true from auth.users;
insert into public.duty_months(month,deadline) values('2099-01','2098-12-24');
insert into public.duty_assignments(day,end_day,primary_id)
select d::date,d::date+1,'61000000-0000-0000-0000-000000000002' from generate_series('2099-01-01'::date,'2099-02-01'::date,interval '1 day') d where duty_private.duty_owner(d::date)='2099-01';
set local request.jwt.claim.sub='61000000-0000-0000-0000-000000000001';
do $$declare v jsonb;ref jsonb;meta jsonb;rev bigint;begin
 select revision into rev from public.duty_workspace;set local role authenticated;
 v:=public.duty_compensation('{"kind":"claim","debtorId":"61000000-0000-0000-0000-000000000002","creditorId":"61000000-0000-0000-0000-000000000003","units":6}','debt','Reviewed debt',rev);rev:=(v->>'revision')::bigint;ref:=v->'actual'->'claims'->0;
 reset role;
 select jsonb_build_object('fingerprint',v->'fingerprint','intents','[]'::jsonb,'reservations',jsonb_agg(jsonb_build_object('id','r'||i,'capacity',jsonb_build_object('date',('2099-01-11'::date+i)::text,'offset',0,'units',2),'claim',duty_private.compensation_slice(ref,2,(i-1)*2)))) into meta from generate_series(1,3) i;
 set local role authenticated;
 perform public.duty_save_schedule(jsonb_build_object('team','[]'::jsonb,'months','{"2099-01":{"deadline":"2098-12-24","status":"draft","generated":true}}'::jsonb,'duties',(select jsonb_agg(to_jsonb(a)) from public.duty_assignments a where publication_id is null),'compensation',meta),rev,'2099-01');rev:=rev+1;
 v:=public.duty_compensation('{"kind":"reconcile"}',null,null,rev,null,(extract(epoch from (timestamp '2099-01-13 09:00' at time zone 'Asia/Jerusalem'))*1000)::bigint);
 if v->'actual'->'settlements'<>'[]' or v->'projected'->'net'->>'61000000-0000-0000-0000-000000000002'<>'-4' then raise exception 'Settled before handover or projected too much';end if;
 reset role;
end$$;
create or replace function duty_private.compensation_now() returns bigint language sql volatile set search_path='' as $$
 select (extract(epoch from (timestamp '2099-01-13 09:00' at time zone 'Asia/Jerusalem'))*1000)::bigint;
$$;
do $$declare v jsonb;rev bigint;settlement text;begin
 select revision into rev from public.duty_workspace;set local role authenticated;
 v:=public.duty_compensation('{"kind":"reconcile"}',null,null,rev);
 if jsonb_array_length(v->'actual'->'settlements')<>1 or v->'actual'->'net'->>'61000000-0000-0000-0000-000000000002'<>'-4' then raise exception 'Handover did not earn exactly once';end if;
 rev:=(v->>'revision')::bigint;settlement:=v->'actual'->'settlements'->0->>'id';
 v:=public.duty_compensation(jsonb_build_object('kind','reverse-settlement','settlementId',settlement),'reverse','Reviewed exceptional reversal',rev);
 v:=public.duty_compensation('{"kind":"reconcile"}',null,null,(v->>'revision')::bigint);
 if jsonb_array_length(v->'actual'->'settlements')<>1 or v->'actual'->'net'->>'61000000-0000-0000-0000-000000000002'<>'-6' then raise exception 'Reversal let completed capacity earn twice';end if;
 reset role;
end$$;
-- r2 has ended; r3 has not. A checked deactivation earns r2 first, then freezes.
create or replace function duty_private.compensation_now() returns bigint language sql volatile set search_path='' as $$
 select (extract(epoch from (timestamp '2099-01-14 09:00' at time zone 'Asia/Jerusalem'))*1000)::bigint;
$$;
do $$declare rev bigint;s jsonb;begin
 select revision into rev from public.duty_workspace;set local role authenticated;
 perform public.duty_save_schedule('{"team":[{"id":"61000000-0000-0000-0000-000000000002","color":"#adc9ee","active":false}],"months":{},"duties":[]}',rev);
 s:=public.duty_compensation('{"kind":"reconcile"}',null,null,rev+1);
 if s->'actual'->'net'->>'61000000-0000-0000-0000-000000000002'<>'-4' or jsonb_array_length(s->'actual'->'settlements')<>2 then raise exception 'Deactivation erased earned work';end if;
 reset role;
end$$;
create or replace function duty_private.compensation_now() returns bigint language sql volatile set search_path='' as $$
 select (extract(epoch from (timestamp '2099-01-15 09:00' at time zone 'Asia/Jerusalem'))*1000)::bigint;
$$;
do $$declare rev bigint;s jsonb;begin
 select revision into rev from public.duty_workspace;set local role authenticated;
 perform public.duty_save_schedule('{"team":[{"id":"61000000-0000-0000-0000-000000000002","color":"#adc9ee","active":true}],"months":{},"duties":[]}',rev);
 s:=public.duty_compensation('{"kind":"reconcile"}',null,null,rev+1);
 if s->'actual'->'net'->>'61000000-0000-0000-0000-000000000002'<>'-4' or s->'actual'->'contributions'->2->>'status'<>'held' or s->'actual'->'contributions'->2->>'holdReason'<>'inactive' then raise exception 'Reactivation auto-settled work performed during freeze';end if;
 s:=public.duty_compensation('{"kind":"release","contributionId":"r3"}','release','Reviewed frozen work',(s->>'revision')::bigint);
 if s->'actual'->'contributions'->2->>'status'<>'cancelled' then raise exception 'Explicit held-work resolution failed';end if;
 reset role;
end$$;
select 'PASS: authoritative exact-end earning, projection separation, immutable reversal capacity, deactivation reconciles first, inactive completion remains held after reactivation';
-- Mid-weekend split -> combined edit preserves an already completed Friday
-- accounting fact AND the pending Saturday with the real Sunday handover.
do $$declare rev bigint;v jsonb;pub uuid;plans jsonb;metadata jsonb;payload jsonb;begin
 select revision into rev from public.duty_workspace;select current_publication_id into pub from public.duty_months where month='2099-01';set local role authenticated;
 v:=public.duty_compensation('{"kind":"reconcile"}',null,null,rev);
 plans:=(v->'actual'->'publications'->0->'reservations')||jsonb_build_array(jsonb_build_object('id','saturday','capacity',jsonb_build_object('date','2099-01-17','offset',0,'units',1),'claim',jsonb_build_object('debtorId',v->'actual'->'claims'->0->'debtorId','creditorId',v->'actual'->'claims'->0->'creditorId','path',jsonb_build_array(jsonb_set(v->'actual'->'claims'->0->'path'->0,'{units}','1')))));
 metadata:=jsonb_build_object('fingerprint',v->'fingerprint','reservations',plans,'intents','[]'::jsonb);
 perform public.duty_restore_publication(pub,rev);rev:=rev+1;
 payload:=jsonb_build_object('team','[]'::jsonb,'months','{"2099-01":{"deadline":"2098-12-24","status":"draft","generated":true}}'::jsonb,'duties',(select jsonb_agg(to_jsonb(a)) from public.duty_assignments a where publication_id is null),'compensation',metadata);
 perform public.duty_save_schedule(payload,rev,'2099-01');reset role;
end$$;
create or replace function duty_private.compensation_now() returns bigint language sql volatile set search_path='' as $$
 select (extract(epoch from (timestamp '2099-01-17 09:00' at time zone 'Asia/Jerusalem'))*1000)::bigint;
$$;
do $$declare rev bigint;v jsonb;pub uuid;payload jsonb;begin
 select revision into rev from public.duty_workspace;select current_publication_id into pub from public.duty_months where month='2099-01';set local role authenticated;
 perform public.duty_restore_publication(pub,rev);rev:=rev+1;reset role;
 delete from public.duty_assignments where publication_id is null and day='2099-01-17';
 update public.duty_assignments set end_day='2099-01-18' where publication_id is null and day='2099-01-16';
 payload:=jsonb_build_object('team','[]'::jsonb,'months','{"2099-01":{"deadline":"2098-12-24","status":"draft","generated":true}}'::jsonb,'duties',(select jsonb_agg(to_jsonb(a)) from public.duty_assignments a where publication_id is null));set local role authenticated;
 perform public.duty_save_schedule(payload,rev,'2099-01');rev:=rev+1;
 v:=public.duty_compensation('{"kind":"reconcile"}',null,null,rev,null,(extract(epoch from (timestamp '2099-01-18 09:00' at time zone 'Asia/Jerusalem'))*1000)::bigint);
 if v->'actual'->'contributions'->3->>'status'<>'pending' or v->'actual'->'net'->>'61000000-0000-0000-0000-000000000002'<>'-4' or v->'projected'->'net'->>'61000000-0000-0000-0000-000000000002'<>'-3' then raise exception 'Mid-weekend combine lost pending Saturday capacity';end if;
 reset role;
end$$;
select 'PASS: split-to-combined weekend after Friday completion retains Saturday reservation/capacity and its Sunday projected handover';
rollback;
