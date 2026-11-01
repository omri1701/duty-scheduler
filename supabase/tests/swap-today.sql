-- Real checked RPCs in a rollback transaction. Only the clock expressions in
-- the installed private implementations are frozen; business checks/grants remain.
begin;
create temporary table swap_clock_functions as select pg_get_functiondef(p.oid) definition
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='duty_private' and p.proname in ('validate_swap','reconcile_swaps');
create function pg_temp.swap_clock(instant timestamptz) returns void language plpgsql as $$
declare body text;
begin
 for body in select definition from swap_clock_functions loop
  if position('now()' in body)=0 then raise exception 'Clock injection no longer matches implementation'; end if;
  execute replace(body,'now()',quote_literal(instant)||'::timestamptz');
 end loop;
end $$;
do $$
declare manager uuid:=gen_random_uuid(); engineer uuid:=gen_random_uuid(); counterpart uuid:=gen_random_uuid();
 who uuid; pub uuid; live uuid; a uuid; b uuid; yesterday uuid; friday uuid; request uuid; rev bigint; result text; original jsonb; drafts jsonb;
begin
 if exists(select 1 from public.duty_members) then raise exception 'Run fixtures in an empty development project'; end if;
 insert into auth.users(id,email,email_confirmed_at,is_anonymous,aud,role)
 select id,id||'@example.invalid',now(),false,'authenticated','authenticated' from unnest(array[manager,engineer,counterpart]) id;
 insert into public.duty_members(id,email,name,role,status,active)
 select id,id||'@example.invalid','Today fixture',case when id=manager then 'admin' else 'engineer' end,'approved',true from unnest(array[manager,engineer,counterpart]) id;
 insert into public.duty_months(month,deadline,status) values('2026-10','2026-09-24','published');
 insert into public.duty_assignments(day,end_day,primary_id) values('2026-10-18','2026-10-19',manager);
 select jsonb_agg(to_jsonb(d) order by id) into drafts from public.duty_assignments d where publication_id is null;
 foreach who in array array[manager,engineer] loop
  perform pg_temp.swap_clock('2026-10-18T12:00:00Z');
  update public.duty_months set publication_sequence=publication_sequence+1 where month='2026-10';
  insert into public.duty_publications(month,version,published_by) select month,publication_sequence,manager from public.duty_months where month='2026-10' returning id into pub;
  insert into public.duty_assignments(publication_id,day,end_day,primary_id)
   select pub,d::date,d::date+1,case when d::date='2026-10-19' then counterpart when d::date='2026-10-25' then case when who=manager then engineer else manager end else who end
   from unnest(array['2026-10-16','2026-10-17','2026-10-18','2026-10-19','2026-10-25']::date[]) d;
  update public.duty_months set current_publication_id=pub where month='2026-10';
  select id into a from public.duty_assignments where publication_id=pub and day='2026-10-18';
  select id into b from public.duty_assignments where publication_id=pub and day='2026-10-19';
  select id into yesterday from public.duty_assignments where publication_id=pub and day='2026-10-17';
  select id into friday from public.duty_assignments where publication_id=pub and day='2026-10-16';
  -- Server session is deliberately outside Israel. Explicit Israel date still wins.
  set local timezone='America/Los_Angeles';
  perform pg_temp.swap_clock('2026-10-17T20:59:59Z');
  perform duty_private.validate_swap(yesterday,b,pub);
  perform pg_temp.swap_clock('2026-10-17T21:00:00Z');
  begin perform duty_private.validate_swap(yesterday,b,pub); raise exception 'Yesterday allowed at Israel midnight'; exception when raise_exception then if sqlerrm<>'Choose duties starting today or later' then raise; end if; end;
  perform duty_private.validate_swap(a,b,pub);
  -- A combined duty starting yesterday stays ineligible on its continuing Saturday.
  perform pg_temp.swap_clock('2026-10-16T21:00:00Z');
  delete from public.duty_assignments where id=yesterday;
  update public.duty_assignments set end_day='2026-10-18' where id=friday;
  begin perform duty_private.validate_swap(friday,b,pub); raise exception 'Continuing yesterday weekend allowed'; exception when raise_exception then if sqlerrm<>'Choose duties starting today or later' then raise; end if; end;
  perform pg_temp.swap_clock('2026-10-18T12:00:00Z');
  perform duty_private.validate_swap(a,b,pub);
  perform duty_private.validate_swap(a,(select id from public.duty_assignments where publication_id=pub and day='2026-10-25'),pub);
  perform duty_private.validate_swap(b,(select id from public.duty_assignments where publication_id=pub and day='2026-10-25'),pub);
  select jsonb_agg(to_jsonb(d) order by id) into original from public.duty_assignments d where publication_id=pub;
  perform set_config('request.jwt.claim.sub',who::text,true);set local role authenticated;
  select revision into rev from public.duty_workspace;
  -- Admins may propose for others (swaps.sql); engineers offer only their own duty.
  if who<>manager then
   begin perform public.duty_request_swap(b,a,'Not mine',rev); raise exception 'Nonowner initiated'; exception when insufficient_privilege then null; end;
  end if;
  perform public.duty_request_swap(a,b,'Today after 09:00',rev);
  select id into request from public.duty_swap_requests where requester_id=who and source_publication_id=pub;
  select revision into rev from public.duty_workspace;
  perform set_config('request.jwt.claim.sub',manager::text,true);
  begin perform public.duty_resolve_swap(request,'approve',rev); raise exception 'Consent bypassed'; exception when raise_exception then if sqlerrm<>'Both engineers must accept before admin review' then raise; end if; end;
  perform set_config('request.jwt.claim.sub',counterpart::text,true);
  perform public.duty_resolve_swap(request,'accept',rev);
  select revision into rev from public.duty_workspace;
  perform set_config('request.jwt.claim.sub',manager::text,true);
  perform public.duty_resolve_swap(request,'approve',rev);
  reset role;
  select current_publication_id into live from public.duty_months where month='2026-10';
  if live=pub or (select status from public.duty_swap_requests where id=request)<>'approved' then raise exception 'Today swap did not publish'; end if;
  if (select jsonb_agg(to_jsonb(d) order by id) from public.duty_assignments d where publication_id=pub) is distinct from original then raise exception 'Today approval changed history'; end if;
  if (select jsonb_agg(to_jsonb(d) order by id) from public.duty_assignments d where publication_id is null) is distinct from drafts then raise exception 'Today approval changed draft'; end if;
  select id into a from public.duty_assignments where publication_id=live and day='2026-10-18';
  select id into b from public.duty_assignments where publication_id=live and day='2026-10-19';
  perform set_config('request.jwt.claim.sub',counterpart::text,true);set local role authenticated;
  select revision into rev from public.duty_workspace;perform public.duty_request_swap(a,b,'Expires at midnight',rev);
  select id into request from public.duty_swap_requests where requester_id=counterpart and source_publication_id=live;
  select revision into rev from public.duty_workspace;perform set_config('request.jwt.claim.sub',who::text,true);
  perform public.duty_resolve_swap(request,'accept',rev);
  reset role;perform pg_temp.swap_clock('2026-10-18T21:00:00Z');
  perform set_config('request.jwt.claim.sub',manager::text,true);set local role authenticated;
  select revision into rev from public.duty_workspace;result:=public.duty_resolve_swap(request,'approve',rev);
  if result<>'invalidated' then raise exception 'Expired request approved'; end if;
  reset role;
  if (select current_publication_id from public.duty_months where month='2026-10')<>live then raise exception 'Invalidation changed publication'; end if;
 end loop;
end $$;
select 'PASS: today-inclusive swaps for both roles, after 09:00, Israel midnight, prior-start weekends, consent, immutable drafts/history and expiry invalidation' as result;
rollback;
