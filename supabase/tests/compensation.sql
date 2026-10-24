-- Empty disposable LOCAL only. Every fixture, clock and injected failure rolls back.
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
insert into auth.users(id,email) select ('60000000-0000-0000-0000-'||lpad(i::text,12,'0'))::uuid,'comp-'||i||'@example.invalid' from generate_series(1,6) i;
insert into public.duty_members(id,email,name,role,status,active)
select id,email,'Synthetic '||right(id::text,1),case when right(id::text,1) in ('1','6') then 'admin' else 'engineer' end,
case when right(id::text,1)='4' then 'pending' when right(id::text,1)='5' then 'rejected' else 'approved' end,right(id::text,1) not in ('3','4','5') from auth.users;
-- RPC grants, RLS, helper isolation and denial of both direct and forged writes.
do $$declare who uuid;count_before bigint;begin
 select count(*) into count_before from public.duty_compensation_events;
 -- Onboarding retries must not freeze an already approved participant.
 insert into public.duty_members(id,email,name) select m.id,m.email,m.name from public.duty_members m where m.role='admin' on conflict(id) do nothing;
 if (select count(*) from public.duty_compensation_events)<>count_before then raise exception 'No-op onboarding changed participation';end if;
 for who in select m.id from public.duty_members m where role='engineer' loop
  perform set_config('request.jwt.claim.sub',who::text,true);set local role authenticated;
  perform pg_temp.denied($s$select public.duty_compensation('{"kind":"claim","debtorId":"60000000-0000-0000-0000-000000000001","creditorId":"60000000-0000-0000-0000-000000000002","units":1}','no','Reason',0)$s$,'Admin access required');
  perform pg_temp.denied($s$select public.duty_compensation('{"kind":"reconcile"}',null,null,0)$s$,'Admin access required');
  if exists(select 1 from public.duty_compensation_events) then raise exception 'Nonmanager audit disclosure';end if;
  reset role;
 end loop;
 set local role anon;perform pg_temp.denied($s$select public.duty_compensation('{"kind":"reconcile"}',null,null,0)$s$,'permission denied');reset role;
 perform set_config('request.jwt.claim.sub','60000000-0000-0000-0000-000000000001',true);set local role authenticated;
 perform pg_temp.denied('insert into public.duty_compensation_events values(999,''forged'',0,''manager'',null,''{}'')','permission denied');
 perform pg_temp.denied('update public.duty_compensation_events set reason=''edited''','permission denied');
 perform pg_temp.denied('delete from public.duty_compensation_events','permission denied');
 perform pg_temp.denied('truncate public.duty_compensation_events','permission denied');
 perform pg_temp.denied('select duty_private.compensation_state()','permission denied');
 perform pg_temp.denied('select duty_private.compensation_now()','permission denied');
 perform pg_temp.denied($s$select public.duty_compensation('{"kind":"earned","contributionId":"fake"}','x','Reason',0)$s$,'Invalid compensation operation');
 perform pg_temp.denied($s$select public.duty_compensation('{"kind":"claim","units":1,"at":0}','x','Reason',0)$s$,'Invalid compensation fields');
 reset role;
 if (select count(*) from public.duty_compensation_events)<>count_before then raise exception 'Denied call changed audit history';end if;
 perform pg_temp.denied('update public.duty_compensation_events set reason=''edited''','append-only');
 perform pg_temp.denied('delete from public.duty_compensation_events','append-only');
 perform pg_temp.denied('truncate public.duty_compensation_events','append-only');
 set local role service_role;perform pg_temp.denied('delete from public.duty_compensation_events','permission denied');reset role;
end$$;
do $$declare result jsonb;op jsonb:='{"kind":"claim","debtorId":"60000000-0000-0000-0000-000000000001","creditorId":"60000000-0000-0000-0000-000000000002","units":4}';n bigint;rev bigint;begin
 select revision into rev from public.duty_workspace;
 set local role authenticated;
 result:=public.duty_compensation(op,'manual-debt','Reviewed obligation',rev);
 n:=jsonb_array_length(result->'actual'->'events');
 if result->'actual'->'net'->>'60000000-0000-0000-0000-000000000001'<>'-4' then raise exception 'Wrong manual balance';end if;
 result:=public.duty_compensation(op,'manual-debt','Reviewed obligation',rev);
 if jsonb_array_length(result->'actual'->'events')<>n or (result->>'revision')::bigint<>rev+1 then raise exception 'Duplicate retry changed ledger';end if;
 perform pg_temp.denied(format('select public.duty_compensation(%L,''manual-debt'',''Changed reason'',%s)',op,rev),'source-key-conflict');
 perform pg_temp.denied(format('select public.duty_compensation(%L,''stale'',''Reason'',%s)',op,rev),'team data changed');
 rev:=rev+1;
 perform pg_temp.denied(format('select public.duty_compensation(%L,''fingerprint'',''Reason'',%s,''forged'')',op,rev),'Compensation changed');
 perform pg_temp.denied(format('select public.duty_compensation(%L,''fraction'',''Reason'',%s)',jsonb_set(op,'{units}','0.5'),rev),'invalid-units');
 perform pg_temp.denied(format('select public.duty_compensation(%L,''missing'',''Reason'',%s)',jsonb_set(op,'{creditorId}','"unknown"'),rev),'invalid-endpoints');
 perform pg_temp.denied(format('select public.duty_compensation(%L,''reason'','''',%s)',op,rev),'Source key and reason');
 perform pg_temp.denied(format('select public.duty_compensation(%L,''whitespace'',%L,%s)',op,U&'\0009\000A\00A0\FEFF',rev),'Source key and reason');
 perform pg_temp.denied(format('select public.duty_compensation(%L,''string-delta'',''Reason'',%s)',jsonb_build_object('kind','correct','lotId','manual/60000000-0000-0000-0000-000000000001/manual-debt','deltaUnits','1'),rev),'invalid-correction');
 reset role;
end$$;
-- Full coverage remains the existing Publish gate. Only publication can attach
-- reviewed plans, and post-reconciliation fingerprints must match.
insert into public.duty_months(month,deadline) values('2099-01','2098-12-24');
insert into public.duty_assignments(day,end_day,primary_id,extra_points)
select d::date,d::date+1,'60000000-0000-0000-0000-000000000001',case when d::date='2099-01-12' then 2 else 0 end
from generate_series('2099-01-01'::date,'2099-02-01'::date,interval '1 day') d where duty_private.duty_owner(d::date)='2099-01';
create function pg_temp.schedule(metadata jsonb default null) returns jsonb language sql as $$
 select jsonb_build_object('team','[]'::jsonb,'months','{"2099-01":{"deadline":"2098-12-24","status":"draft","generated":true}}'::jsonb,
 'duties',coalesce((select jsonb_agg(to_jsonb(a) order by day) from public.duty_assignments a where publication_id is null),'[]'::jsonb))
 ||case when metadata is null then '{}'::jsonb else jsonb_build_object('compensation',metadata) end;
$$;
create function pg_temp.inject_failure() returns trigger language plpgsql as $$begin if new.operation->>'kind'='publication' then raise exception 'Injected ledger failure';end if;return new;end$$;
create trigger compensation_test_failure before insert on public.duty_compensation_events for each row execute function pg_temp.inject_failure();
do $$declare before_rows jsonb;rev bigint;begin
 select jsonb_agg(to_jsonb(a) order by id) into before_rows from public.duty_assignments a;select revision into rev from public.duty_workspace;
 set local role authenticated;
 perform pg_temp.denied(format('select public.duty_save_schedule(pg_temp.schedule(),%s,''2099-01'')',rev),'Injected ledger failure');reset role;
 if (select jsonb_agg(to_jsonb(a) order by id) from public.duty_assignments a)<>before_rows or exists(select 1 from public.duty_publications) or (select revision from public.duty_workspace)<>rev then raise exception 'Publication failure did not roll back all owners';end if;
end$$;
drop trigger compensation_test_failure on public.duty_compensation_events;
do $$declare v jsonb;meta jsonb;rev bigint;pub uuid;events bigint;source_count bigint;from_id uuid;to_id uuid;request_id uuid;begin
 select revision into rev from public.duty_workspace;set local role authenticated;
 v:=public.duty_compensation('{"kind":"reconcile"}',null,null,rev);
 meta:=jsonb_build_object('fingerprint',v->'fingerprint','reservations',jsonb_build_array(jsonb_build_object('id','repayment','capacity',jsonb_build_object('date','2099-01-12','offset',0,'units',4),'claim',v->'actual'->'claims'->0)),'intents','[]'::jsonb);
 perform pg_temp.denied(format('select public.duty_save_schedule(pg_temp.schedule(%L),%s,''2099-01'')',jsonb_set(meta,'{reservations,0,id}',to_jsonb(repeat('r',233))),rev),'invalid-reservation');
 perform pg_temp.denied(format('select public.duty_save_schedule(pg_temp.schedule(%L),%s,''2099-01'')',jsonb_set(meta,'{reservations,0,id}','123'),rev),'invalid-reservation');
 perform pg_temp.denied(format('select public.duty_save_schedule(pg_temp.schedule(%L),%s,''2099-01'')',jsonb_set(meta,'{reservations}','{}'),rev),'invalid-publication-metadata');
 perform pg_temp.denied(format('select public.duty_save_schedule(pg_temp.schedule(%L),%s,''2099-01'')',jsonb_set(meta,'{intents}','[{"id":"missing-capacity","kind":"permanent","fromId":"60000000-0000-0000-0000-000000000002","toId":"60000000-0000-0000-0000-000000000001"}]'),rev),'invalid-intent');
 perform public.duty_save_schedule(pg_temp.schedule(meta),rev,'2099-01');
 reset role;select revision into rev from public.duty_workspace;select current_publication_id into pub from public.duty_months where month='2099-01';set local role authenticated;
 v:=public.duty_compensation('{"kind":"reconcile"}',null,null,rev,null,4071970800000);
 if v->'actual'->'net'->>'60000000-0000-0000-0000-000000000001'<>'-4' or v->'projected'->'net'->>'60000000-0000-0000-0000-000000000001'<>'0' or v->'actual'->'settlements'<>'[]' then raise exception 'Actual/projected semantics broken';end if;
 events:=jsonb_array_length(v->'actual'->'events');
 perform public.duty_restore_publication(pub,rev);rev:=rev+1;perform public.duty_cancel_draft('2099-01',rev);rev:=rev+1;
 v:=public.duty_compensation('{"kind":"reconcile"}',null,null,rev);
 if jsonb_array_length(v->'actual'->'events')<>events then raise exception 'Draft actions fabricated ledger events';end if;
 perform public.duty_restore_publication(pub,rev);rev:=rev+1;
 perform public.duty_save_schedule(pg_temp.schedule(),rev,'2099-01');rev:=rev+1;
 v:=public.duty_compensation('{"kind":"reconcile"}',null,null,rev);
 if jsonb_array_length(v->'actual'->'contributions')<>1 or jsonb_array_length(v->'actual'->'lots')<>1 then raise exception 'Unchanged copy duplicated origins/reservations';end if;
 -- A second owner cannot reserve the same source slices.
 reset role;insert into public.duty_months(month,deadline) values('2099-02','2099-01-24');
 insert into public.duty_publications(month,version,published_by) values('2099-02',1,'60000000-0000-0000-0000-000000000001') returning id into pub;
 insert into public.duty_assignments(publication_id,day,end_day,primary_id,extra_points) values(pub,'2099-02-02','2099-02-03','60000000-0000-0000-0000-000000000001',2);
 perform pg_temp.denied(format('select duty_private.compensation_publication(''2099-02'',%L,%L)',pub,jsonb_build_object('fingerprint',v->'fingerprint','reservations',jsonb_build_array(jsonb_set(meta->'reservations'->0,'{id}','"second"')||'{"capacity":{"date":"2099-02-02","offset":0,"units":4}}'),'intents','[]'::jsonb)),'claim-already-reserved');
 select current_publication_id into pub from public.duty_months where month='2099-01';set local role authenticated;
 perform public.duty_restore_publication(pub,rev);rev:=rev+1;reset role;
 update public.duty_assignments set primary_id='60000000-0000-0000-0000-000000000002' where publication_id is null and day='2099-01-12';set local role authenticated;
 perform public.duty_save_schedule(pg_temp.schedule(),rev,'2099-01');rev:=rev+1;
 v:=public.duty_compensation('{"kind":"reconcile"}',null,null,rev);
 if v->'actual'->'net'->>'60000000-0000-0000-0000-000000000001'<>'-6' or v->'actual'->'contributions'->0->>'status'<>'cancelled' then raise exception 'Cancelled repayment was charged twice or ordinary remainder lost';end if;
 -- Existing requester/counterpart/admin flow: request/consent have no origins;
 -- one checked approval posts the weighted net and copies immutable snapshots.
 reset role;select current_publication_id into pub from public.duty_months where month='2099-01';
 select id into from_id from public.duty_assignments where publication_id=pub and day='2099-01-14';
 select id into to_id from public.duty_assignments where publication_id=pub and day='2099-01-12';
 select count(*) into events from public.duty_compensation_events;set local role authenticated;
 perform public.duty_request_swap(from_id,to_id,'Reviewed weighted swap',rev);rev:=rev+1;
 reset role;select id into request_id from public.duty_swap_requests where from_duty_id=from_id;
 set local role authenticated;
 perform pg_temp.denied(format('select public.duty_resolve_swap(%L,''approve'',%s)',request_id,rev),'current engineer must accept');
 perform set_config('request.jwt.claim.sub','60000000-0000-0000-0000-000000000002',true);
 perform public.duty_resolve_swap(request_id,'accept',rev);rev:=rev+1;
 reset role;if (select count(*) from public.duty_compensation_events)<>events then raise exception 'Swap request/consent posted a commitment';end if;
 perform set_config('request.jwt.claim.sub','60000000-0000-0000-0000-000000000001',true);set local role authenticated;
 perform public.duty_resolve_swap(request_id,'approve',rev);rev:=rev+1;
 v:=public.duty_compensation('{"kind":"reconcile"}',null,null,rev);
 if v->'actual'->'net'->>'60000000-0000-0000-0000-000000000001'<>'-2' then raise exception 'Weighted swap did not net its transfer once';end if;
 perform pg_temp.denied(format('select public.duty_resolve_swap(%L,''approve'',%s)',request_id,rev),'no longer pending');
 -- Deleting versions cannot delete their source lots or audit history.
 reset role;select count(*) into source_count from public.duty_compensation_events;
 select current_publication_id into pub from public.duty_months where month='2099-01';set local role authenticated;
 perform public.duty_delete_publication(pub,rev);rev:=rev+1;
 v:=public.duty_compensation('{"kind":"reconcile"}',null,null,rev);
 if jsonb_array_length(v->'actual'->'events')<=source_count or v->'actual'->'contributions'->0->>'status'<>'cancelled' then raise exception 'Deletion erased history or resurrected terminal repayment';end if;
 reset role;
end$$;
-- Freeze the server clock in this rolled-back transaction. New API callers
-- cannot access this helper or supply their own instant/earned settlement.
create or replace function duty_private.compensation_now() returns bigint language sql volatile set search_path='' as $$select 4071970800000::bigint$$;
do $$declare s jsonb;rev bigint;before_count bigint;begin
 select revision into rev from public.duty_workspace;set local role authenticated;
 s:=public.duty_compensation('{"kind":"reconcile"}',null,null,rev);
 before_count:=jsonb_array_length(s->'actual'->'events');
 s:=public.duty_compensation('{"kind":"reconcile"}',null,null,(s->>'revision')::bigint);
 if jsonb_array_length(s->'actual'->'events')<>before_count then raise exception 'Repeated lazy reconciliation duplicated events';end if;
 reset role;
end$$;
select 'PASS: compensation authorization, audit privacy/immutability, revisions/fingerprints, retries, exact units, atomic publication rollback, actual/projected accounting, copied/deleted lineage, exclusive reservations and cancelled-repayment classification';
rollback;
