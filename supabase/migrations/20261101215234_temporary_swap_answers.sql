-- Temporary members in swaps (decision 2026-11-01). A temporary member has no
-- account, so an admin answers (accept or decline) for their open side, and only
-- for a temporary member's side; the final admin approval stays a separate step.
-- Admins can read requests waiting on a temporary member. Nobody waits on a member
-- who can no longer sign in: deactivating a party, or withdrawing their approval,
-- invalidates their pending swaps, and this migration does so for existing ones.

CREATE OR REPLACE FUNCTION duty_private.reconcile_swaps(p_month text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare r public.duty_swap_requests; a public.duty_assignments; b public.duty_assignments; publication uuid;
begin
 select current_publication_id into publication from public.duty_months where month=p_month;
 for r in select * from public.duty_swap_requests where month=p_month
  and status in ('awaiting_engineer','awaiting_admin') order by id for update loop
  select * into a from public.duty_assignments where publication_id=publication and day=r.from_day and end_day=r.from_end_day;
  select * into b from public.duty_assignments where publication_id=publication and day=r.to_day and end_day=r.to_end_day;
  -- Consent covers the points each side gives and takes: a republished duty
  -- worth different points is a different swap (the requested copy is immutable).
  if a.id is null or b.id is null or a.primary_id is distinct from r.requester_id
   or b.primary_id is null or b.primary_id=r.requester_id
   or a.day<(now() at time zone 'Asia/Jerusalem')::date or b.day<(now() at time zone 'Asia/Jerusalem')::date
   or a.points<>coalesce((select points from public.duty_assignments where id=r.from_duty_id),a.points)
   or b.points<>coalesce((select points from public.duty_assignments where id=r.to_duty_id),b.points)
   -- Nobody waits on a member who can no longer sign in or take duties.
   or not exists(select 1 from public.duty_members where id=a.primary_id and active and status='approved')
   or not exists(select 1 from public.duty_members where id=b.primary_id and active and status='approved') then
   update public.duty_swap_requests set status='invalidated',accepted_by=null,accepted_at=null,
    resolved_at=now(),resolved_by=null where id=r.id;
  elsif b.primary_id is distinct from r.other_id then
   -- A new counterpart is a new deal: both members answer again.
   update public.duty_swap_requests set other_id=b.primary_id,status='awaiting_engineer',
    accepted_by=null,accepted_at=null,requester_accepted_at=null where id=r.id;
  end if;
 end loop;
end $$;

CREATE OR REPLACE FUNCTION duty_private.resolve_swap(p_request uuid, p_action text, p_revision bigint, p_override_reason text DEFAULT ''::text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare r public.duty_swap_requests; a public.duty_assignments; b public.duty_assignments;
 current_publication uuid; publication uuid; next_version integer; reason text:=trim(coalesce(p_override_reason,'')); side text; next_status text;
 party boolean:=false;
begin
 perform duty_private.check_revision(p_revision);
 if not duty_private.is_member() then raise exception 'Your membership is not approved' using errcode='42501'; end if;
 select * into r from public.duty_swap_requests where id=p_request for update;
 if r.id is null then raise exception 'Request not found' using errcode='42501'; end if;
 if p_action='cancel' then
  if coalesce(r.proposed_by,r.requester_id)<>auth.uid() then raise exception 'Only the person who started the request can cancel' using errcode='42501'; end if;
 elsif p_action in ('accept','decline') then
  -- Each party answers only for their own side. A requester who asked for the
  -- swap consented by sending it; one an admin proposed it for must accept too.
  -- Temporary members have no account: an admin answers for them, and only for them.
  party:=r.other_id=auth.uid() or (r.requester_id=auth.uid() and r.proposed_by is not null);
  if not party and not (duty_private.is_manager() and exists(select 1 from public.duty_members m where m.is_temporary
    and (m.id=r.other_id or (m.id=r.requester_id and r.proposed_by is not null)))) then
   raise exception 'Only the current counterpart can respond' using errcode='42501';
  end if;
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
  if r.status<>'awaiting_engineer' then raise exception 'Engineer consent already recorded'; end if;
  -- The caller's own side first; then an admin answers a temporary member's open side,
  -- the requester's before the other's (swapAnswerFor mirrors this order).
  if r.other_id=auth.uid() and r.accepted_by is null then side:='other';
  elsif r.requester_id=auth.uid() and r.proposed_by is not null and r.requester_accepted_at is null then side:='requester';
  elsif duty_private.is_manager() and r.proposed_by is not null and r.requester_accepted_at is null
   and exists(select 1 from public.duty_members where id=r.requester_id and is_temporary) then side:='requester';
  elsif duty_private.is_manager() and r.accepted_by is null
   and exists(select 1 from public.duty_members where id=r.other_id and is_temporary) then side:='other';
  elsif r.other_id=auth.uid() or (r.requester_id=auth.uid() and r.proposed_by is not null) then
   raise exception 'Your answer is already recorded';
  elsif party then raise exception 'The counterpart changed. Refresh first.' using errcode='40001';
  else raise exception 'Only the current counterpart can respond' using errcode='42501'; end if;
 elsif p_action='approve' then
  -- Every swap ends with an explicit admin approval after both members accepted,
  -- even one an admin started or takes part in.
  if r.status<>'awaiting_admin' or r.accepted_by is distinct from r.other_id or (r.proposed_by is not null and r.requester_accepted_at is null) then
   raise exception 'Both engineers must accept before admin review';
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
  insert into public.duty_assignments(publication_id,day,end_day,primary_id,secondary_id,manager_override,title,extra_points,saturday_extra_points,locked)
  select publication,d.day,d.end_day,case when d.id=a.id then r.other_id when d.id=b.id then r.requester_id else d.primary_id end,
   d.secondary_id,case when d.id in (a.id,b.id) then exists(
    select 1 from public.duty_constraints c where c.kind='no' and c.day>=d.day and c.day<d.end_day
    and c.member_id in (case when d.id=a.id then r.other_id else r.requester_id end,d.secondary_id)
   ) else d.manager_override end,d.title,d.extra_points,d.saturday_extra_points,d.locked
  from public.duty_assignments d where d.publication_id=current_publication;
  insert into public.duty_allocations(month,publication_id,allocation_id,allocation,locks,approvals,accounting_fingerprint,calendar_fingerprint,source_publication_id,generation,origin)
  select month,publication,allocation_id,allocation,
   (select coalesce(jsonb_agg(case when l->>'dutyId'=a.day::text then jsonb_set(l,'{engineer}',to_jsonb(r.other_id::text)) when l->>'dutyId'=b.day::text then jsonb_set(l,'{engineer}',to_jsonb(r.requester_id::text)) else l end),'[]') from jsonb_array_elements(locks) l),
   (select coalesce(jsonb_agg(v),'[]') from jsonb_array_elements(approvals) v where
    not (v->>'rule' in ('availability','boundary') and v->>'dutyId' in (a.day::text,b.day::text))
    and not (v->>'rule'='consecutive' and ((v->'duties') ? a.day::text or (v->'duties') ? b.day::text))
    and not (v->>'rule'='weekends' and v->>'engineer' in (r.requester_id::text,r.other_id::text))),accounting_fingerprint,calendar_fingerprint,current_publication,generation,'swap' from public.duty_allocations where publication_id=current_publication;
 end if;
 next_status:=case p_action when 'accept' then case when (side='other' and (r.proposed_by is null or r.requester_accepted_at is not null))
   or (side='requester' and r.accepted_by is not null) then 'awaiting_admin' else 'awaiting_engineer' end
  when 'decline' then 'declined' when 'approve' then 'approved' when 'reject' then 'rejected' else 'cancelled' end;
 -- Finalize before the publication trigger revalidates all other pending requests.
 update public.duty_swap_requests set status=next_status,
  accepted_by=case when p_action='accept' and side='other' then r.other_id else accepted_by end,
  accepted_at=case when p_action='accept' and side='other' then now() else accepted_at end,
  requester_accepted_at=case when p_action='accept' and side='requester' then now() else requester_accepted_at end,
  resolved_at=case when p_action='accept' then null else now() end,
  resolved_by=case when p_action='accept' then null else auth.uid() end,
  result_publication_id=publication,override_reason=case when p_action='approve' then reason else '' end where id=r.id;
 if publication is not null then
  update public.duty_months set current_publication_id=publication where month=r.month;
 end if;
 update public.duty_workspace set revision=revision+1 where id;
 return (select status from public.duty_swap_requests where id=r.id);
end $$;

CREATE FUNCTION duty_private.reconcile_member_swaps() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare m text;
begin
 -- A party who is deactivated or loses approval never holds a request open:
 -- reconcile_swaps invalidates their pending swaps (decision 2026-11-01).
 perform 1 from public.duty_workspace where id for update;
 for m in select distinct month from public.duty_swap_requests
  where status in ('awaiting_engineer','awaiting_admin') and new.id in (requester_id,other_id) order by month loop
  perform duty_private.reconcile_swaps(m);
 end loop;
 return new;
end $$;

REVOKE ALL ON FUNCTION duty_private.reconcile_member_swaps() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER duty_reconcile_member_swaps AFTER UPDATE OF active, status ON public.duty_members FOR EACH ROW WHEN ((old.active AND (old.status = 'approved'::text) AND NOT (new.active AND (new.status = 'approved'::text)))) EXECUTE FUNCTION duty_private.reconcile_member_swaps();

DROP POLICY swaps_read ON public.duty_swap_requests;
CREATE POLICY swaps_read ON public.duty_swap_requests FOR SELECT TO authenticated USING ((( SELECT duty_private.is_member() AS is_member) AND ((requester_id = ( SELECT auth.uid() AS uid)) OR (proposed_by = ( SELECT auth.uid() AS uid)) OR ((other_id = ( SELECT auth.uid() AS uid)) AND (status = 'awaiting_engineer'::text)) OR (( SELECT duty_private.is_manager() AS is_manager) AND (status = 'awaiting_admin'::text)) OR (( SELECT duty_private.is_manager() AS is_manager) AND (status = 'awaiting_engineer'::text) AND (EXISTS ( SELECT 1 FROM public.duty_members m WHERE (m.is_temporary AND (((m.id = duty_swap_requests.other_id) AND (duty_swap_requests.accepted_by IS NULL)) OR ((m.id = duty_swap_requests.requester_id) AND (duty_swap_requests.proposed_by IS NOT NULL) AND (duty_swap_requests.requester_accepted_at IS NULL))))))))));

-- Only the new rule is applied to existing rows: a pending request with a party who
-- is no longer active and approved is invalidated (as reconcile_swaps now does).
UPDATE public.duty_workspace SET revision=revision+1 WHERE id AND EXISTS(SELECT 1 FROM public.duty_swap_requests r
 WHERE r.status IN ('awaiting_engineer','awaiting_admin') AND EXISTS(SELECT 1 FROM public.duty_members m
  WHERE m.id IN (r.requester_id,r.other_id) AND NOT (m.active AND m.status='approved')));
UPDATE public.duty_swap_requests r SET status='invalidated',accepted_by=NULL,accepted_at=NULL,resolved_at=now(),resolved_by=NULL
 WHERE r.status IN ('awaiting_engineer','awaiting_admin') AND EXISTS(SELECT 1 FROM public.duty_members m
  WHERE m.id IN (r.requester_id,r.other_id) AND NOT (m.active AND m.status='approved'));
