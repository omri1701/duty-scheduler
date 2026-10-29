-- Synthetic fixtures only, on an empty disposable LOCAL database. Always rolls back.
begin;
do $$begin
 if exists(select 1 from auth.users) or exists(select 1 from public.duty_members) then raise exception 'Requires empty disposable LOCAL'; end if;
end$$;
insert into auth.users(id,email,email_confirmed_at,is_anonymous) select
 ('74000000-0000-0000-0000-'||lpad(i::text,12,'0'))::uuid,'temporary-test-'||i||'@example.invalid',now(),false from generate_series(1,5) i;
insert into public.duty_members(id,email,name,role,status,active) select id,email,'Fixture',
 case when right(id::text,1)='1' then 'admin' else 'engineer' end,
 case when right(id::text,1)='4' then 'pending' else 'approved' end,
 right(id::text,1) not in ('3','4') from auth.users where right(id::text,1)<>'5';
create function pg_temp.must_fail(command text, pattern text) returns void language plpgsql as $$begin
 begin execute command; exception when others then
  if sqlerrm !~ pattern then raise exception 'Unexpected refusal: %, expected %',sqlerrm,pattern;end if;return;
 end;raise exception 'Unexpected acceptance: %',command;
end$$;
set local role anon;
select pg_temp.must_fail($c$select public.duty_add_temporary_member('Denied',0)$c$,'permission denied');
reset role;
set local role authenticated;
do $$declare actor uuid;begin
 foreach actor in array array['74000000-0000-0000-0000-000000000002'::uuid,'74000000-0000-0000-0000-000000000003','74000000-0000-0000-0000-000000000004'] loop
  perform set_config('request.jwt.claim.sub',actor::text,true);
  perform pg_temp.must_fail('select public.duty_add_temporary_member(''Denied'',0)','Admin access required');
  perform pg_temp.must_fail('select public.duty_rename_temporary_member('''||actor||''',''Denied'',0)','Admin access required');
 end loop;
end$$;
set local request.jwt.claim.sub='74000000-0000-0000-0000-000000000001';
select pg_temp.must_fail($c$select public.duty_add_temporary_member('Stale',-1)$c$,'team data changed');
select pg_temp.must_fail($c$select public.duty_add_temporary_member('  ',(select revision from public.duty_workspace))$c$,'name between');
select pg_temp.must_fail($c$select public.duty_add_temporary_member(repeat('x',81),(select revision from public.duty_workspace))$c$,'name between');
create temp table created(id uuid);
insert into created select public.duty_add_temporary_member('  Temporary engineer  ',(select revision from public.duty_workspace));
-- The 15-color palette is appended: earlier slots keep their colors, then it wraps.
do $$declare i int;begin
 for i in 1..11 loop perform public.duty_add_temporary_member('Palette '||i,(select revision from public.duty_workspace));end loop;
 if (select color from public.duty_members where id=(select id from created))<>'#e9a2aa'
  or array(select color from public.duty_members where name like 'Palette %' order by seniority)<>array['#e7d88f','#dfb4d2','#c1cf98','#94cad7','#cfb39b','#b1c1ca','#aaa8d9','#dbb677','#f1c3ba','#a5dfac','#adc9ee']
 then raise exception 'Member palette changed';end if;
end$$;
select public.duty_rename_temporary_member((select id from created),'Renamed',(select revision from public.duty_workspace));
select public.duty_set_constraints((select id from created),array['2026-11-05'::date],'no','Private temporary note',(select revision from public.duty_workspace));
select pg_temp.must_fail($c$select public.duty_rename_temporary_member('74000000-0000-0000-0000-000000000002','Changed',(select revision from public.duty_workspace))$c$,'Temporary member required');
select pg_temp.must_fail($c$select public.duty_set_role((select id from created),'admin',(select revision from public.duty_workspace))$c$,'duty_members_identity_check');
select pg_temp.must_fail($c$update public.duty_members set active=false where id=(select id from created)$c$,'permission denied');
select pg_temp.must_fail($c$delete from public.duty_members where id=(select id from created)$c$,'permission denied');
set local request.jwt.claim.sub='74000000-0000-0000-0000-000000000002';
select pg_temp.must_fail($c$select public.duty_rename_temporary_member((select id from created),'Attack',(select revision from public.duty_workspace))$c$,'Admin access required');
select pg_temp.must_fail($c$select public.duty_set_constraints((select id from created),array['2026-11-05'::date],'clear','',(select revision from public.duty_workspace))$c$,'Not allowed');
do $$begin
 if exists(select 1 from public.duty_constraints where note='Private temporary note') then raise exception 'Private note leaked';end if;
end$$;
-- Even a forged UID equal to a temporary ID has no member authority/binding.
select set_config('request.jwt.claim.sub',(select id::text from created),true);
select pg_temp.must_fail($c$select public.duty_rename_self('Attack',(select revision from public.duty_workspace))$c$,'membership is not approved');
select pg_temp.must_fail($c$select public.duty_set_constraints((select id from created),array['2026-11-05'::date],'clear','',0)$c$,'membership is not approved');
select pg_temp.must_fail($c$select public.duty_join('Attack')$c$,'verified account');
-- Regular verified account onboarding remains pending and Auth-backed.
set local request.jwt.claim.sub='74000000-0000-0000-0000-000000000005';
select public.duty_join('New Google member');
reset role;
do $$begin
 if (select count(*) from auth.users)<>5 or exists(select 1 from auth.identities) then raise exception 'Temporary creation invented Auth data';end if;
 if not exists(select 1 from public.duty_members where id=(select id from created) and name='Renamed' and is_temporary and email is null and auth_user_id is null and active and status='approved' and role='engineer') then raise exception 'Temporary identity changed';end if;
 if not exists(select 1 from public.duty_members where id='74000000-0000-0000-0000-000000000005' and auth_user_id=id and not is_temporary and status='pending' and not active) then raise exception 'Registration changed';end if;
end$$;
select pg_temp.must_fail($c$insert into public.duty_members(id,email,name) values(gen_random_uuid(),'orphan@example.invalid','Orphan')$c$,'duty_members_id_fkey');
select pg_temp.must_fail($c$update public.duty_members set email='fake@example.invalid' where id=(select id from created)$c$,'duty_members_identity_check');
select pg_temp.must_fail($c$delete from auth.users where id='74000000-0000-0000-0000-000000000002'$c$,'duty_members_id_fkey');
rollback;
