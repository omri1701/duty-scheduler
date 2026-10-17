-- Invoked by access.sql in CI. Synthetic identities, rolled back in full.
begin;
do $$
declare
 manager uuid:=gen_random_uuid(); engineer uuid:=gen_random_uuid(); pending uuid:=gen_random_uuid();
 rev bigint; live uuid; latest uuid; split boolean; snapshot jsonb; unchanged jsonb; schedule jsonb; state_before jsonb; row_before public.duty_assignments;
begin
 if exists(select 1 from public.duty_members) then raise exception 'Run fixtures in an empty development project'; end if;
 insert into auth.users(id,email,email_confirmed_at,is_anonymous,aud,role)
 select id,id||'@example.invalid',now(),false,'authenticated','authenticated' from unnest(array[manager,engineer,pending]) id;
 perform set_config('request.jwt.claim.sub',manager::text,true); perform public.duty_join('Cancel manager');
 perform set_config('request.jwt.claim.sub',engineer::text,true); perform public.duty_join('Cancel engineer');
 perform set_config('request.jwt.claim.sub',pending::text,true); perform public.duty_join('Cancel pending');
 update public.duty_members set role=case when id=manager then 'admin' else 'engineer' end,status='approved',active=true where id in(manager,engineer);
 insert into public.duty_months(month,deadline) values('2027-12','2027-11-24');
 perform set_config('request.jwt.claim.sub',manager::text,true); set local role authenticated;
 select revision into rev from public.duty_workspace;
 perform public.duty_save_schedule(jsonb_build_object('team','[]'::jsonb,'months','{}'::jsonb,'duties',jsonb_build_array(
  jsonb_build_object('day','2028-01-01','end_day','2028-01-02','primary_id',manager))),rev);
 reset role;
 if exists(select 1 from public.duty_months where month='2028-01') then raise exception 'Split Saturday created an unrelated January month'; end if;
 insert into public.duty_months(month,deadline) values('2028-01','2027-12-24');
 insert into public.duty_constraints(member_id,day,kind,note) values(engineer,'2028-01-05','prefer','Private fixture');
 foreach split in array array[false,true] loop
  -- Each shape is a full owned December schedule. Split Saturday retains title,
  -- points, secondary cover and override, even though its date is in January.
  delete from public.duty_assignments where publication_id is null;
  insert into public.duty_assignments(day,end_day,primary_id,secondary_id,manager_override,title,extra_points)
  select d::date,d::date+case when extract(dow from d)=5 and not(split and d='2027-12-31') then 2 else 1 end,
   manager,case when d='2027-12-31' then engineer end,d='2028-01-01',
   case when d='2028-01-01' then 'Owned Saturday' else '' end,case when d='2028-01-01' then 2 else 0 end
  from generate_series('2027-12-01'::date,'2028-01-31'::date,interval '1 day') d where extract(dow from d)<>6 or(split and d='2028-01-01');
  select jsonb_build_object('team',(select jsonb_agg(jsonb_build_object('id',id,'color',color,'active',active)) from public.duty_members where status='approved'),
   'months',(select jsonb_object_agg(month,jsonb_build_object('deadline',deadline,'status','draft','generated',true)) from public.duty_months),
   'duties',(select jsonb_agg(to_jsonb(a)) from public.duty_assignments a where publication_id is null)) into schedule;
  perform set_config('request.jwt.claim.sub',manager::text,true); set local role authenticated;
  select revision into rev from public.duty_workspace; perform public.duty_save_schedule(schedule,rev,'2027-12');
  select current_publication_id into live from public.duty_months where month='2027-12';
  reset role;
  if exists(select 1 from public.duty_assignments where publication_id=live and duty_private.duty_owner(day)<>'2027-12') then raise exception 'Publication copied a different owner'; end if;
  set local role authenticated;
  select revision into rev from public.duty_workspace; perform public.duty_save_schedule(schedule,rev,'2028-01');
  reset role;
  -- Invert the draft weekend's shape and edit both months independently.
  delete from public.duty_assignments where publication_id is null and day in('2027-12-31','2028-01-01');
  insert into public.duty_assignments(day,end_day,primary_id) values('2027-12-31',case when split then '2028-01-02'::date else '2028-01-01'::date end,engineer);
  if not split then insert into public.duty_assignments(day,end_day,primary_id) values('2028-01-01','2028-01-02',manager); end if;
  update public.duty_assignments set primary_id=engineer where publication_id is null and day='2028-01-05';
  update public.duty_months set status='draft';
  -- A new publication can become current while this working draft is open.
  -- Cancel must use that new pointer, not the version that existed at Reopen.
  update public.duty_months set publication_sequence=publication_sequence+1 where month='2027-12';
  insert into public.duty_publications(month,version,published_by)
   select month,publication_sequence,manager from public.duty_months where month='2027-12' returning id into latest;
  insert into public.duty_assignments(publication_id,day,end_day,primary_id,secondary_id,manager_override,title,extra_points)
   select latest,day,end_day,case when day='2027-12-06' then engineer else primary_id end,secondary_id,manager_override,title,extra_points
   from public.duty_assignments where publication_id=live;
  update public.duty_months set current_publication_id=latest where month='2027-12';
  live:=latest;
  insert into public.duty_swap_requests(month,requester_id,other_id,from_day,from_end_day,to_day,to_end_day)
   values('2028-01',engineer,manager,'2028-01-05','2028-01-06','2028-01-06','2028-01-07') on conflict do nothing;
  select jsonb_agg(to_jsonb(a)-'id'-'publication_id' order by day) into snapshot from public.duty_assignments a where publication_id=live and duty_private.duty_owner(day)='2027-12';
  select jsonb_build_object('rows',(select jsonb_agg(to_jsonb(a) order by id) from public.duty_assignments a where publication_id is not null or duty_private.duty_owner(day)<>'2027-12'),
   'months',(select jsonb_agg(to_jsonb(m) order by month) from public.duty_months m where month<>'2027-12'),
   'history',(select jsonb_agg(to_jsonb(p) order by id) from public.duty_publications p),
   'members',(select jsonb_agg(to_jsonb(m) order by id) from public.duty_members m),
   'notes',(select jsonb_agg(to_jsonb(c) order by day) from public.duty_constraints c),
   'requests',(select jsonb_agg(to_jsonb(r) order by id) from public.duty_swap_requests r)) into unchanged;
  select revision into rev from public.duty_workspace;
  foreach live in array array[engineer,pending] loop
   perform set_config('request.jwt.claim.sub',live::text,true); set local role authenticated;
   begin perform public.duty_cancel_draft('2027-12',rev); raise exception 'Nonmanager cancelled'; exception when insufficient_privilege then null; end;
   reset role;
  end loop;
  perform set_config('request.jwt.claim.sub',manager::text,true); set local role authenticated;
  begin perform public.duty_cancel_draft('2027-12',rev-1); raise exception 'Stale cancellation succeeded'; exception when serialization_failure then null; end;
  reset role;
  update public.duty_members set active=false where id=manager;
  set local role authenticated;
  begin perform public.duty_cancel_draft('2027-12',rev); raise exception 'Inactive manager cancelled'; exception when insufficient_privilege then null; end;
  reset role;
  update public.duty_members set active=true where id=manager;
  -- A malformed historical snapshot must fail before touching the working rows.
  select * into row_before from public.duty_assignments where publication_id=latest and day='2027-12-06';
  delete from public.duty_assignments where id=row_before.id;
  select jsonb_agg(to_jsonb(a) order by id) into state_before from public.duty_assignments a where publication_id is null;
  set local role authenticated;
  begin perform public.duty_cancel_draft('2027-12',rev); raise exception 'Incomplete snapshot restored'; exception when raise_exception then if sqlerrm not like 'Published coverage is inconsistent on 2027-12-06%' then raise; end if; end;
  reset role;
  if (select jsonb_agg(to_jsonb(a) order by id) from public.duty_assignments a where publication_id is null) is distinct from state_before or (select revision from public.duty_workspace)<>rev then raise exception 'Incomplete restore wrote data'; end if;
  insert into public.duty_assignments(id,publication_id,day,end_day,primary_id,secondary_id,manager_override,title,extra_points)
   values(row_before.id,row_before.publication_id,row_before.day,row_before.end_day,row_before.primary_id,row_before.secondary_id,row_before.manager_override,row_before.title,row_before.extra_points);
  -- Inject a failure after deletes: PostgreSQL must roll back the entire operation.
  reset role;
  select jsonb_agg(to_jsonb(a) order by id) into state_before from public.duty_assignments a;
  create function pg_temp.reject_cancel_insert() returns trigger language plpgsql as 'begin raise exception ''Injected cancellation failure''; end';
  create trigger reject_cancel_insert before insert on public.duty_assignments for each row execute function pg_temp.reject_cancel_insert();
  set local role authenticated;
  begin perform public.duty_cancel_draft('2027-12',rev); raise exception 'Failure injection did not run'; exception when raise_exception then if sqlerrm<>'Injected cancellation failure' then raise; end if; end;
  reset role; drop trigger reject_cancel_insert on public.duty_assignments; drop function pg_temp.reject_cancel_insert();
  if (select jsonb_agg(to_jsonb(a) order by id) from public.duty_assignments a) is distinct from state_before or (select revision from public.duty_workspace)<>rev then raise exception 'Failed cancel was not rolled back'; end if;
  set local role authenticated;
  perform public.duty_cancel_draft('2027-12',rev);
  reset role;
  if (select jsonb_agg(to_jsonb(a)-'id'-'publication_id' order by day) from public.duty_assignments a where publication_id is null and duty_private.duty_owner(day)='2027-12') is distinct from snapshot then raise exception 'Cancellation lost published fields or weekend shape'; end if;
  if (select status from public.duty_months where month='2027-12')<>'published' or (select revision from public.duty_workspace)<>rev+1 then raise exception 'Cancellation did not finalize once'; end if;
  if jsonb_build_object('rows',(select jsonb_agg(to_jsonb(a) order by id) from public.duty_assignments a where publication_id is not null or duty_private.duty_owner(day)<>'2027-12'),
   'months',(select jsonb_agg(to_jsonb(m) order by month) from public.duty_months m where month<>'2027-12'),
   'history',(select jsonb_agg(to_jsonb(p) order by id) from public.duty_publications p),
   'members',(select jsonb_agg(to_jsonb(m) order by id) from public.duty_members m),
   'notes',(select jsonb_agg(to_jsonb(c) order by day) from public.duty_constraints c),
   'requests',(select jsonb_agg(to_jsonb(r) order by id) from public.duty_swap_requests r)) is distinct from unchanged then raise exception 'Cancellation altered unrelated data or history'; end if;
  set local role authenticated;
  begin perform public.duty_cancel_draft('2027-12',rev+1); raise exception 'Published month cancelled'; exception when raise_exception then if sqlerrm='Published month cancelled' then raise; end if; end;
  reset role;
 end loop;
 set local role anon;
 begin perform public.duty_cancel_draft('2027-12',0); raise exception 'Anonymous cancelled'; exception when insufficient_privilege then null; end;
 reset role;
end $$;
select 'PASS: atomic Cancel Draft, split/combined December ownership, authorization, revisions, rollback, history and month isolation' as result;
rollback;
