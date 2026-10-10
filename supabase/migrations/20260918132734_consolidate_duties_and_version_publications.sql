-- The project has no real schedule yet. Refuse to discard any unexpected data.
do $$ begin
 if exists(select 1 from public.duty_assignments) or exists(select 1 from public.duty_publications) or exists(select 1 from public.duty_specials) or exists(select 1 from public.duty_split_weekends) then
  raise exception 'Existing schedules need a data migration before this schema upgrade';
 end if;
end $$;

-- Small domain tables provide actual foreign keys for every role/status/type.
create table public.duty_roles(code text primary key,label text not null,can_manage boolean not null default false);
insert into public.duty_roles values('engineer','Engineer',false),('admin','Admin',true);
create table public.duty_member_statuses(code text primary key,label text not null);
insert into public.duty_member_statuses values('pending','Pending approval'),('approved','Approved'),('rejected','Declined');
create table public.duty_month_statuses(code text primary key,label text not null);
insert into public.duty_month_statuses values('draft','Draft'),('published','Published');
create table public.duty_constraint_types(code text primary key,label text not null);
insert into public.duty_constraint_types values('no','Unavailable'),('prefer','Prefer duty');

drop index public.duty_single_manager;
alter table public.duty_members drop constraint duty_members_role_check,drop constraint duty_members_status_check,drop constraint duty_members_check;
update public.duty_members set role='admin' where role='manager';
alter table public.duty_members add foreign key(role) references public.duty_roles(code),add foreign key(status) references public.duty_member_statuses(code);
-- Historical member references must survive deactivation. Auth deletion cannot cascade.
alter table public.duty_members drop constraint duty_members_id_fkey,add foreign key(id) references auth.users(id) on delete restrict;
alter table public.duty_months drop constraint duty_months_status_check,add foreign key(status) references public.duty_month_statuses(code);
alter table public.duty_constraints drop constraint duty_constraints_kind_check,add foreign key(kind) references public.duty_constraint_types(code);
create index duty_members_role on public.duty_members(role);
create index duty_members_status on public.duty_members(status);
create index duty_months_status on public.duty_months(status);
create index duty_constraints_kind on public.duty_constraints(kind);

create or replace function duty_private.is_manager() returns boolean language sql stable security definer set search_path='' as $$
 select auth.uid() is not null and exists(select 1 from public.duty_members m join public.duty_roles r on r.code=m.role where m.id=auth.uid() and r.can_manage and m.status='approved' and m.active)
$$;
create or replace function duty_private.join_team(p_name text) returns void language plpgsql security definer set search_path='' as $$
declare u auth.users; added integer;
begin
 if auth.uid() is null then raise exception 'Sign in first' using errcode='42501'; end if;
 select * into u from auth.users where id=auth.uid() and email_confirmed_at is not null and not is_anonymous;
 if u.id is null then raise exception 'A verified account is required' using errcode='42501'; end if;
 perform 1 from public.duty_workspace where id for update;
 insert into public.duty_members(id,email,name,seniority,color)
 values(u.id,lower(u.email),left(coalesce(nullif(trim(p_name),''),split_part(u.email,'@',1)),80),(select coalesce(max(seniority),0)+1 from public.duty_members),(array['#adc9ee','#f0ba95','#c9b1de','#9bcfbe','#e9a2aa','#e7d88f','#dfb4d2','#c1cf98','#94cad7','#cfb39b','#b1c1ca','#aaa8d9'])[(select count(*)::int%12+1 from public.duty_members)]) on conflict(id) do nothing;
 get diagnostics added=row_count;
 if added>0 then update public.duty_workspace set revision=revision+1 where id; end if;
end $$;
drop table duty_private.manager_identity;

-- Versions have stable IDs, a per-month sequence, and a current-publication pointer.
alter table public.duty_publications drop column payload,drop constraint duty_publications_pkey;
alter table public.duty_publications add column id uuid primary key default gen_random_uuid(),add column version integer not null check(version>0),add unique(month,version),add unique(month,id);
alter table public.duty_months add column current_publication_id uuid,add column publication_sequence integer not null default 0;
alter table public.duty_months add foreign key(month,current_publication_id) references public.duty_publications(month,id);
create index duty_months_publication on public.duty_months(current_publication_id);

-- Draft and published duties share one table; NULL publication_id means draft.
alter table public.duty_assignments drop constraint duty_assignments_pkey;
alter table public.duty_assignments add column id uuid primary key default gen_random_uuid(),add column publication_id uuid references public.duty_publications(id) on delete cascade,add column end_day date not null,add column title text not null default '' check(length(title)<=60),add column extra_points numeric not null default 0 check(extra_points between 0 and 20);
alter table public.duty_assignments add constraint duty_assignment_span check(end_day=day+1 or (extract(dow from day)=5 and end_day=day+2 and extra_points=0 and title=''));
alter table public.duty_assignments add column points numeric generated always as ((case when end_day=day+2 then 1 when extract(dow from day) in (5,6) then 0.5 else 1 end)+extra_points) stored;
create unique index duty_assignment_version_day on public.duty_assignments(publication_id,day) nulls not distinct;

-- Replace old split/range bookkeeping with the duty row's actual dates/points.
drop function public.duty_load();
drop function duty_private.month_days(text);
drop function duty_private.assignment_day(date);
drop table public.duty_specials;
drop table public.duty_split_weekends;

drop policy assignments_read on public.duty_assignments;
create policy assignments_read on public.duty_assignments for select to authenticated using((select duty_private.is_manager()) or ((select duty_private.is_member()) and publication_id is not null and exists(select 1 from public.duty_months m where m.current_publication_id=publication_id)));
drop policy publications_read on public.duty_publications;
create policy publications_read on public.duty_publications for select to authenticated using((select duty_private.is_manager()) or ((select duty_private.is_member()) and exists(select 1 from public.duty_months m where m.current_publication_id=id)));

alter table public.duty_roles enable row level security;
alter table public.duty_member_statuses enable row level security;
alter table public.duty_month_statuses enable row level security;
alter table public.duty_constraint_types enable row level security;
revoke all on public.duty_roles,public.duty_member_statuses,public.duty_month_statuses,public.duty_constraint_types from anon,authenticated;
grant select on public.duty_roles,public.duty_member_statuses,public.duty_month_statuses,public.duty_constraint_types to authenticated;
create policy roles_read on public.duty_roles for select to authenticated using(true);
create policy member_statuses_read on public.duty_member_statuses for select to authenticated using(true);
create policy month_statuses_read on public.duty_month_statuses for select to authenticated using(true);
create policy constraint_types_read on public.duty_constraint_types for select to authenticated using(true);

create function duty_private.assert_admin_remains() returns void language plpgsql security invoker set search_path='' as $$
begin
 if not exists(select 1 from public.duty_members m join public.duty_roles r on r.code=m.role where m.active and m.status='approved' and r.can_manage) then raise exception 'Keep at least one active admin'; end if;
end $$;
create function duty_private.set_role(p_member uuid,p_role text,p_revision bigint) returns void language plpgsql security definer set search_path='' as $$
begin
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 perform duty_private.check_revision(p_revision);
 update public.duty_members set role=p_role where id=p_member and status='approved';
 if not found then raise exception 'Approve this member first'; end if;
 perform duty_private.assert_admin_remains();
 update public.duty_workspace set revision=revision+1 where id;
end $$;
create function duty_private.rename_self(p_name text,p_revision bigint) returns void language plpgsql security definer set search_path='' as $$
begin
 perform duty_private.check_revision(p_revision);
 if length(trim(coalesce(p_name,''))) not between 1 and 80 then raise exception 'Use a name between 1 and 80 characters'; end if;
 update public.duty_members set name=trim(p_name) where id=auth.uid();
 update public.duty_workspace set revision=revision+1 where id;
end $$;
create or replace function duty_private.review_member(p_member uuid,p_status text,p_revision bigint) returns void language plpgsql security definer set search_path='' as $$
begin
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 perform duty_private.check_revision(p_revision);
 if p_status not in ('approved','rejected') or p_status is null then raise exception 'Invalid review'; end if;
 update public.duty_members set status=p_status,active=(p_status='approved'),seniority=(select coalesce(max(seniority),0)+1 from public.duty_members) where id=p_member and role='engineer' and status='pending';
 if not found then raise exception 'This request is no longer pending'; end if;
 update public.duty_workspace set revision=revision+1 where id;
end $$;

create or replace function duty_private.save_schedule(p_state jsonb,p_revision bigint,p_publish text default null) returns void language plpgsql security definer set search_path='' as $$
declare x record; item jsonb; d date; a public.duty_assignments; first_day date; last_day date; publication uuid; next_version integer;
begin
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 perform duty_private.check_revision(p_revision);
 if jsonb_typeof(p_state->'duties') is distinct from 'array' or jsonb_typeof(p_state->'months') is distinct from 'object' or jsonb_typeof(p_state->'team') is distinct from 'array' or length(p_state::text)>2000000 then raise exception 'Invalid schedule'; end if;
 for x in select value,ordinality from jsonb_array_elements(p_state->'team') with ordinality loop
  -- Profile names and roles have separate checked operations.
  update public.duty_members set color=x.value->>'color',active=(x.value->>'active')::boolean,seniority=x.ordinality where id=(x.value->>'id')::uuid and status='approved';
  if not found then raise exception 'Unknown approved team member'; end if;
 end loop;
 perform duty_private.assert_admin_remains();
 for x in select * from jsonb_each(p_state->'months') loop
  insert into public.duty_months(month,deadline,status,generated) values(x.key,(x.value->>'deadline')::date,case when x.value->>'status'='published' and exists(select 1 from public.duty_months where month=x.key and current_publication_id is not null) then 'published' else 'draft' end,coalesce((x.value->>'generated')::boolean,false))
  on conflict(month) do update set deadline=excluded.deadline,status=excluded.status,generated=excluded.generated;
 end loop;
 delete from public.duty_assignments where publication_id is null and day not in (select (value->>'day')::date from jsonb_array_elements(p_state->'duties'));
 for item in select value from jsonb_array_elements(p_state->'duties') loop
  if not exists(select 1 from public.duty_months where month=to_char((item->>'day')::date,'YYYY-MM')) then
   insert into public.duty_months(month,deadline) values(to_char((item->>'day')::date,'YYYY-MM'),date_trunc('month',(item->>'day')::date)::date-7);
  end if;
  insert into public.duty_assignments(day,end_day,primary_id,secondary_id,manager_override,title,extra_points)
  values((item->>'day')::date,(item->>'end_day')::date,nullif(item->>'primary_id','')::uuid,nullif(item->>'secondary_id','')::uuid,coalesce((item->>'manager_override')::boolean,false),coalesce(item->>'title',''),coalesce((item->>'extra_points')::numeric,0))
  on conflict(publication_id,day) do update set end_day=excluded.end_day,primary_id=excluded.primary_id,secondary_id=excluded.secondary_id,manager_override=excluded.manager_override,title=excluded.title,extra_points=excluded.extra_points;
 end loop;
 if exists(select 1 from public.duty_assignments first_duty join public.duty_assignments other_duty on first_duty.day<other_duty.day and first_duty.end_day>other_duty.day where first_duty.publication_id is null and other_duty.publication_id is null) then raise exception 'Duty dates overlap'; end if;
 if p_publish is not null then
  if not exists(select 1 from public.duty_months where month=p_publish) then raise exception 'Unknown month'; end if;
  first_day:=(p_publish||'-01')::date; last_day:=(first_day+interval '1 month'-interval '1 day')::date;
  -- Validate an entire carried combined weekend; a split prior Friday is separate.
  if exists(select 1 from public.duty_assignments where publication_id is null and day=first_day-1 and end_day=first_day+1) then first_day:=first_day-1; end if;
  if extract(dow from last_day)=5 then last_day:=last_day+1; end if;
  for d in select generate_series(first_day,last_day,interval '1 day')::date loop
   select * into a from public.duty_assignments where publication_id is null and day<=d and end_day>d;
   if a.primary_id is null or not exists(select 1 from public.duty_members where id=a.primary_id and status='approved' and active) then raise exception 'An active engineer is required on %',d; end if;
   if a.secondary_id is not null and not exists(select 1 from public.duty_members where id=a.secondary_id and status='approved' and active) then raise exception 'Emergency engineer is inactive on %',d; end if;
   if not a.manager_override and exists(select 1 from public.duty_constraints where member_id in (a.primary_id,a.secondary_id) and day=d and kind='no') then raise exception 'Availability conflict on %',d; end if;
  end loop;
  update public.duty_months set publication_sequence=publication_sequence+1 where month=p_publish returning publication_sequence into next_version;
  insert into public.duty_publications(month,version,published_by) values(p_publish,next_version,auth.uid()) returning id into publication;
  insert into public.duty_assignments(publication_id,day,end_day,primary_id,secondary_id,manager_override,title,extra_points)
  select publication,day,end_day,primary_id,secondary_id,manager_override,title,extra_points from public.duty_assignments where publication_id is null and day<=last_day and end_day>first_day;
  update public.duty_months set current_publication_id=publication,status='published',generated=true where month=p_publish;
 end if;
 update public.duty_workspace set revision=revision+1 where id;
end $$;

create function duty_private.restore_publication(p_publication uuid,p_revision bigint) returns void language plpgsql security definer set search_path='' as $$
declare v public.duty_publications; first_day date; last_day date;
begin
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 perform duty_private.check_revision(p_revision);
 select * into v from public.duty_publications where id=p_publication;
 if v.id is null then raise exception 'Version no longer exists'; end if;
 select min(day),max(end_day) into first_day,last_day from public.duty_assignments where publication_id=p_publication;
 -- Restoring boundary weekends may also reopen the adjacent month's draft.
 update public.duty_months set status='draft' where (month||'-01')::date<last_day and (month||'-01')::date+interval '1 month'>first_day;
 -- Preserve the Friday half when restoring a version that starts on a split Saturday.
 update public.duty_months set status='draft' where month in (select to_char(day,'YYYY-MM') from public.duty_assignments where publication_id is null and day<first_day and end_day>first_day);
 update public.duty_assignments set end_day=first_day where publication_id is null and day<first_day and end_day>first_day;
 delete from public.duty_assignments where publication_id is null and day<last_day and end_day>first_day;
 insert into public.duty_assignments(day,end_day,primary_id,secondary_id,manager_override,title,extra_points)
 select day,end_day,primary_id,secondary_id,manager_override,title,extra_points from public.duty_assignments where publication_id=p_publication;
 update public.duty_months set status='draft',generated=true where month=v.month;
 update public.duty_workspace set revision=revision+1 where id;
end $$;
create function duty_private.delete_publication(p_publication uuid,p_revision bigint) returns void language plpgsql security definer set search_path='' as $$
declare v public.duty_publications; replacement uuid;
begin
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 perform duty_private.check_revision(p_revision);
 select * into v from public.duty_publications where id=p_publication;
 if v.id is null then raise exception 'Version no longer exists'; end if;
 select id into replacement from public.duty_publications where month=v.month and id<>v.id order by version desc limit 1;
 update public.duty_months set current_publication_id=replacement,status=case when replacement is null then 'draft' else status end where current_publication_id=v.id;
 delete from public.duty_publications where id=v.id;
 update public.duty_workspace set revision=revision+1 where id;
end $$;

create function public.duty_load() returns jsonb language sql stable security invoker set search_path='' as $$
 select jsonb_build_object(
 'revision',(select revision from public.duty_workspace where id),
 'members',coalesce((select jsonb_agg(to_jsonb(m) order by seniority,joined_at) from public.duty_members m),'[]'::jsonb),
 'months',coalesce((select jsonb_agg(to_jsonb(m)) from public.duty_months m),'[]'::jsonb),
 'constraints',coalesce((select jsonb_agg(to_jsonb(c)) from public.duty_constraints c),'[]'::jsonb),
 'assignments',coalesce((select jsonb_agg(to_jsonb(a) order by day) from public.duty_assignments a),'[]'::jsonb),
 'publications',coalesce((select jsonb_agg(to_jsonb(p) order by month,version desc) from public.duty_publications p),'[]'::jsonb),
 'roles',(select jsonb_agg(to_jsonb(r) order by code) from public.duty_roles r),
 'memberStatuses',(select jsonb_agg(to_jsonb(s) order by code) from public.duty_member_statuses s),
 'monthStatuses',(select jsonb_agg(to_jsonb(s) order by code) from public.duty_month_statuses s),
 'constraintTypes',(select jsonb_agg(to_jsonb(c) order by code) from public.duty_constraint_types c)
 )
$$;
create function public.duty_set_role(p_member uuid,p_role text,p_revision bigint) returns void language sql security invoker set search_path='' as $$select duty_private.set_role(p_member,p_role,p_revision)$$;
create function public.duty_rename_self(p_name text,p_revision bigint) returns void language sql security invoker set search_path='' as $$select duty_private.rename_self(p_name,p_revision)$$;
create function public.duty_restore_publication(p_publication uuid,p_revision bigint) returns void language sql security invoker set search_path='' as $$select duty_private.restore_publication(p_publication,p_revision)$$;
create function public.duty_delete_publication(p_publication uuid,p_revision bigint) returns void language sql security invoker set search_path='' as $$select duty_private.delete_publication(p_publication,p_revision)$$;
revoke execute on function public.duty_load(),public.duty_set_role(uuid,text,bigint),public.duty_rename_self(text,bigint),public.duty_restore_publication(uuid,bigint),public.duty_delete_publication(uuid,bigint) from public,anon;
grant execute on function public.duty_load(),public.duty_set_role(uuid,text,bigint),public.duty_rename_self(text,bigint),public.duty_restore_publication(uuid,bigint),public.duty_delete_publication(uuid,bigint) to authenticated;
revoke execute on function duty_private.assert_admin_remains(),duty_private.set_role(uuid,text,bigint),duty_private.rename_self(text,bigint),duty_private.restore_publication(uuid,bigint),duty_private.delete_publication(uuid,bigint) from public,anon,authenticated;
grant execute on function duty_private.set_role(uuid,text,bigint),duty_private.rename_self(text,bigint),duty_private.restore_publication(uuid,bigint),duty_private.delete_publication(uuid,bigint) to authenticated;
