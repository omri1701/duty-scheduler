-- Swap requests never write drafts or mutate existing publication rows.
create table public.duty_swap_requests (
 id uuid primary key default gen_random_uuid(),
 month text not null references public.duty_months(month),
 source_publication_id uuid references public.duty_publications(id) on delete set null,
 from_duty_id uuid references public.duty_assignments(id) on delete set null,
 to_duty_id uuid references public.duty_assignments(id) on delete set null,
 requester_id uuid not null references public.duty_members(id),
 other_id uuid not null references public.duty_members(id),
 from_day date not null, from_end_day date not null,
 to_day date not null, to_end_day date not null,
 explanation text not null default '' check(length(explanation)<=1000),
 status text not null default 'pending' check(status in ('pending','approved','rejected','cancelled')),
 created_at timestamptz not null default now(), resolved_at timestamptz,
 resolved_by uuid references public.duty_members(id),
 result_publication_id uuid references public.duty_publications(id) on delete set null,
 override_reason text not null default '' check(length(override_reason)<=1000),
 check(requester_id<>other_id), check(from_day<>to_day)
);
create index duty_swaps_month on public.duty_swap_requests(month);
create index duty_swaps_requester on public.duty_swap_requests(requester_id,created_at desc);
create index duty_swaps_other on public.duty_swap_requests(other_id);
create index duty_swaps_source on public.duty_swap_requests(source_publication_id);
create index duty_swaps_from on public.duty_swap_requests(from_duty_id);
create index duty_swaps_to on public.duty_swap_requests(to_duty_id);
create index duty_swaps_resolver on public.duty_swap_requests(resolved_by);
create index duty_swaps_result on public.duty_swap_requests(result_publication_id);
create unique index duty_swaps_pending_pair on public.duty_swap_requests(source_publication_id,from_duty_id,to_duty_id) where status='pending';
alter table public.duty_swap_requests enable row level security;
revoke all on public.duty_swap_requests from public,anon,authenticated;
grant select on public.duty_swap_requests to authenticated;
create policy swaps_read on public.duty_swap_requests for select to authenticated
 using((select duty_private.is_member()) and (requester_id=(select auth.uid()) or (select duty_private.is_manager())));

create function duty_private.duty_owner(p_day date) returns text language sql immutable set search_path='' as $$
 select to_char(case when extract(dow from p_day)=6 then p_day-1 else p_day end,'YYYY-MM')
$$;

-- Owning Friday's publication wins over a carried copy in the following month.
create function duty_private.current_duties() returns setof public.duty_assignments language sql stable set search_path='' as $$
 select a.* from public.duty_assignments a
 join public.duty_months m on m.current_publication_id=a.publication_id
 where m.month=duty_private.duty_owner(a.day)
 or not exists(select 1 from public.duty_months owner where owner.month=duty_private.duty_owner(a.day) and owner.current_publication_id is not null)
$$;

-- Called only by checked operations while holding the global revision lock.
create function duty_private.validate_swap(p_from uuid,p_to uuid,p_publication uuid,p_override boolean default false)
 returns boolean language plpgsql security definer set search_path='' as $$
declare a public.duty_assignments; b public.duty_assignments; m text; conflicts boolean; who uuid; before_count integer; after_count integer;
begin
 select * into a from public.duty_assignments where id=p_from and publication_id=p_publication;
 select * into b from public.duty_assignments where id=p_to and publication_id=p_publication;
 select month into m from public.duty_months where current_publication_id=p_publication;
 if a.id is null or b.id is null or m is null or a.id=b.id then raise exception 'This publication changed. Request a new swap.'; end if;
 if duty_private.duty_owner(a.day)<>m or duty_private.duty_owner(b.day)<>m then raise exception 'Choose duties owned by the same published month'; end if;
 if a.day<=(now() at time zone 'Asia/Jerusalem')::date or b.day<=(now() at time zone 'Asia/Jerusalem')::date then raise exception 'Choose future duties'; end if;
 if a.primary_id is null or b.primary_id is null or a.primary_id=b.primary_id then raise exception 'Choose two different primary engineers'; end if;
 if exists(select 1 from unnest(array[a.primary_id,b.primary_id,a.secondary_id,b.secondary_id]) person
  where person is not null and not exists(select 1 from public.duty_members where id=person and active and status='approved')) then raise exception 'An engineer is no longer active and approved'; end if;
 if a.secondary_id=b.primary_id or b.secondary_id=a.primary_id then raise exception 'A primary engineer cannot also be emergency cover'; end if;
 if exists(select 1 from duty_private.current_duties() x join duty_private.current_duties() y on x.id<>y.id and x.day<y.end_day and y.day<x.end_day
  where x.id in (a.id,b.id)) then raise exception 'Published duty dates overlap'; end if;
 select exists(select 1 from public.duty_constraints c where c.kind='no' and
  ((c.member_id in (b.primary_id,a.secondary_id) and c.day>=a.day and c.day<a.end_day)
   or (c.member_id in (a.primary_id,b.secondary_id) and c.day>=b.day and c.day<b.end_day))) into conflicts;
 if conflicts and not p_override then raise exception 'Availability conflict. An admin must explicitly override with a reason.'; end if;
 -- Either half and emergency cover count as one weekend; preserve existing exceptions,
 -- but swaps cannot increase anyone's count above one (same rule as swapDraft).
 foreach who in array array[a.primary_id,b.primary_id] loop
  select count(distinct case when extract(dow from day)=6 then day-1 else day end) into before_count
  from duty_private.current_duties() where duty_private.duty_owner(day)=m and extract(dow from day) in (5,6) and who in (primary_id,secondary_id);
  select count(distinct case when extract(dow from day)=6 then day-1 else day end) into after_count
  from duty_private.current_duties() where duty_private.duty_owner(day)=m and extract(dow from day) in (5,6)
  and (secondary_id=who or (case when id=a.id then b.primary_id when id=b.id then a.primary_id else primary_id end)=who);
  if after_count>1 and after_count>before_count then raise exception 'This swap would create a second weekend'; end if;
 end loop;
 return conflicts;
end $$;

create function duty_private.request_swap(p_from uuid,p_to uuid,p_explanation text,p_revision bigint) returns void language plpgsql security definer set search_path='' as $$
declare a public.duty_assignments; b public.duty_assignments; m text;
begin
 perform duty_private.check_revision(p_revision);
 -- Recheck after lock acquisition, including a membership change while waiting.
 if not duty_private.is_member() then raise exception 'Your membership is not approved' using errcode='42501'; end if;
 select * into a from public.duty_assignments where id=p_from;
 select * into b from public.duty_assignments where id=p_to;
 if a.primary_id is distinct from auth.uid() then raise exception 'Choose your own primary duty' using errcode='42501'; end if;
 if a.publication_id is null or b.publication_id is distinct from a.publication_id then raise exception 'Choose duties in the same current publication'; end if;
 perform duty_private.validate_swap(p_from,p_to,a.publication_id,false);
 select month into m from public.duty_months where current_publication_id=a.publication_id;
 insert into public.duty_swap_requests(month,source_publication_id,from_duty_id,to_duty_id,requester_id,other_id,from_day,from_end_day,to_day,to_end_day,explanation)
 values(m,a.publication_id,a.id,b.id,auth.uid(),b.primary_id,a.day,a.end_day,b.day,b.end_day,trim(coalesce(p_explanation,'')));
 update public.duty_workspace set revision=revision+1 where id;
end $$;

create function duty_private.resolve_swap(p_request uuid,p_action text,p_revision bigint,p_override_reason text default '') returns void language plpgsql security definer set search_path='' as $$
declare r public.duty_swap_requests; publication uuid; next_version integer; reason text:=trim(coalesce(p_override_reason,''));
begin
 perform duty_private.check_revision(p_revision);
 if not duty_private.is_member() then raise exception 'Your membership is not approved' using errcode='42501'; end if;
 select * into r from public.duty_swap_requests where id=p_request for update;
 if r.id is null then raise exception 'Request not found' using errcode='42501'; end if;
 if p_action='cancel' then
  if r.requester_id<>auth.uid() then raise exception 'Only the requester can cancel' using errcode='42501'; end if;
 elsif p_action in ('approve','reject') then
  if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 else raise exception 'Invalid swap action'; end if;
 if r.status<>'pending' then raise exception 'This request is no longer pending'; end if;
 if p_action='approve' then
  if r.source_publication_id is null or not exists(select 1 from public.duty_months where month=r.month and current_publication_id=r.source_publication_id) then raise exception 'This publication changed. Reject this request and request a new swap.'; end if;
  if not exists(select 1 from public.duty_assignments where id=r.from_duty_id and primary_id=r.requester_id)
   or not exists(select 1 from public.duty_assignments where id=r.to_duty_id and primary_id=r.other_id) then raise exception 'Assignments changed'; end if;
  perform duty_private.validate_swap(r.from_duty_id,r.to_duty_id,r.source_publication_id,length(reason)>0);
  update public.duty_months set publication_sequence=publication_sequence+1 where month=r.month returning publication_sequence into next_version;
  insert into public.duty_publications(month,version,published_by) values(r.month,next_version,auth.uid()) returning id into publication;
  insert into public.duty_assignments(publication_id,day,end_day,primary_id,secondary_id,manager_override,title,extra_points)
  select publication,d.day,d.end_day,case when d.id=r.from_duty_id then r.other_id when d.id=r.to_duty_id then r.requester_id else d.primary_id end,
   d.secondary_id,case when d.id in (r.from_duty_id,r.to_duty_id) then exists(
    select 1 from public.duty_constraints c where c.kind='no' and c.day>=d.day and c.day<d.end_day
    and c.member_id in (case when d.id=r.from_duty_id then r.other_id else r.requester_id end,d.secondary_id)
   ) else d.manager_override end,d.title,d.extra_points
  from public.duty_assignments d where d.publication_id=r.source_publication_id;
  -- Keep the existing draft/status, even if an admin has unrelated edits in progress.
  update public.duty_months set current_publication_id=publication where month=r.month;
 end if;
 update public.duty_swap_requests set status=case p_action when 'approve' then 'approved' when 'reject' then 'rejected' else 'cancelled' end,
  resolved_at=now(),resolved_by=auth.uid(),result_publication_id=publication,override_reason=case when p_action='approve' then reason else '' end where id=r.id;
 update public.duty_workspace set revision=revision+1 where id;
end $$;

create function public.duty_request_swap(p_from uuid,p_to uuid,p_explanation text,p_revision bigint) returns void language sql security invoker set search_path='' as $$select duty_private.request_swap(p_from,p_to,p_explanation,p_revision)$$;
create function public.duty_resolve_swap(p_request uuid,p_action text,p_revision bigint,p_override_reason text default '') returns void language sql security invoker set search_path='' as $$select duty_private.resolve_swap(p_request,p_action,p_revision,p_override_reason)$$;
revoke execute on function duty_private.duty_owner(date),duty_private.current_duties(),duty_private.validate_swap(uuid,uuid,uuid,boolean),duty_private.request_swap(uuid,uuid,text,bigint),duty_private.resolve_swap(uuid,text,bigint,text),public.duty_request_swap(uuid,uuid,text,bigint),public.duty_resolve_swap(uuid,text,bigint,text) from public,anon,authenticated;
grant execute on function duty_private.request_swap(uuid,uuid,text,bigint),duty_private.resolve_swap(uuid,text,bigint,text),public.duty_request_swap(uuid,uuid,text,bigint),public.duty_resolve_swap(uuid,text,bigint,text) to authenticated;

-- Keep duty_load invoker/RLS semantics; append requests to its existing snapshot.
create or replace function public.duty_load() returns jsonb language sql stable security invoker set search_path='' as $$
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
 'constraintTypes',(select jsonb_agg(to_jsonb(c) order by code) from public.duty_constraint_types c),
 'swapRequests',coalesce((select jsonb_agg(to_jsonb(s) order by created_at desc,id) from public.duty_swap_requests s),'[]'::jsonb))
$$;
