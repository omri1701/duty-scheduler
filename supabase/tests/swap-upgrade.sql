-- EMPTY local/development DB only. Rebuild only the swap feature inside a
-- rollback transaction to exercise the actual v1 -> v2 migration with data.
\set ON_ERROR_STOP on
begin;
do $$ begin
 if exists(select 1 from public.duty_members) then raise exception 'Requires an empty development database'; end if;
end $$;
drop trigger duty_reconcile_publication_swaps on public.duty_months;
drop function duty_private.reconcile_publication_swaps(),duty_private.reconcile_swaps(text);
drop function public.duty_load(),public.duty_request_swap(uuid,uuid,text,bigint),public.duty_resolve_swap(uuid,text,bigint,text);
drop function duty_private.request_swap(uuid,uuid,text,bigint),duty_private.resolve_swap(uuid,text,bigint,text),
 duty_private.validate_swap(uuid,uuid,uuid,boolean),duty_private.current_duties(),duty_private.duty_owner(date);
drop table public.duty_swap_requests;
\ir ../migrations/20261009145431_published_duty_swaps.sql

insert into auth.users(id,email,email_confirmed_at,is_anonymous,aud,role)
select id, id||'@example.invalid',now(),false,'authenticated','authenticated'
from unnest(array['40000000-0000-0000-0000-000000000001'::uuid,'40000000-0000-0000-0000-000000000002'::uuid,
 '40000000-0000-0000-0000-000000000003'::uuid,'40000000-0000-0000-0000-000000000004'::uuid]) id;
insert into public.duty_members(id,email,name,role,status,active)
select id,email,'Legacy '||right(id::text,1),case when right(id::text,1)='1' then 'admin' else 'engineer' end,'approved',true from auth.users;
insert into public.duty_months(month,deadline,status,publication_sequence) values('2097-11','2097-10-25','published',2);
insert into public.duty_publications(month,version,published_by)
select '2097-11',version,'40000000-0000-0000-0000-000000000001' from generate_series(1,2) version;
insert into public.duty_assignments(publication_id,day,end_day,primary_id)
select p.id,v.day::date,v.day::date+1,
 case when v.day='2097-11-04' and p.version=2 then '40000000-0000-0000-0000-000000000004'::uuid else v.owner::uuid end
from public.duty_publications p cross join (values
 ('2097-11-03','40000000-0000-0000-0000-000000000002'),('2097-11-04','40000000-0000-0000-0000-000000000003')) v(day,owner);
update public.duty_months set current_publication_id=(select id from public.duty_publications where version=2) where month='2097-11';
-- Both versions originally permitted pending requests for the same slot pair.
insert into public.duty_swap_requests(month,source_publication_id,from_duty_id,to_duty_id,requester_id,other_id,
 from_day,from_end_day,to_day,to_end_day,explanation,status,created_at,resolved_at,resolved_by,result_publication_id,override_reason)
select '2097-11',p.id,a.id,b.id,'40000000-0000-0000-0000-000000000002','40000000-0000-0000-0000-000000000003',
 a.day,a.end_day,b.day,b.end_day,'pending version '||p.version,'pending',now()+p.version*interval '1 second',null,null,null,''
from public.duty_publications p join public.duty_assignments a on a.publication_id=p.id and a.day='2097-11-03'
 join public.duty_assignments b on b.publication_id=p.id and b.day='2097-11-04';
insert into public.duty_swap_requests(month,source_publication_id,from_duty_id,to_duty_id,requester_id,other_id,
 from_day,from_end_day,to_day,to_end_day,explanation,status,created_at,resolved_at,resolved_by,result_publication_id,override_reason)
select '2097-11',p.id,a.id,b.id,'40000000-0000-0000-0000-000000000002','40000000-0000-0000-0000-000000000003',
 a.day,a.end_day,b.day,b.end_day,'historical '||v.status,v.status,now(),now(),p.published_by,p.id,'Legacy audit reason'
from public.duty_publications p join public.duty_assignments a on a.publication_id=p.id and a.day='2097-11-03'
 join public.duty_assignments b on b.publication_id=p.id and b.day='2097-11-04'
 cross join (values ('approved'),('rejected'),('cancelled')) v(status) where p.version=1;
create temp table expected_legacy_history as select to_jsonb(r) as row from public.duty_swap_requests r where status<>'pending';
create temp table expected_legacy_duties as select to_jsonb(a) as row from public.duty_assignments a;
\ir ../migrations/20261009161959_swap_consent_and_reassignment.sql
do $$ begin
 if not exists(select 1 from public.duty_swap_requests where explanation='pending version 1' and status='invalidated') then raise exception 'Old duplicate not invalidated'; end if;
 if not exists(select 1 from public.duty_swap_requests where explanation='pending version 2' and status='awaiting_engineer'
  and other_id='40000000-0000-0000-0000-000000000004' and accepted_by is null and accepted_at is null) then raise exception 'Newest legacy request not retargeted without consent'; end if;
 if exists(select 1 from expected_legacy_history e where not exists(select 1 from public.duty_swap_requests r
  where to_jsonb(r)-'accepted_by'-'accepted_at'=e.row)) then raise exception 'Legacy resolution history modified'; end if;
 if exists(select 1 from expected_legacy_duties e where not exists(select 1 from public.duty_assignments a where to_jsonb(a)=e.row)) then raise exception 'Legacy publication duties changed'; end if;
end $$;
rollback;
