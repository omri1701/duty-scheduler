-- Keep the original publication/duty references as history. Dates and exclusive
-- ends identify the original slots across immutable publication copies.
alter table public.duty_swap_requests drop constraint duty_swap_requests_status_check;
alter table public.duty_swap_requests add column accepted_by uuid references public.duty_members(id),
 add column accepted_at timestamptz;
create index duty_swaps_acceptor on public.duty_swap_requests(accepted_by);
update public.duty_swap_requests set status='awaiting_engineer' where status='pending';
alter table public.duty_swap_requests alter column status set default 'awaiting_engineer';
alter table public.duty_swap_requests add constraint duty_swap_requests_status_check
 check(status in ('awaiting_engineer','awaiting_admin','approved','declined','rejected','cancelled','invalidated'));
alter table public.duty_swap_requests add constraint duty_swaps_consent_check
 -- Historical v1 approvals had no engineer consent; never invent that consent.
 check((status<>'awaiting_admin' or (accepted_by is not null and accepted_by=other_id and accepted_at is not null))
 and (status<>'awaiting_engineer' or (accepted_by is null and accepted_at is null)));
drop index public.duty_swaps_pending_pair;
-- Older versions allowed the same pending slots in multiple source versions.
-- Retain the newest request and explicitly invalidate superseded duplicates.
with ranked as (
 select id,row_number() over(partition by month,requester_id,from_day,to_day order by created_at desc,id) as position
 from public.duty_swap_requests where status='awaiting_engineer'
)
update public.duty_swap_requests set status='invalidated',resolved_at=now()
 where id in (select id from ranked where position>1);
-- Original slots, rather than a superseded version's IDs, prevent duplicate requests.
create unique index duty_swaps_pending_pair on public.duty_swap_requests(month,requester_id,from_day,to_day)
 where status in ('awaiting_engineer','awaiting_admin');
create index duty_swaps_pending_month on public.duty_swap_requests(month)
 where status in ('awaiting_engineer','awaiting_admin');
drop policy swaps_read on public.duty_swap_requests;
create policy swaps_read on public.duty_swap_requests for select to authenticated
 using((select duty_private.is_member()) and (requester_id=(select auth.uid())
  or (other_id=(select auth.uid()) and status='awaiting_engineer')
  or ((select duty_private.is_manager()) and status='awaiting_admin')));

-- Internal only. Every caller holds the workspace revision lock first.
create function duty_private.reconcile_swaps(p_month text) returns void
 language plpgsql security definer set search_path='' as $$
declare r public.duty_swap_requests; a public.duty_assignments; b public.duty_assignments; publication uuid;
begin
 select current_publication_id into publication from public.duty_months where month=p_month;
 for r in select * from public.duty_swap_requests where month=p_month
  and status in ('awaiting_engineer','awaiting_admin') order by id for update loop
  select * into a from public.duty_assignments where publication_id=publication and day=r.from_day and end_day=r.from_end_day;
  select * into b from public.duty_assignments where publication_id=publication and day=r.to_day and end_day=r.to_end_day;
  if a.id is null or b.id is null or a.primary_id is distinct from r.requester_id
   or b.primary_id is null or b.primary_id=r.requester_id
   or a.day<=(now() at time zone 'Asia/Jerusalem')::date or b.day<=(now() at time zone 'Asia/Jerusalem')::date then
   update public.duty_swap_requests set status='invalidated',accepted_by=null,accepted_at=null,
    resolved_at=now(),resolved_by=null where id=r.id;
  elsif b.primary_id is distinct from r.other_id then
   update public.duty_swap_requests set other_id=b.primary_id,status='awaiting_engineer',
    accepted_by=null,accepted_at=null where id=r.id;
  end if;
 end loop;
end $$;

-- Ordinary publishing and deletion of the live version use this same pointer.
-- They already acquire the global lock before changing it; no draft trigger.
create function duty_private.reconcile_publication_swaps() returns trigger
 language plpgsql security definer set search_path='' as $$
begin
 perform 1 from public.duty_workspace where id for update;
 perform duty_private.reconcile_swaps(new.month);
 return new;
end $$;
create trigger duty_reconcile_publication_swaps after update of current_publication_id on public.duty_months
 for each row when (old.current_publication_id is distinct from new.current_publication_id)
 execute function duty_private.reconcile_publication_swaps();

-- Report invalidation explicitly so the UI cannot announce a successful swap
-- when a safe terminal state was committed instead (e.g. a date expired).
drop function public.duty_resolve_swap(uuid,text,bigint,text);
drop function duty_private.resolve_swap(uuid,text,bigint,text);
create function duty_private.resolve_swap(p_request uuid,p_action text,p_revision bigint,p_override_reason text default '')
 returns text language plpgsql security definer set search_path='' as $$
declare r public.duty_swap_requests; a public.duty_assignments; b public.duty_assignments;
 current_publication uuid; publication uuid; next_version integer; reason text:=trim(coalesce(p_override_reason,''));
begin
 perform duty_private.check_revision(p_revision);
 if not duty_private.is_member() then raise exception 'Your membership is not approved' using errcode='42501'; end if;
 select * into r from public.duty_swap_requests where id=p_request for update;
 if r.id is null then raise exception 'Request not found' using errcode='42501'; end if;
 if p_action='cancel' then
  if r.requester_id<>auth.uid() then raise exception 'Only the requester can cancel' using errcode='42501'; end if;
 elsif p_action in ('accept','decline') then
  if r.other_id<>auth.uid() then raise exception 'Only the current counterpart can respond' using errcode='42501'; end if;
 elsif p_action in ('approve','reject') then
  if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 else raise exception 'Invalid swap action'; end if;
 if r.status not in ('awaiting_engineer','awaiting_admin') then raise exception 'This request is no longer pending'; end if;
 perform duty_private.reconcile_swaps(r.month);
 select * into r from public.duty_swap_requests where id=p_request;
 -- Commit safe invalidation (raising here would roll it back).
 if r.status='invalidated' then
  update public.duty_workspace set revision=revision+1 where id;
  return 'invalidated';
 end if;
 if p_action in ('accept','decline') then
  if r.other_id<>auth.uid() then raise exception 'The counterpart changed. Refresh first.' using errcode='40001'; end if;
  if r.status<>'awaiting_engineer' then raise exception 'Engineer consent already recorded'; end if;
 elsif p_action in ('approve','reject') then
  if r.status<>'awaiting_admin' or r.accepted_by is distinct from r.other_id then
   raise exception 'The current engineer must accept before admin review';
  end if;
 end if;
 if p_action in ('accept','approve') then
  select current_publication_id into current_publication from public.duty_months where month=r.month;
  select * into a from public.duty_assignments where publication_id=current_publication and day=r.from_day and end_day=r.from_end_day;
  select * into b from public.duty_assignments where publication_id=current_publication and day=r.to_day and end_day=r.to_end_day;
  -- Consent may precede an audited availability override, but never bypasses
  -- active membership, emergency duplication, overlap, weekends or future dates.
  perform duty_private.validate_swap(a.id,b.id,current_publication,p_action='accept' or length(reason)>0);
 end if;
 if p_action='approve' then
  update public.duty_months set publication_sequence=publication_sequence+1 where month=r.month returning publication_sequence into next_version;
  insert into public.duty_publications(month,version,published_by) values(r.month,next_version,auth.uid()) returning id into publication;
  insert into public.duty_assignments(publication_id,day,end_day,primary_id,secondary_id,manager_override,title,extra_points)
  select publication,d.day,d.end_day,case when d.id=a.id then r.other_id when d.id=b.id then r.requester_id else d.primary_id end,
   d.secondary_id,case when d.id in (a.id,b.id) then exists(
    select 1 from public.duty_constraints c where c.kind='no' and c.day>=d.day and c.day<d.end_day
    and c.member_id in (case when d.id=a.id then r.other_id else r.requester_id end,d.secondary_id)
   ) else d.manager_override end,d.title,d.extra_points
  from public.duty_assignments d where d.publication_id=current_publication;
 end if;
 -- Finalize before the publication trigger revalidates all other pending requests.
 update public.duty_swap_requests set
  status=case p_action when 'accept' then 'awaiting_admin' when 'decline' then 'declined'
   when 'approve' then 'approved' when 'reject' then 'rejected' else 'cancelled' end,
  accepted_by=case when p_action='accept' then auth.uid() else accepted_by end,
  accepted_at=case when p_action='accept' then now() else accepted_at end,
  resolved_at=case when p_action='accept' then null else now() end,
  resolved_by=case when p_action='accept' then null else auth.uid() end,
  result_publication_id=publication,override_reason=case when p_action='approve' then reason else '' end where id=r.id;
 if publication is not null then
  update public.duty_months set current_publication_id=publication where month=r.month;
 end if;
 update public.duty_workspace set revision=revision+1 where id;
 return (select status from public.duty_swap_requests where id=r.id);
end $$;

create function public.duty_resolve_swap(p_request uuid,p_action text,p_revision bigint,p_override_reason text default '')
 returns text language sql security invoker set search_path='' as $$select duty_private.resolve_swap(p_request,p_action,p_revision,p_override_reason)$$;
revoke execute on function duty_private.resolve_swap(uuid,text,bigint,text),public.duty_resolve_swap(uuid,text,bigint,text) from public,anon,authenticated;
grant execute on function duty_private.resolve_swap(uuid,text,bigint,text),public.duty_resolve_swap(uuid,text,bigint,text) to authenticated;
revoke execute on function duty_private.reconcile_swaps(text),duty_private.reconcile_publication_swaps() from public,anon,authenticated;
-- RPC argument names/signatures and invoker/checked write architecture are preserved.
-- Convert any pre-upgrade pending requests against the authoritative publication.
do $$ declare m text; begin
 perform 1 from public.duty_workspace where id for update;
 for m in select distinct month from public.duty_swap_requests where status='awaiting_engineer' loop
  perform duty_private.reconcile_swaps(m);
 end loop;
 update public.duty_workspace set revision=revision+1 where id;
end $$;
notify pgrst, 'reload schema';
