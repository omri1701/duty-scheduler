-- Admin-proposed swaps (decision 2026-10-31). An admin may propose a swap between
-- any two members. proposed_by records that admin and requester_accepted_at the
-- requester's explicit consent; both stay NULL when the requester asked for the
-- swap (all existing rows), whose consent is implicit in sending it. An admin who
-- is a party becomes the requester, so only the other member is asked. Every swap
-- still waits in awaiting_admin for an explicit admin approval after both members
-- accepted. duty_swap_availability tells the two members (or an admin) whose
-- unavailability blocks a swap and on which date, never the note; members get
-- emergency cover's conflicts without a name, and only for a still-requestable pair. Additive only:
-- no existing row, assignment or publication changes.
ALTER TABLE public.duty_swap_requests ADD COLUMN proposed_by uuid, ADD COLUMN requester_accepted_at timestamp with time zone;
ALTER TABLE ONLY public.duty_swap_requests
    ADD CONSTRAINT duty_swap_requests_proposed_by_fkey FOREIGN KEY (proposed_by) REFERENCES public.duty_members(id);
CREATE INDEX duty_swaps_proposer ON public.duty_swap_requests USING btree (proposed_by);
ALTER TABLE public.duty_swap_requests DROP CONSTRAINT duty_swaps_consent_check;
ALTER TABLE public.duty_swap_requests ADD CONSTRAINT duty_swaps_consent_check CHECK ((((status <> 'awaiting_admin'::text) OR ((accepted_by IS NOT NULL) AND (accepted_by = other_id) AND (accepted_at IS NOT NULL) AND ((proposed_by IS NULL) OR (requester_accepted_at IS NOT NULL)))) AND ((status <> 'awaiting_engineer'::text) OR (((accepted_by IS NULL) = (accepted_at IS NULL)) AND ((accepted_by IS NULL) OR ((accepted_by = other_id) AND (proposed_by IS NOT NULL) AND (requester_accepted_at IS NULL)))))));
ALTER TABLE public.duty_swap_requests ADD CONSTRAINT duty_swaps_proposer_check CHECK ((((proposed_by IS NULL) OR (proposed_by <> requester_id)) AND ((requester_accepted_at IS NULL) OR (proposed_by IS NOT NULL))));

DROP POLICY swaps_read ON public.duty_swap_requests;
CREATE POLICY swaps_read ON public.duty_swap_requests FOR SELECT TO authenticated USING ((( SELECT duty_private.is_member() AS is_member) AND ((requester_id = ( SELECT auth.uid() AS uid)) OR (proposed_by = ( SELECT auth.uid() AS uid)) OR ((other_id = ( SELECT auth.uid() AS uid)) AND (status = 'awaiting_engineer'::text)) OR (( SELECT duty_private.is_manager() AS is_manager) AND (status = 'awaiting_admin'::text)))));

CREATE OR REPLACE FUNCTION duty_private.request_swap(p_from uuid, p_to uuid, p_explanation text, p_revision bigint) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare a public.duty_assignments; b public.duty_assignments; t public.duty_assignments; m text; me uuid:=auth.uid();
begin
 perform duty_private.check_revision(p_revision);
 -- Recheck after lock acquisition, including a membership change while waiting.
 if not duty_private.is_member() then raise exception 'Your membership is not approved' using errcode='42501'; end if;
 select * into a from public.duty_assignments where id=p_from;
 select * into b from public.duty_assignments where id=p_to;
 -- Engineers offer their own primary duty. Admins may also propose a swap between
 -- any two members (recorded in proposed_by, so both must accept). When the admin
 -- is a party, their side becomes the requester: their consent is implicit and
 -- only the other member is asked.
 if a.primary_id is distinct from me then
  if not duty_private.is_manager() then raise exception 'Choose your own primary duty' using errcode='42501'; end if;
  if b.primary_id=me then t:=a; a:=b; b:=t; end if;
 end if;
 if a.publication_id is null or b.publication_id is distinct from a.publication_id then raise exception 'Choose duties in the same current publication'; end if;
 perform duty_private.validate_swap(a.id,b.id,a.publication_id,false);
 select month into m from public.duty_months where current_publication_id=a.publication_id;
 insert into public.duty_swap_requests(month,source_publication_id,from_duty_id,to_duty_id,requester_id,other_id,from_day,from_end_day,to_day,to_end_day,explanation,proposed_by)
 values(m,a.publication_id,a.id,b.id,a.primary_id,b.primary_id,a.day,a.end_day,b.day,b.end_day,trim(coalesce(p_explanation,'')),
  case when a.primary_id<>me then me end);
 update public.duty_workspace set revision=revision+1 where id;
end $$;

CREATE OR REPLACE FUNCTION duty_private.resolve_swap(p_request uuid, p_action text, p_revision bigint, p_override_reason text DEFAULT ''::text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare r public.duty_swap_requests; a public.duty_assignments; b public.duty_assignments;
 current_publication uuid; publication uuid; next_version integer; reason text:=trim(coalesce(p_override_reason,'')); side text; next_status text;
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
  if r.other_id<>auth.uid() and (r.requester_id<>auth.uid() or r.proposed_by is null) then
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
  if r.other_id=auth.uid() then side:='other';
  elsif r.requester_id=auth.uid() and r.proposed_by is not null then side:='requester';
  else raise exception 'The counterpart changed. Refresh first.' using errcode='40001'; end if;
  if r.status<>'awaiting_engineer' then raise exception 'Engineer consent already recorded'; end if;
  if (side='other' and r.accepted_by is not null) or (side='requester' and r.requester_accepted_at is not null) then
   raise exception 'Your answer is already recorded';
  end if;
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
  accepted_by=case when p_action='accept' and side='other' then auth.uid() else accepted_by end,
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

CREATE FUNCTION duty_private.swap_availability(p_from uuid, p_to uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare a public.duty_assignments; b public.duty_assignments; admin boolean:=duty_private.is_manager();
begin
 if not duty_private.is_member() then raise exception 'Your membership is not approved' using errcode='42501'; end if;
 select * into a from public.duty_assignments where id=p_from;
 select * into b from public.duty_assignments where id=p_to;
 if a.publication_id is null or b.publication_id is distinct from a.publication_id
  or not exists(select 1 from public.duty_months where current_publication_id=a.publication_id) then
  raise exception 'Choose duties in the same current publication';
 end if;
 -- Only the two members (or an admin) learn whose availability blocks this swap,
 -- and members only for a pair they could still request.
 if not admin then
  if auth.uid() is distinct from a.primary_id and auth.uid() is distinct from b.primary_id then
   raise exception 'Choose your own primary duty' using errcode='42501';
  end if;
  if a.primary_id is null or b.primary_id is null or a.primary_id=b.primary_id
   or least(a.day,b.day)<(now() at time zone 'Asia/Jerusalem')::date then
   raise exception 'Choose duties starting today or later';
  end if;
 end if;
 -- Exactly the conflicts validate_swap refuses: which date, never the note. Members
 -- learn the two primaries by name; emergency cover stays anonymous to them.
 return coalesce((select jsonb_agg(jsonb_build_object('member',case when admin or c.member_id in (a.primary_id,b.primary_id) then c.member_id end,'day',c.day) order by c.day,c.member_id)
  from public.duty_constraints c where c.kind='no' and
  ((c.member_id in (b.primary_id,a.secondary_id) and c.day>=a.day and c.day<a.end_day)
   or (c.member_id in (a.primary_id,b.secondary_id) and c.day>=b.day and c.day<b.end_day))),'[]'::jsonb);
end $$;

CREATE FUNCTION public.duty_swap_availability(p_from uuid, p_to uuid) RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$select duty_private.swap_availability(p_from,p_to)$$;

REVOKE ALL ON FUNCTION duty_private.swap_availability(p_from uuid, p_to uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION duty_private.swap_availability(p_from uuid, p_to uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.duty_swap_availability(p_from uuid, p_to uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.duty_swap_availability(p_from uuid, p_to uuid) TO authenticated;
