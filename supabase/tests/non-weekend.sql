-- Synthetic fixtures only, on an empty disposable LOCAL database. Always rolls back.
-- Non-weekend members (decision 2026-11-01): only an admin sets the standing flag,
-- through the checked RPC; direct writes stay denied and generation facts carry it.
begin;
do $$begin
 if exists(select 1 from auth.users) or exists(select 1 from public.duty_members) then raise exception 'Requires empty disposable LOCAL'; end if;
end$$;
insert into auth.users(id,email,email_confirmed_at,is_anonymous) select
 ('75000000-0000-0000-0000-'||lpad(i::text,12,'0'))::uuid,'non-weekend-test-'||i||'@example.invalid',now(),false from generate_series(1,3) i;
insert into public.duty_members(id,email,name,role,status,active) select id,email,'Fixture',
 case when right(id::text,1)='1' then 'admin' else 'engineer' end,
 case when right(id::text,1)='3' then 'pending' else 'approved' end,true from auth.users;
create function pg_temp.must_fail(command text, pattern text) returns void language plpgsql as $$begin
 begin execute command; exception when others then
  if sqlerrm !~ pattern then raise exception 'Unexpected refusal: %, expected %',sqlerrm,pattern;end if;return;
 end;raise exception 'Unexpected acceptance: %',command;
end$$;
do $$begin
 if exists(select 1 from public.duty_members where no_weekends) then raise exception 'Members take weekends by default'; end if;
end$$;
set local role anon;
select pg_temp.must_fail($c$select public.duty_set_no_weekends('75000000-0000-0000-0000-000000000002',true,0)$c$,'permission denied');
reset role;
set local role authenticated;
-- An engineer can set it neither for a teammate nor for themself.
set local request.jwt.claim.sub='75000000-0000-0000-0000-000000000002';
select pg_temp.must_fail($c$select public.duty_set_no_weekends('75000000-0000-0000-0000-000000000002',true,(select revision from public.duty_workspace))$c$,'Admin access required');
select pg_temp.must_fail($c$select public.duty_set_no_weekends('75000000-0000-0000-0000-000000000001',true,(select revision from public.duty_workspace))$c$,'Admin access required');
select pg_temp.must_fail($c$select duty_private.set_no_weekends('75000000-0000-0000-0000-000000000002',true,(select revision from public.duty_workspace))$c$,'Admin access required');
select pg_temp.must_fail($c$update public.duty_members set no_weekends=true where id='75000000-0000-0000-0000-000000000002'$c$,'permission denied');
-- A pending member's own session has no write either.
set local request.jwt.claim.sub='75000000-0000-0000-0000-000000000003';
select pg_temp.must_fail($c$select public.duty_set_no_weekends('75000000-0000-0000-0000-000000000003',true,(select revision from public.duty_workspace))$c$,'Admin access required');
set local request.jwt.claim.sub='75000000-0000-0000-0000-000000000001';
select pg_temp.must_fail($c$update public.duty_members set no_weekends=true where id='75000000-0000-0000-0000-000000000002'$c$,'permission denied');
select pg_temp.must_fail($c$select public.duty_set_no_weekends('75000000-0000-0000-0000-000000000002',true,-1)$c$,'team data changed');
select pg_temp.must_fail($c$select public.duty_set_no_weekends('75000000-0000-0000-0000-000000000003',true,(select revision from public.duty_workspace))$c$,'Approve this member first');
select pg_temp.must_fail($c$select public.duty_set_no_weekends('75000000-0000-0000-0000-000000000002',null,(select revision from public.duty_workspace))$c$,'Choose whether');
create temp table before_revision as select revision from public.duty_workspace;
select public.duty_set_no_weekends('75000000-0000-0000-0000-000000000002',true,(select revision from public.duty_workspace));
do $$begin
 if (select revision from public.duty_workspace)<>(select revision+1 from before_revision) then raise exception 'Setting must advance the revision'; end if;
 if not (select no_weekends from public.duty_members where id='75000000-0000-0000-0000-000000000002') then raise exception 'Setting not stored'; end if;
 if not public.duty_load()->'members' @> '[{"id":"75000000-0000-0000-0000-000000000002","no_weekends":true}]' then raise exception 'Setting not loaded'; end if;
end$$;
-- Approved teammates read the standing setting, like the rest of the member row.
set local request.jwt.claim.sub='75000000-0000-0000-0000-000000000002';
do $$begin
 if not (select no_weekends from public.duty_members where id='75000000-0000-0000-0000-000000000002') then raise exception 'Member cannot read own setting'; end if;
end$$;
reset role;
do $$declare f jsonb:=duty_private.generation_facts('2026-11');begin
 if not f->'members' @> '[{"id":"75000000-0000-0000-0000-000000000002","noWeekends":true}]'
  or (select count(*) from jsonb_array_elements(f->'members') m where m ? 'noWeekends')<>1 then raise exception 'Generation facts: %',f->'members'; end if;
end$$;
set local role authenticated;
set local request.jwt.claim.sub='75000000-0000-0000-0000-000000000001';
select public.duty_set_no_weekends('75000000-0000-0000-0000-000000000002',false,(select revision from public.duty_workspace));
do $$begin
 if (select no_weekends from public.duty_members where id='75000000-0000-0000-0000-000000000002') then raise exception 'Setting not cleared'; end if;
end$$;
-- A temporary member takes the setting like anyone else, and generation facts carry it.
create temp table temporary_member as select public.duty_add_temporary_member('Visitor',(select revision from public.duty_workspace)) id;
select public.duty_set_no_weekends((select id from temporary_member),true,(select revision from public.duty_workspace));
reset role;
do $$declare f jsonb:=duty_private.generation_facts('2026-11');begin
 if not (select no_weekends and is_temporary from public.duty_members where id=(select id from temporary_member)) then raise exception 'Temporary setting not stored'; end if;
 if not f->'members' @> jsonb_build_array(jsonb_build_object('id',(select id from temporary_member),'noWeekends',true)) then raise exception 'Temporary generation facts: %',f->'members'; end if;
end$$;
rollback;
