-- Invoked by access.sql. Real PostgreSQL/RLS, synthetic fixtures, full rollback.
begin;
do $$
declare
 manager uuid:=gen_random_uuid(); engineer uuid:=gen_random_uuid(); pending uuid:=gen_random_uuid();
 rev bigint; live uuid; first_version uuid; split boolean; schedule jsonb; expected jsonb; unrelated jsonb; before_failure jsonb;
begin
 if exists(select 1 from public.duty_members) then raise exception 'Requires an empty disposable database'; end if;
 insert into auth.users(id,email) select id,id||'@example.invalid' from unnest(array[manager,engineer,pending]) id;
 insert into public.duty_members(id,email,name,role,status,active)
 select id,id||'@example.invalid','Lifecycle fixture',case when id=manager then 'admin' else 'engineer' end,
 case when id=pending then 'pending' else 'approved' end,id<>pending from unnest(array[manager,engineer,pending]) id;
 insert into public.duty_months(month,deadline) values('2027-12','2027-11-24'),('2028-01','2027-12-24');
 insert into public.duty_assignments(day,end_day,primary_id,title,extra_points) values('2028-01-05','2028-01-06',engineer,'Other month',3);
 insert into public.duty_constraints(member_id,day,kind,note) values(engineer,'2028-01-05','prefer','Private fixture');
 insert into public.duty_swap_requests(month,requester_id,other_id,from_day,from_end_day,to_day,to_end_day)
 values('2028-01',engineer,manager,'2028-01-05','2028-01-06','2028-01-06','2028-01-07');
 select jsonb_build_object('month',(select to_jsonb(m) from public.duty_months m where month='2028-01'),
 'rows',(select jsonb_agg(to_jsonb(a)) from public.duty_assignments a),
 'members',(select jsonb_agg(to_jsonb(m) order by id) from public.duty_members m),
 'constraints',(select jsonb_agg(to_jsonb(c)) from public.duty_constraints c),
 'requests',(select jsonb_agg(to_jsonb(r)) from public.duty_swap_requests r)) into unrelated;
 foreach split in array array[false,true] loop
  -- A complete December owns January 1, for both combined and split weekends.
  update public.duty_months set status='draft' where month='2027-12';
  insert into public.duty_assignments(day,end_day,primary_id,secondary_id,manager_override,title,extra_points)
  select d::date,d::date+case when extract(dow from d)=5 and not(split and d='2027-12-31') then 2 else 1 end,
   manager,case when d='2027-12-31' then engineer end,d='2028-01-01',
   case when d='2028-01-01' then 'Owned Saturday' else '' end,case when d='2028-01-01' then 2 else 0 end
  from generate_series('2027-12-01'::date,'2028-01-01'::date,interval '1 day') d where extract(dow from d)<>6 or(split and d='2028-01-01');
  select jsonb_build_object('team','[]'::jsonb,'months',jsonb_build_object('2027-12',jsonb_build_object('deadline','2027-11-24','status','draft','generated',true)),
   'duties',(select jsonb_agg(to_jsonb(a) order by day) from public.duty_assignments a where publication_id is null and duty_private.duty_owner(day)='2027-12')) into schedule;
  perform set_config('request.jwt.claim.sub',manager::text,true); set local role authenticated;
  select revision into rev from public.duty_workspace;
  -- Missing coverage must roll back the attempted save and publication together.
  begin perform public.duty_save_schedule(jsonb_set(schedule,'{duties}','[]'),rev,'2027-12'); raise exception 'Incomplete publish accepted';
  exception when raise_exception then if sqlerrm='Incomplete publish accepted' then raise; end if; end;
  perform public.duty_save_schedule(schedule,rev,'2027-12');
  select current_publication_id into live from public.duty_months where month='2027-12'; first_version:=live;
  reset role;
  if exists(select 1 from public.duty_assignments where publication_id is null and duty_private.duty_owner(day)='2027-12') then raise exception 'Published month retained working rows'; end if;
  if exists(select 1 from public.duty_assignments where publication_id=live and duty_private.duty_owner(day)<>'2027-12') then raise exception 'Publication copied adjacent ownership'; end if;
  select jsonb_agg(to_jsonb(a)-'id'-'publication_id' order by day) into expected from public.duty_assignments a where publication_id=live;
  set local role authenticated;
  select revision into rev from public.duty_workspace; perform public.duty_restore_publication(live,rev);
  reset role;
  if (select jsonb_agg(to_jsonb(a)-'id'-'publication_id' order by day) from public.duty_assignments a where publication_id is null and duty_private.duty_owner(day)='2027-12') is distinct from expected then raise exception 'Reopen did not copy full version'; end if;
  -- Discard changed coverage, special titles/points, overrides and weekend shape.
  delete from public.duty_assignments where publication_id is null and day in('2027-12-31','2028-01-01');
  insert into public.duty_assignments(day,end_day,primary_id,secondary_id,manager_override,title,extra_points)
  values('2027-12-31',case when split then '2028-01-02'::date else '2028-01-01'::date end,engineer,manager,true,'',0);
  if not split then insert into public.duty_assignments(day,end_day,primary_id,title,extra_points) values('2028-01-01','2028-01-02',engineer,'Discarded Saturday',7); end if;
  update public.duty_assignments set primary_id=engineer,secondary_id=manager,manager_override=true,title='Discarded special',extra_points=9
  where publication_id is null and day='2027-12-06';
  -- Manager sees mutable rows; engineer only sees the unchanged publication.
  perform set_config('request.jwt.claim.sub',engineer::text,true); set local role authenticated;
  if exists(select 1 from public.duty_assignments where publication_id is null or title like 'Discarded%') then raise exception 'Draft leaked to engineer'; end if;
  select revision into rev from public.duty_workspace;
  begin perform public.duty_cancel_draft('2027-12',rev); raise exception 'Engineer cancelled'; exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claim.sub',pending::text,true);
  begin perform public.duty_cancel_draft('2027-12',rev); raise exception 'Pending member cancelled'; exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claim.sub',manager::text,true);
  if not exists(select 1 from public.duty_assignments where publication_id is null and title='Discarded special') then raise exception 'Manager cannot read draft'; end if;
  begin perform public.duty_cancel_draft('2027-12',rev-1); raise exception 'Stale cancellation accepted'; exception when serialization_failure then null; end;
  reset role;
  select jsonb_agg(to_jsonb(a) order by id) into before_failure from public.duty_assignments a;
  create function pg_temp.reject_reopen_copy() returns trigger language plpgsql as 'begin if NEW.publication_id is null then raise exception ''Injected reopen failure''; end if; return NEW; end';
  create trigger reject_reopen_copy before insert on public.duty_assignments for each row execute function pg_temp.reject_reopen_copy();
  set local role authenticated;
  begin perform public.duty_restore_publication(live,rev); raise exception 'Reopen failure injection missed'; exception when raise_exception then if sqlerrm<>'Injected reopen failure' then raise; end if; end;
  reset role; drop trigger reject_reopen_copy on public.duty_assignments; drop function pg_temp.reject_reopen_copy();
  if (select jsonb_agg(to_jsonb(a) order by id) from public.duty_assignments a) is distinct from before_failure or (select revision from public.duty_workspace)<>rev then raise exception 'Failed Reopen erased the existing draft'; end if;
  -- Fail after deleting working rows; status/revision and all deletes must roll back.
  create function pg_temp.reject_month_update() returns trigger language plpgsql as 'begin raise exception ''Injected lifecycle failure''; end';
  create trigger reject_month_update before update on public.duty_months for each row execute function pg_temp.reject_month_update();
  set local role authenticated;
  begin perform public.duty_cancel_draft('2027-12',rev); raise exception 'Failure injection missed'; exception when raise_exception then if sqlerrm<>'Injected lifecycle failure' then raise; end if; end;
  reset role; drop trigger reject_month_update on public.duty_months;
  if (select jsonb_agg(to_jsonb(a) order by id) from public.duty_assignments a) is distinct from before_failure or (select revision from public.duty_workspace)<>rev then raise exception 'Cancellation failure did not roll back'; end if;
  set local role authenticated; perform public.duty_cancel_draft('2027-12',rev); reset role;
  if exists(select 1 from public.duty_assignments where publication_id is null and duty_private.duty_owner(day)='2027-12') then raise exception 'Cancel recreated working rows'; end if;
  if (select status from public.duty_months where month='2027-12')<>'published' or (select current_publication_id from public.duty_months where month='2027-12')<>live or (select revision from public.duty_workspace)<>rev+1 then raise exception 'Cancel changed pointer or revision incorrectly'; end if;
  if (select jsonb_agg(to_jsonb(a)-'id'-'publication_id' order by day) from public.duty_assignments a where publication_id=live) is distinct from expected then raise exception 'Cancel mutated publication'; end if;
  set local role authenticated;
  select revision into rev from public.duty_workspace; perform public.duty_restore_publication(live,rev); reset role;
  if (select jsonb_agg(to_jsonb(a)-'id'-'publication_id' order by day) from public.duty_assignments a where publication_id is null and duty_private.duty_owner(day)='2027-12') is distinct from expected then raise exception 'Discarded changes returned after reopening'; end if;
  update public.duty_assignments set title='New version',extra_points=2,manager_override=true where publication_id is null and day='2027-12-06';
  select jsonb_set(schedule,'{duties}',(select jsonb_agg(to_jsonb(a) order by day) from public.duty_assignments a where publication_id is null and duty_private.duty_owner(day)='2027-12')) into schedule;
  select jsonb_build_object('rows',(select jsonb_agg(to_jsonb(a) order by id) from public.duty_assignments a),
   'publications',(select jsonb_agg(to_jsonb(p) order by id) from public.duty_publications p)) into before_failure;
  create function pg_temp.reject_publication_pointer() returns trigger language plpgsql as 'begin if NEW.current_publication_id is distinct from OLD.current_publication_id then raise exception ''Injected publication failure''; end if; return NEW; end';
  create trigger reject_publication_pointer before update on public.duty_months for each row execute function pg_temp.reject_publication_pointer();
  set local role authenticated;
  select revision into rev from public.duty_workspace;
  begin perform public.duty_save_schedule(schedule,rev,'2027-12'); raise exception 'Publish failure injection missed'; exception when raise_exception then if sqlerrm<>'Injected publication failure' then raise; end if; end;
  reset role; drop trigger reject_publication_pointer on public.duty_months; drop function pg_temp.reject_publication_pointer();
  if (select revision from public.duty_workspace)<>rev or (select current_publication_id from public.duty_months where month='2027-12')<>live or jsonb_build_object(
   'rows',(select jsonb_agg(to_jsonb(a) order by id) from public.duty_assignments a),
   'publications',(select jsonb_agg(to_jsonb(p) order by id) from public.duty_publications p)) is distinct from before_failure then raise exception 'Publish failure partially committed'; end if;
  set local role authenticated;
  select revision into rev from public.duty_workspace; perform public.duty_save_schedule(schedule,rev,'2027-12'); reset role;
  if (select current_publication_id from public.duty_months where month='2027-12')=first_version or not exists(select 1 from public.duty_publications where id=first_version) then raise exception 'Republish destroyed history'; end if;
  if exists(select 1 from public.duty_assignments where publication_id is null and duty_private.duty_owner(day)='2027-12') then raise exception 'Republish retained working rows'; end if;
  if (select jsonb_agg(to_jsonb(a)-'id'-'publication_id' order by day) from public.duty_assignments a where publication_id=first_version) is distinct from expected then raise exception 'Republish changed history'; end if;
  drop function pg_temp.reject_month_update();
 end loop;
 if jsonb_build_object('month',(select to_jsonb(m) from public.duty_months m where month='2028-01'),
 'rows',(select jsonb_agg(to_jsonb(a)) from public.duty_assignments a where publication_id is null),
 'members',(select jsonb_agg(to_jsonb(m) order by id) from public.duty_members m),
 'constraints',(select jsonb_agg(to_jsonb(c)) from public.duty_constraints c),
 'requests',(select jsonb_agg(to_jsonb(r)) from public.duty_swap_requests r)) is distinct from unrelated then raise exception 'Lifecycle changed unrelated data'; end if;
 set local role anon;
 begin perform public.duty_cancel_draft('2027-12',0); raise exception 'Anonymous cancelled'; exception when insufficient_privilege then null; end;
 reset role;
end $$;
select 'PASS: Publish/Reopen/edit/Cancel/Reopen/republish, immutable history, all draft fields, split/combined cross-month ownership, RLS, revisions, rollback and isolation' as result;
rollback;
