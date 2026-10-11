-- Duty Scheduler: one team, one manager. All writes are atomic checked RPCs.
create schema if not exists duty_private;
revoke all on schema duty_private from public, anon;
grant usage on schema duty_private to authenticated;

create table public.duty_members (
 id uuid primary key references auth.users(id) on delete cascade,
 email text not null unique,
 name text not null check (length(trim(name)) between 1 and 80),
 role text not null default 'engineer' check (role in ('manager','engineer')),
 status text not null default 'pending' check (status in ('pending','approved','rejected')),
 active boolean not null default false,
 seniority integer not null default 0 check(seniority>=0),
 color text not null default '#adc9ee' check(color ~ '^#[0-9a-fA-F]{6}$'),
 joined_at timestamptz not null default now(),
 check (role <> 'manager' or (status='approved' and active))
);
create unique index duty_single_manager on public.duty_members(role) where role='manager';
create table public.duty_workspace (id boolean primary key default true check(id), revision bigint not null default 0);
insert into public.duty_workspace(id) values(true);
create table public.duty_months (
 month text primary key check(month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
 deadline date not null, status text not null default 'draft' check(status in ('draft','published')),
 generated boolean not null default false
);
create table public.duty_constraints (
 member_id uuid not null references public.duty_members(id), day date not null,
 kind text not null check(kind in ('no','prefer')), note text not null default '' check(length(note)<=300),
 primary key(member_id,day)
);
create index duty_constraints_day on public.duty_constraints(day);
create table public.duty_specials (
 id uuid primary key, title text not null check(length(title) between 1 and 60),
 start_day date not null, end_day date not null, extra numeric not null check(extra between 0 and 20),
 check(end_day>start_day and end_day-start_day<=14)
);
create table public.duty_split_weekends(friday date primary key check(extract(dow from friday)=5));
create table public.duty_assignments (
 day date primary key,
 primary_id uuid references public.duty_members(id), secondary_id uuid references public.duty_members(id),
 manager_override boolean not null default false,
 check(primary_id is null or primary_id is distinct from secondary_id)
);
create index duty_assignments_primary on public.duty_assignments(primary_id);
create index duty_assignments_secondary on public.duty_assignments(secondary_id);
create table public.duty_publications (
 month text primary key references public.duty_months(month), payload jsonb not null,
 published_at timestamptz not null default now(), published_by uuid not null references public.duty_members(id)
);
create index duty_publications_author on public.duty_publications(published_by);
-- This reservation is configured out of band for a confirmed manager email.
create table duty_private.manager_identity(id boolean primary key default true check(id), email text not null unique);
alter table duty_private.manager_identity enable row level security;
revoke all on duty_private.manager_identity from public, anon, authenticated;

create function duty_private.is_manager() returns boolean language sql stable security definer set search_path='' as $$
 select auth.uid() is not null and exists(select 1 from public.duty_members where id=auth.uid() and role='manager' and status='approved' and active)
$$;
create function duty_private.is_member() returns boolean language sql stable security definer set search_path='' as $$
 select auth.uid() is not null and exists(select 1 from public.duty_members where id=auth.uid() and status='approved' and active)
$$;
revoke all on function duty_private.is_manager(), duty_private.is_member() from public,anon;
grant execute on function duty_private.is_manager(), duty_private.is_member() to authenticated;

alter table public.duty_members enable row level security;
alter table public.duty_workspace enable row level security;
alter table public.duty_months enable row level security;
alter table public.duty_constraints enable row level security;
alter table public.duty_specials enable row level security;
alter table public.duty_split_weekends enable row level security;
alter table public.duty_assignments enable row level security;
alter table public.duty_publications enable row level security;
revoke all on public.duty_members,public.duty_workspace,public.duty_months,public.duty_constraints,public.duty_specials,public.duty_split_weekends,public.duty_assignments,public.duty_publications from anon,authenticated;
grant select on public.duty_members,public.duty_workspace,public.duty_months,public.duty_constraints,public.duty_specials,public.duty_split_weekends,public.duty_assignments,public.duty_publications to authenticated;
create policy members_read on public.duty_members for select to authenticated using(id=(select auth.uid()) or (select duty_private.is_manager()) or (status='approved' and (select duty_private.is_member())));
create policy workspace_read on public.duty_workspace for select to authenticated using((select duty_private.is_member()));
create policy months_read on public.duty_months for select to authenticated using((select duty_private.is_member()));
create policy constraints_read on public.duty_constraints for select to authenticated using((select duty_private.is_manager()) or (member_id=(select auth.uid()) and (select duty_private.is_member())));
create policy specials_read on public.duty_specials for select to authenticated using((select duty_private.is_manager()));
create policy splits_read on public.duty_split_weekends for select to authenticated using((select duty_private.is_manager()));
create policy assignments_read on public.duty_assignments for select to authenticated using((select duty_private.is_manager()));
create policy publications_read on public.duty_publications for select to authenticated using((select duty_private.is_member()));

create function duty_private.join_team(p_name text) returns void language plpgsql security definer set search_path='' as $$
declare u auth.users; manager boolean; added integer; promoted integer:=0;
begin
 if auth.uid() is null then raise exception 'Sign in first' using errcode='42501'; end if;
 select * into u from auth.users where id=auth.uid() and email_confirmed_at is not null and not is_anonymous;
 if u.id is null then raise exception 'A verified account is required' using errcode='42501'; end if;
 select exists(select 1 from duty_private.manager_identity where lower(email)=lower(u.email)) into manager;
 perform 1 from public.duty_workspace where id for update;
 insert into public.duty_members(id,email,name,role,status,active,seniority,color)
 values(u.id,lower(u.email),left(coalesce(nullif(trim(p_name),''),split_part(u.email,'@',1)),80),case when manager then 'manager' else 'engineer' end,case when manager then 'approved' else 'pending' end,manager,(select coalesce(max(seniority),0)+1 from public.duty_members),(array['#adc9ee','#f0ba95','#c9b1de','#9bcfbe','#e9a2aa','#e7d88f','#dfb4d2','#c1cf98','#94cad7','#cfb39b','#b1c1ca','#aaa8d9'])[(select count(*)::int%12+1 from public.duty_members)]) on conflict(id) do nothing;
 get diagnostics added=row_count;
 -- An account that was pending before its verified email was reserved can become manager.
 if manager then update public.duty_members set role='manager',status='approved',active=true where id=u.id and role<>'manager'; get diagnostics promoted=row_count; end if;
 if added+promoted>0 then update public.duty_workspace set revision=revision+1 where id; end if;
end $$;

create function duty_private.check_revision(p_revision bigint) returns void language plpgsql security definer set search_path='' as $$
declare current_revision bigint;
begin
 if not duty_private.is_member() then raise exception 'Your membership is not approved' using errcode='42501'; end if;
 select revision into current_revision from public.duty_workspace where id for update;
 if current_revision is distinct from p_revision then raise exception 'The team data changed. Refresh and try again.' using errcode='40001'; end if;
end $$;

create function duty_private.set_constraints(p_member uuid,p_days date[],p_kind text,p_note text,p_revision bigint) returns void language plpgsql security definer set search_path='' as $$
declare d date; m text; manager boolean;
begin
 perform duty_private.check_revision(p_revision);
 manager:=duty_private.is_manager();
 if (not manager and p_member<>auth.uid()) or not exists(select 1 from public.duty_members where id=p_member and status='approved') then raise exception 'Not allowed' using errcode='42501'; end if;
 if p_kind not in ('no','prefer','clear') or p_kind is null or coalesce(cardinality(p_days),0) not between 1 and 62 or length(coalesce(p_note,''))>300 then raise exception 'Invalid constraints'; end if;
 foreach d in array p_days loop
  if d is null then raise exception 'Invalid date'; end if;
  m:=to_char(d,'YYYY-MM');
  insert into public.duty_months(month,deadline) values(m,date_trunc('month',d)::date-7) on conflict do nothing;
  if not manager and exists(select 1 from public.duty_months where month=m and (status='published' or deadline < (now() at time zone 'Asia/Jerusalem')::date)) then raise exception 'Constraints are closed for this month' using errcode='42501'; end if;
  if p_kind='clear' then delete from public.duty_constraints where member_id=p_member and day=d;
  else insert into public.duty_constraints(member_id,day,kind,note) values(p_member,d,p_kind,trim(coalesce(p_note,''))) on conflict(member_id,day) do update set kind=excluded.kind,note=excluded.note; end if;
  update public.duty_months set status='draft' where month=m;
 end loop;
 update public.duty_workspace set revision=revision+1 where id;
end $$;

create function duty_private.review_member(p_member uuid,p_status text,p_revision bigint) returns void language plpgsql security definer set search_path='' as $$
begin
 if not duty_private.is_manager() then raise exception 'Manager access required' using errcode='42501'; end if;
 perform duty_private.check_revision(p_revision);
 if p_status not in ('approved','rejected') or p_status is null then raise exception 'Invalid status'; end if;
 update public.duty_members set status=p_status,active=(p_status='approved'),seniority=(select coalesce(max(seniority),0)+1 from public.duty_members) where id=p_member and role<>'manager' and status='pending';
 if not found then raise exception 'This request is no longer pending'; end if;
 update public.duty_workspace set revision=revision+1 where id;
end $$;

-- Resolve each calendar date to its primary assignment, including split/special weekends.
create function duty_private.assignment_day(d date) returns date language sql stable security invoker set search_path='' as $$
 select case when extract(dow from d)=6 and not exists(select 1 from public.duty_split_weekends where friday=d-1) and not exists(select 1 from public.duty_specials where start_day<d+1 and end_day>d-1) then d-1 else d end
$$;

create function duty_private.save_schedule(p_state jsonb,p_revision bigint,p_publish text default null) returns void language plpgsql security definer set search_path='' as $$
declare x record; item jsonb; d date; ad date; a public.duty_assignments; payload jsonb;
begin
 if not duty_private.is_manager() then raise exception 'Manager access required' using errcode='42501'; end if;
 perform duty_private.check_revision(p_revision);
 if jsonb_typeof(p_state->'assignments') is distinct from 'object' or jsonb_typeof(p_state->'months') is distinct from 'object' or jsonb_typeof(p_state->'team') is distinct from 'array' or jsonb_typeof(p_state->'specials') is distinct from 'array' or jsonb_typeof(p_state->'splitWeekends') is distinct from 'array' then raise exception 'Invalid schedule'; end if;
 if length(p_state::text)>2000000 then raise exception 'Schedule too large'; end if;
 for x in select value,ordinality from jsonb_array_elements(p_state->'team') with ordinality loop
  update public.duty_members set name=x.value->>'name',color=x.value->>'color',active=case when role='manager' then true else (x.value->>'active')::boolean end,seniority=x.ordinality where id=(x.value->>'id')::uuid and status='approved';
  if not found then raise exception 'Unknown team member'; end if;
 end loop;
 for x in select * from jsonb_each(p_state->'months') loop
  insert into public.duty_months(month,deadline,status,generated) values(x.key,(x.value->>'deadline')::date,case when x.value->>'status'='published' and exists(select 1 from public.duty_publications where month=x.key) then 'published' else 'draft' end,coalesce((x.value->>'generated')::boolean,false))
  on conflict(month) do update set deadline=excluded.deadline,status=excluded.status,generated=excluded.generated;
 end loop;
 delete from public.duty_assignments; delete from public.duty_specials; delete from public.duty_split_weekends;
 for item in select value from jsonb_array_elements(p_state->'specials') loop
  insert into public.duty_specials values((item->>'id')::uuid,item->>'title',(item->>'start')::date,(item->>'end')::date,(item->>'extra')::numeric);
 end loop;
 if exists(select 1 from public.duty_specials a join public.duty_specials b on a.id<b.id and a.start_day<b.end_day and b.start_day<a.end_day) then raise exception 'Special dates overlap'; end if;
 for item in select value from jsonb_array_elements(p_state->'splitWeekends') loop insert into public.duty_split_weekends values((item#>>'{}')::date) on conflict do nothing; end loop;
 for x in select * from jsonb_each(p_state->'assignments') loop
  insert into public.duty_assignments values(x.key::date,nullif(x.value->>'primary','')::uuid,nullif(x.value->>'secondary','')::uuid,coalesce((x.value->>'override')::boolean,false));
 end loop;
 if p_publish is not null then
  if not exists(select 1 from public.duty_months where month=p_publish) then raise exception 'Unknown month'; end if;
  for d in select generate_series((p_publish||'-01')::date-case when extract(dow from (p_publish||'-01')::date)=6 then 1 else 0 end,((p_publish||'-01')::date+interval '1 month'-interval '1 day')::date+case when extract(dow from ((p_publish||'-01')::date+interval '1 month'-interval '1 day')::date)=5 then 1 else 0 end,interval '1 day')::date loop
   ad:=duty_private.assignment_day(d); select * into a from public.duty_assignments where day=ad;
   if a.primary_id is null or not exists(select 1 from public.duty_members where id=a.primary_id and status='approved' and active) then raise exception 'An active engineer is required on %',d; end if;
   if a.secondary_id is not null and not exists(select 1 from public.duty_members where id=a.secondary_id and status='approved' and active) then raise exception 'Emergency engineer is inactive on %',d; end if;
   if not a.manager_override and exists(select 1 from public.duty_constraints where member_id in (a.primary_id,a.secondary_id) and day=d and kind='no') then raise exception 'Availability conflict on %',d; end if;
  end loop;
  -- Keep the last published snapshot while the manager works on a new draft.
  select jsonb_build_object('assignments',coalesce(jsonb_object_agg(day::text,jsonb_strip_nulls(jsonb_build_object('primary',coalesce(primary_id::text,''),'secondary',secondary_id,'override',manager_override))),'{}'::jsonb)) into payload from public.duty_assignments where day in (select duty_private.assignment_day(g::date) from generate_series((p_publish||'-01')::date,((p_publish||'-01')::date+interval '1 month'-interval '1 day')::date,interval '1 day') g) or (extract(dow from day)=6 and to_char(day-1,'YYYY-MM')=p_publish and exists(select 1 from public.duty_split_weekends where friday=day-1));
  payload:=payload||jsonb_build_object('specials',coalesce((select jsonb_agg(jsonb_build_object('id',id,'title',title,'start',start_day,'end',end_day,'extra',extra)) from public.duty_specials where start_day<(p_publish||'-01')::date+interval '1 month'+interval '2 days' and end_day>(p_publish||'-01')::date-2),'[]'::jsonb),'splitWeekends',coalesce((select jsonb_agg(friday::text) from public.duty_split_weekends where friday>=(p_publish||'-01')::date-2 and friday<(p_publish||'-01')::date+interval '1 month'),'[]'::jsonb));
  insert into public.duty_publications(month,payload,published_by) values(p_publish,payload,auth.uid()) on conflict(month) do update set payload=excluded.payload,published_at=now(),published_by=excluded.published_by;
  update public.duty_months set status='published',generated=true where month=p_publish;
 end if;
 update public.duty_workspace set revision=revision+1 where id;
end $$;

-- One statement gives a consistent, RLS-filtered snapshot.
create function public.duty_load() returns jsonb language sql stable security invoker set search_path='' as $$
 select jsonb_build_object(
 'revision',(select revision from public.duty_workspace where id),
 'members',coalesce((select jsonb_agg(to_jsonb(m) order by seniority,joined_at) from public.duty_members m),'[]'::jsonb),
 'months',coalesce((select jsonb_agg(to_jsonb(m)) from public.duty_months m),'[]'::jsonb),
 'constraints',coalesce((select jsonb_agg(to_jsonb(c)) from public.duty_constraints c),'[]'::jsonb),
 'specials',coalesce((select jsonb_agg(to_jsonb(s)) from public.duty_specials s),'[]'::jsonb),
 'splits',coalesce((select jsonb_agg(friday) from public.duty_split_weekends),'[]'::jsonb),
 'assignments',coalesce((select jsonb_agg(to_jsonb(a)) from public.duty_assignments a),'[]'::jsonb),
 'publications',coalesce((select jsonb_agg(to_jsonb(p) order by month) from public.duty_publications p),'[]'::jsonb)
 )
$$;
create function public.duty_join(p_name text) returns void language sql security invoker set search_path='' as $$select duty_private.join_team(p_name)$$;
create function public.duty_set_constraints(p_member uuid,p_days date[],p_kind text,p_note text,p_revision bigint) returns void language sql security invoker set search_path='' as $$select duty_private.set_constraints(p_member,p_days,p_kind,p_note,p_revision)$$;
create function public.duty_review_member(p_member uuid,p_status text,p_revision bigint) returns void language sql security invoker set search_path='' as $$select duty_private.review_member(p_member,p_status,p_revision)$$;
create function public.duty_save_schedule(p_state jsonb,p_revision bigint,p_publish text default null) returns void language sql security invoker set search_path='' as $$select duty_private.save_schedule(p_state,p_revision,p_publish)$$;

revoke execute on all functions in schema duty_private from public,anon,authenticated;
grant execute on function duty_private.is_manager(),duty_private.is_member(),duty_private.join_team(text),duty_private.set_constraints(uuid,date[],text,text,bigint),duty_private.review_member(uuid,text,bigint),duty_private.save_schedule(jsonb,bigint,text) to authenticated;
revoke execute on function public.duty_load(),public.duty_join(text),public.duty_set_constraints(uuid,date[],text,text,bigint),public.duty_review_member(uuid,text,bigint),public.duty_save_schedule(jsonb,bigint,text) from public,anon;
grant execute on function public.duty_load(),public.duty_join(text),public.duty_set_constraints(uuid,date[],text,text,bigint),public.duty_review_member(uuid,text,bigint),public.duty_save_schedule(jsonb,bigint,text) to authenticated;
