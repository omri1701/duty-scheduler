-- Allocation and generation checked database boundary. Additive; no historical backfill.
SET check_function_bodies = false;

-- Source: schemas/tables/duty_allocations.sql
-- One reviewed snapshot per working draft / immutable publication. Never expose
-- allocation reasons or counterpart trails through the ordinary calendar RPC.
CREATE TABLE public.duty_allocations (
 month text NOT NULL REFERENCES public.duty_months(month),
 publication_id uuid,
 allocation_id uuid NOT NULL DEFAULT gen_random_uuid(),
 allocation jsonb NOT NULL,
 locks jsonb NOT NULL DEFAULT '[]',
 approvals jsonb NOT NULL DEFAULT '[]',
 accounting_fingerprint text NOT NULL,
 calendar_fingerprint text NOT NULL,
 source_publication_id uuid,
 generation jsonb,
 origin text NOT NULL DEFAULT 'confirmed' CHECK (origin IN ('confirmed','restored','swap')),
 CONSTRAINT duty_allocations_publication_fkey FOREIGN KEY (month,publication_id)
  REFERENCES public.duty_publications(month,id) ON DELETE CASCADE,
 CONSTRAINT duty_allocations_shape CHECK (jsonb_typeof(allocation)='object'
  AND jsonb_typeof(locks)='array' AND jsonb_typeof(approvals)='array')
);
CREATE UNIQUE INDEX duty_allocation_version ON public.duty_allocations(month,publication_id) NULLS NOT DISTINCT;
ALTER TABLE public.duty_allocations ENABLE ROW LEVEL SECURITY;

-- Source: schemas/functions/duty_private/cancel_draft.sql
CREATE OR REPLACE FUNCTION duty_private.cancel_draft(p_month text, p_revision bigint) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare m public.duty_months;
begin
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 perform duty_private.check_revision(p_revision);
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 select * into m from public.duty_months where month=p_month;
 if m.current_publication_id is null or m.status<>'draft' then raise exception 'A reopened published month is required'; end if;
 delete from public.duty_assignments where publication_id is null and duty_private.duty_owner(day)=p_month;
 delete from public.duty_allocations where month=p_month and publication_id is null;
 update public.duty_months set status='published',generated=true where month=p_month;
 update public.duty_workspace set revision=revision+1 where id;
end $$;

-- Source: schemas/functions/duty_private/delete_publication.sql
CREATE OR REPLACE FUNCTION duty_private.delete_publication(p_publication uuid, p_revision bigint) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare v public.duty_publications; replacement uuid;
begin
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 perform duty_private.check_revision(p_revision);
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 select * into v from public.duty_publications where id=p_publication;
 if v.id is null then raise exception 'Version no longer exists'; end if;
 select id into replacement from public.duty_publications where month=v.month and id<>v.id order by version desc limit 1;
 -- Deleting the final publication must not silently discard the only schedule.
 -- Keep an already-open draft, otherwise copy the version before deleting it.
 if replacement is null and exists(select 1 from public.duty_months where current_publication_id=v.id and status='published') then
  insert into public.duty_assignments(day,end_day,primary_id,secondary_id,manager_override,title,extra_points)
  select day,end_day,primary_id,secondary_id,manager_override,title,extra_points from public.duty_assignments
  where publication_id=v.id and duty_private.duty_owner(day)=v.month;
  insert into public.duty_allocations(month,publication_id,allocation_id,allocation,locks,approvals,accounting_fingerprint,calendar_fingerprint,source_publication_id,generation)
  select month,null,allocation_id,allocation,locks,approvals,accounting_fingerprint,calendar_fingerprint,p_publication,generation from public.duty_allocations where publication_id=p_publication;
 end if;
 update public.duty_months set current_publication_id=replacement,status=case when replacement is null then 'draft' else status end where current_publication_id=v.id;
 delete from public.duty_publications where id=v.id;
 update public.duty_workspace set revision=revision+1 where id;
end $$;

-- Source: schemas/functions/duty_private/resolve_swap.sql
CREATE OR REPLACE FUNCTION duty_private.resolve_swap(p_request uuid, p_action text, p_revision bigint, p_override_reason text DEFAULT ''::text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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
  insert into public.duty_allocations(month,publication_id,allocation_id,allocation,locks,approvals,accounting_fingerprint,calendar_fingerprint,source_publication_id,generation,origin)
  select month,publication,allocation_id,allocation,
   (select coalesce(jsonb_agg(case when l->>'dutyId'=a.day::text then jsonb_set(l,'{engineer}',to_jsonb(r.other_id::text)) when l->>'dutyId'=b.day::text then jsonb_set(l,'{engineer}',to_jsonb(r.requester_id::text)) else l end),'[]') from jsonb_array_elements(locks) l),
   (select coalesce(jsonb_agg(v),'[]') from jsonb_array_elements(approvals) v where
    not (v->>'rule' in ('availability','boundary') and v->>'dutyId' in (a.day::text,b.day::text))
    and not (v->>'rule'='consecutive' and ((v->'duties') ? a.day::text or (v->'duties') ? b.day::text))
    and not (v->>'rule'='weekends' and v->>'engineer' in (r.requester_id::text,r.other_id::text))),accounting_fingerprint,calendar_fingerprint,current_publication,generation,'swap' from public.duty_allocations where publication_id=current_publication;
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

-- Source: schemas/functions/duty_private/restore_publication.sql
CREATE OR REPLACE FUNCTION duty_private.restore_publication(p_publication uuid, p_revision bigint) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare v public.duty_publications;
begin
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 perform duty_private.check_revision(p_revision);
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 select * into v from public.duty_publications where id=p_publication;
 if v.id is null then raise exception 'Version no longer exists'; end if;
 -- Old versions may contain adjacent coverage. Only Friday-owned rows belong
 -- to this draft; retain the original historical publication byte-for-byte.
 delete from public.duty_assignments where publication_id is null and duty_private.duty_owner(day)=v.month;
 insert into public.duty_assignments(day,end_day,primary_id,secondary_id,manager_override,title,extra_points)
 select day,end_day,primary_id,secondary_id,manager_override,title,extra_points
 from public.duty_assignments where publication_id=p_publication and duty_private.duty_owner(day)=v.month;
 delete from public.duty_allocations where month=v.month and publication_id is null;
 insert into public.duty_allocations(month,publication_id,allocation_id,allocation,locks,approvals,accounting_fingerprint,calendar_fingerprint,source_publication_id,generation,origin)
 select month,null,allocation_id,allocation,locks,approvals,md5((duty_private.compensation_state()->'events')::text),calendar_fingerprint,p_publication,generation,'restored' from public.duty_allocations where publication_id=p_publication;
 update public.duty_months set status='draft',generated=true where month=v.month;
 update public.duty_workspace set revision=revision+1 where id;
end $$;

-- Source: schemas/functions/duty_private/save_schedule.sql
CREATE OR REPLACE FUNCTION duty_private.save_schedule(p_state jsonb, p_revision bigint, p_publish text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
#variable_conflict use_column
declare x record; item jsonb; d date; a public.duty_assignments; m public.duty_months; first_day date; last_day date; publication uuid; next_version integer; locks_before jsonb; f jsonb; result jsonb; allocation public.duty_allocations;
begin
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 perform duty_private.check_revision(p_revision);
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 if jsonb_typeof(p_state->'duties') is distinct from 'array' or jsonb_typeof(p_state->'months') is distinct from 'object' or jsonb_typeof(p_state->'team') is distinct from 'array' or length(p_state::text)>2000000 then raise exception 'Invalid schedule'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('day',a.day,'end_day',a.end_day,'primary_id',a.primary_id,'points',a.points)),'[]') into locks_before
 from public.duty_allocations meta cross join lateral jsonb_array_elements(meta.locks) l
 join public.duty_assignments a on a.publication_id is null and a.day=(l->>'dutyId')::date
 where meta.publication_id is null;
 for x in select value,ordinality from jsonb_array_elements(p_state->'team') with ordinality loop
  -- Profile names and roles have separate checked operations.
  update public.duty_members set color=x.value->>'color',active=(x.value->>'active')::boolean,seniority=x.ordinality where id=(x.value->>'id')::uuid and status='approved';
  if not found then raise exception 'Unknown approved team member'; end if;
 end loop;
 perform duty_private.assert_admin_remains();
 for x in select * from jsonb_each(p_state->'months') loop
  select * into m from public.duty_months where month=x.key;
  if m.status='published' and (x.value->>'status'='draft' or p_publish=x.key) then raise exception 'Reopen the draft first'; end if;
  if x.value->>'status'='published' and coalesce(m.status,'draft')='draft' and p_publish is distinct from x.key then raise exception 'Use Publish to publish a draft'; end if;
  insert into public.duty_months(month,deadline,generated) values(x.key,(x.value->>'deadline')::date,coalesce((x.value->>'generated')::boolean,false))
  on conflict(month) do update set deadline=excluded.deadline,generated=case when duty_months.status='published' then true else excluded.generated end;
 end loop;
 -- A scoped save cannot erase drafts omitted from the request or materialize a
 -- published schedule as working rows. Status transitions use checked operations.
 delete from public.duty_assignments working where working.publication_id is null
 and p_state->'months' ? duty_private.duty_owner(working.day)
 and exists(select 1 from public.duty_months owning where owning.month=duty_private.duty_owner(working.day) and owning.status='draft')
 and working.day not in (select (value->>'day')::date from jsonb_array_elements(p_state->'duties'));
 for item in select value from jsonb_array_elements(p_state->'duties') loop
  if not (p_state->'months' ? duty_private.duty_owner((item->>'day')::date)) or not exists(select 1 from public.duty_months where month=duty_private.duty_owner((item->>'day')::date) and status='draft') then raise exception 'Duty requires its owning month draft'; end if;
  insert into public.duty_assignments(day,end_day,primary_id,secondary_id,manager_override,title,extra_points)
  values((item->>'day')::date,(item->>'end_day')::date,nullif(item->>'primary_id','')::uuid,nullif(item->>'secondary_id','')::uuid,coalesce((item->>'manager_override')::boolean,false),coalesce(item->>'title',''),coalesce((item->>'extra_points')::numeric,0))
  on conflict(publication_id,day) do update set end_day=excluded.end_day,primary_id=excluded.primary_id,secondary_id=excluded.secondary_id,manager_override=excluded.manager_override,title=excluded.title,extra_points=excluded.extra_points;
 end loop;
 if exists(select 1 from public.duty_assignments first_duty join public.duty_assignments other_duty on first_duty.day<other_duty.day and first_duty.end_day>other_duty.day where first_duty.publication_id is null and other_duty.publication_id is null) then raise exception 'Duty dates overlap'; end if;
 if exists(select 1 from jsonb_array_elements(locks_before) l where not exists(select 1 from public.duty_assignments a where a.publication_id is null
  and a.day=(l->>'day')::date and a.end_day=(l->>'end_day')::date and a.primary_id=(l->>'primary_id')::uuid and a.points=(l->>'points')::numeric)) then raise exception 'Explicitly review locks before changing locked work'; end if;
 if p_publish is not null then
  if not (p_state->'months' ? p_publish) or not exists(select 1 from public.duty_months where month=p_publish and status='draft') then raise exception 'An open month draft is required'; end if;
  first_day:=(p_publish||'-01')::date; last_day:=(first_day+interval '1 month'-interval '1 day')::date;
  -- Validate only this month's owned dates, including its final Friday's Saturday.
  if extract(dow from first_day)=6 then first_day:=first_day+1; end if;
  if extract(dow from last_day)=5 then last_day:=last_day+1; end if;
  for d in select generate_series(first_day,last_day,interval '1 day')::date loop
   select * into a from public.duty_assignments where publication_id is null and day<=d and end_day>d;
   if a.primary_id is null or not exists(select 1 from public.duty_members where id=a.primary_id and status='approved' and active) then raise exception 'An active engineer is required on %',d; end if;
   if a.secondary_id is not null and not exists(select 1 from public.duty_members where id=a.secondary_id and status='approved' and active) then raise exception 'Emergency engineer is inactive on %',d; end if;
   if not a.manager_override and exists(select 1 from public.duty_constraints c where c.member_id in (a.primary_id,a.secondary_id) and c.day=d and c.kind='no'
    and not (c.member_id=a.primary_id and exists(select 1 from public.duty_allocations meta,jsonb_array_elements(meta.approvals) approved
     where meta.month=p_publish and meta.publication_id is null and approved->>'rule'='availability' and approved->>'dutyId'=a.day::text and approved->>'engineer'=a.primary_id::text
     and (approved->'dates') ? d::text))) then raise exception 'Availability conflict on %',d; end if;
  end loop;
  select * into allocation from public.duty_allocations where month=p_publish and publication_id is null;
  if allocation.month is not null then
   f:=duty_private.generation_facts(p_publish);
   if allocation.calendar_fingerprint<>md5((select jsonb_agg(d-array['primary','secondary'] order by d->>'id')::text from jsonb_array_elements(f->'duties') d)) then raise exception 'Calendar changed. Confirm allocation again.' using errcode='40001'; end if;
   result:=duty_private.generation_validate(f,allocation.allocation->'targetsUnits',(select jsonb_object_agg(d->>'id',jsonb_build_object('primary',d->'primary','secondary',d->'secondary')) from jsonb_array_elements(f->'duties') d));
   if not (result->>'complete')::boolean then raise exception 'Complete allocation required for publication'; end if;
  end if;
  update public.duty_months set publication_sequence=publication_sequence+1 where month=p_publish returning publication_sequence into next_version;
  insert into public.duty_publications(month,version,published_by) values(p_publish,next_version,auth.uid()) returning id into publication;
  insert into public.duty_assignments(publication_id,day,end_day,primary_id,secondary_id,manager_override,title,extra_points)
  select publication,day,end_day,primary_id,secondary_id,manager_override,title,extra_points from public.duty_assignments where publication_id is null and duty_private.duty_owner(day)=p_publish;
  insert into public.duty_allocations(month,publication_id,allocation_id,allocation,locks,approvals,accounting_fingerprint,calendar_fingerprint,source_publication_id,generation)
  select month,publication,allocation_id,allocation,locks,approvals,accounting_fingerprint,calendar_fingerprint,source_publication_id,generation from public.duty_allocations where month=p_publish and publication_id is null;
  perform duty_private.compensation_publication(p_publish,publication,p_state->'compensation');
  delete from public.duty_assignments where publication_id is null and duty_private.duty_owner(day)=p_publish;
  delete from public.duty_allocations where month=p_publish and publication_id is null;
  update public.duty_months set current_publication_id=publication,status='published',generated=true where month=p_publish;
 end if;
 update public.duty_workspace set revision=revision+1 where id;
end $$;

-- Source: schemas/functions/duty_private/compensation_publication.sql
CREATE OR REPLACE FUNCTION duty_private.compensation_publication(month text, publication uuid, metadata jsonb DEFAULT NULL, deleting boolean DEFAULT false) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
#variable_conflict use_column
declare s jsonb; before_pub jsonb; after_pub jsonb; op jsonb; atoms jsonb; old_atoms jsonb; reservations jsonb; instant bigint; known jsonb; allocation public.duty_allocations; facts jsonb; checked jsonb; assignments jsonb;
begin
 perform 1 from public.duty_workspace where id for update;
 s:=duty_private.compensation_state(); before_pub:=s->'publications'->month;
 instant:=greatest(duty_private.compensation_now(),coalesce((s->'events'->-1->>'at')::bigint,0));
 s:=duty_private.compensation_reconcile(s,instant);
 -- Ordinary copies retain accounting metadata and contribution identities.
 if before_pub->>'id'=publication::text then return; end if;
 if before_pub is null and publication is null then return; end if;
 after_pub:=duty_private.compensation_snapshot(publication);
 if deleting and after_pub is not null then
  select x->'operation'->'after' into known from jsonb_array_elements(s->'events') x where x->'operation'->>'kind'='publication' and x->'operation'->'after'->>'id'=publication::text limit 1;
  -- Pre-cutover history was never committed in this ledger. For an unknown
  -- version compare only this live transition; never replay its old origins.
  if known is not null then after_pub:=known; end if;
 end if;
 if after_pub is not null and known is null then
  atoms:=duty_private.compensation_atoms(after_pub); old_atoms:=duty_private.compensation_atoms(before_pub);
  select coalesce(jsonb_agg(r order by r->>'id' COLLATE "C"),'[]') into reservations from jsonb_array_elements(coalesce(before_pub->'reservations','[]')) r
   where atoms->(r->'capacity'->>'date')->>'primaryId'=old_atoms->(r->'capacity'->>'date')->>'primaryId'
   and (r->'capacity'->>'offset')::bigint+(r->'capacity'->>'units')::bigint<=(atoms->(r->'capacity'->>'date')->>'units')::bigint
   and ((atoms->(r->'capacity'->>'date')->>'endInstantMs')::bigint>instant
    or atoms->(r->'capacity'->>'date')->'endInstantMs'=old_atoms->(r->'capacity'->>'date')->'endInstantMs');
  after_pub:=after_pub||jsonb_build_object('reservations',reservations,'intents',coalesce(before_pub->'intents','[]'));
  -- Existing rota RPCs permit historical manual edits. Keep already completed
  -- accounting facts unchanged while recording the new physical version ID.
  if before_pub is not null then
   after_pub:=jsonb_set(after_pub,'{duties}',coalesce((select jsonb_agg(d order by d->>'startDate') from (
    select d from jsonb_array_elements(before_pub->'duties') d where (extract(epoch from (((d->>'endDate')::date+time '09:00') at time zone 'Asia/Jerusalem'))*1000)::bigint<=instant
    union all select d from jsonb_array_elements(after_pub->'duties') d where not exists(
     select 1 from jsonb_array_elements(before_pub->'duties') old where (extract(epoch from (((old->>'endDate')::date+time '09:00') at time zone 'Asia/Jerusalem'))*1000)::bigint<=instant
     and (d->>'startDate')::date<(old->>'endDate')::date and (old->>'startDate')::date<(d->>'endDate')::date)
    -- A new combined weekend may overlap only a completed Friday. Preserve its
    -- pending Saturday atom and its real Sunday handover instead of dropping it.
    union all select jsonb_build_object('startDate',day::date,'endDate',day::date+1,'primaryId',d->'primaryId','units',1)
    from jsonb_array_elements(after_pub->'duties') d cross join lateral generate_series((d->>'startDate')::date,(d->>'endDate')::date-1,interval '1 day') day
    where (d->>'endDate')::date=(d->>'startDate')::date+2
     and exists(select 1 from jsonb_array_elements(before_pub->'duties') old where (extract(epoch from (((old->>'endDate')::date+time '09:00') at time zone 'Asia/Jerusalem'))*1000)::bigint<=instant
      and (d->>'startDate')::date<(old->>'endDate')::date and (old->>'startDate')::date<(d->>'endDate')::date)
     and not exists(select 1 from jsonb_array_elements(before_pub->'duties') old where (extract(epoch from (((old->>'endDate')::date+time '09:00') at time zone 'Asia/Jerusalem'))*1000)::bigint<=instant
      and day::date>=(old->>'startDate')::date and day::date<(old->>'endDate')::date)
   ) a),'[]'));
  end if;
  select * into allocation from public.duty_allocations where publication_id=publication and duty_allocations.month=month;
  if allocation.month is not null then
   if metadata is not null then raise exception 'Allocation accounting is server-owned'; end if;
   if allocation.source_publication_id is null then
    if allocation.accounting_fingerprint<>md5((s->'events')::text) then raise exception 'Compensation changed. Refresh and review.' using errcode='40001'; end if;
    if before_pub is not null and allocation.allocation->'transfers'<>'[]' then raise exception 'Review published transfer lineage before changing allocation'; end if;
    facts:=duty_private.generation_facts(month);
    metadata:=duty_private.allocation_bind(facts,allocation.allocation,s,allocation.allocation_id,after_pub,instant);
   elsif allocation.origin<>'swap' then
    metadata:=duty_private.allocation_rebind(s,after_pub,allocation.source_publication_id,allocation.allocation_id,instant);
   end if;
  end if;
  if metadata is not null then
   if jsonb_typeof(metadata) IS DISTINCT FROM 'object' or metadata - array['fingerprint','reservations','intents']<>'{}' then raise exception 'Invalid compensation metadata'; end if;
   if metadata->>'fingerprint' is distinct from md5((s->'events')::text) then raise exception 'Compensation changed. Refresh and review.' using errcode='40001'; end if;
   after_pub:=after_pub||jsonb_build_object('reservations',coalesce(metadata->'reservations',reservations),'intents',coalesce(metadata->'intents',before_pub->'intents','[]'));
  end if;
 end if;
 op:=jsonb_build_object('kind','publication','month',month,'beforeId',before_pub->'id','after',after_pub);
 -- Unknown pre-cutover versions preserve completed facts below the ordinary
 -- transition rules. Known deletion uses the core's terminal handling.
 if deleting and (after_pub is null or known is not null) and before_pub is not null then op:=op||'{"mode":"delete"}'; end if;
 perform duty_private.compensation_append(s,op,'publication/'||coalesce(publication::text,'none')||'/'||(coalesce((s->'events'->-1->>'sequence')::bigint,0)+1),instant,coalesce(auth.uid()::text,'system'));
end $$;

-- Source: schemas/functions/duty_private/compensation_transition.sql
CREATE OR REPLACE FUNCTION duty_private.compensation_transition(s jsonb, e jsonb) RETURNS jsonb
 LANGUAGE plpgsql STABLE SET search_path TO '' AS $$
#variable_conflict use_column
declare op jsonb:=e->'operation'; before_pub jsonb:=s->'publications'->(op->>'month'); after_pub jsonb:=nullif(op->'after','null');
 old_atoms jsonb; new_atoms jsonb; a jsonb; b jsonb; known jsonb; proposed jsonb:='{}'::jsonb; excluded jsonb:='{}'::jsonb;
 r jsonb; c jsonb; intent jsonb; cap jsonb; previous jsonb; temporary jsonb:='[]'::jsonb; applied jsonb:='[]'::jsonb; effects jsonb:='[]'::jsonb;
 route jsonb; leg jsonb; trail jsonb; t jsonb; route_index integer; leg_index integer; budget jsonb; route_budgets jsonb:='{}';
 key text; day text; amount bigint; shared bigint; off bigint; cell bigint; idx integer:=0; unchanged boolean; exempt boolean;
begin
 if (before_pub->>'id') is distinct from (op->>'beforeId') or (after_pub is not null and after_pub->>'month'<>op->>'month') then raise exception 'stale-publication'; end if;
 select x->'operation'->'after' into known from jsonb_array_elements(s->'events') x where x->'operation'->>'kind'='publication' and x->'operation'->'after'->>'id'=after_pub->>'id' limit 1;
 if known is not null and known<>after_pub then raise exception 'immutable-publication'; end if;
 if op ? 'mode' and (op->>'mode'<>'delete' or before_pub is null or (after_pub is not null and (known is null or after_pub->>'id'=before_pub->>'id'))) then raise exception 'invalid-publication-deletion'; end if;
 old_atoms:=duty_private.compensation_atoms(before_pub); new_atoms:=duty_private.compensation_atoms(after_pub);
 if after_pub is not null and (jsonb_typeof(after_pub->'reservations') IS DISTINCT FROM 'array' or jsonb_typeof(after_pub->'intents') IS DISTINCT FROM 'array') then raise exception 'invalid-publication-metadata'; end if;
 if exists(select 1 from jsonb_each(new_atoms) x where not (s->'members' ? (value->>'primaryId'))) then raise exception 'invalid-published-duty'; end if;
 if after_pub is not null and coalesce(op->>'mode','')<>'delete' and exists(select 1 from jsonb_each(old_atoms) x where (value->>'endInstantMs')::bigint<=(e->>'at')::bigint and value is distinct from new_atoms->key) then raise exception 'historical-publication-change'; end if;
 for r in select value from jsonb_array_elements(coalesce(after_pub->'reservations','[]')) order by value->>'id' COLLATE "C" loop
  key:=r->>'id'; cap:=r->'capacity'; b:=new_atoms->(cap->>'date');
  if jsonb_typeof(r) IS DISTINCT FROM 'object' or r-array['id','capacity','claim']<>'{}'
   or jsonb_typeof(r->'id') IS DISTINCT FROM 'string' or key !~ '^[A-Za-z0-9][A-Za-z0-9_./:-]{0,159}$'
   or jsonb_typeof(cap) IS DISTINCT FROM 'object' or cap-array['date','offset','units']<>'{}'
   or jsonb_typeof(cap->'date') IS DISTINCT FROM 'string' then raise exception 'invalid-reservation'; end if;
  if coalesce(key,'')='' or proposed ? key then raise exception 'duplicate-contribution'; end if;
  if b is null or duty_private.compensation_units(cap->'offset')+duty_private.compensation_units(cap->'units',true)>(b->>'units')::bigint then raise exception 'invalid-capacity-slice'; end if;
  if b->>'primaryId'<>r->'claim'->>'debtorId' then raise exception 'reservation-primary-mismatch'; end if;
  proposed:=proposed||jsonb_build_object(key,r);
 end loop;
 for r in select value from jsonb_array_elements(coalesce(before_pub->'reservations','[]')) order by value->>'id' COLLATE "C" loop
  key:=r->>'id'; c:=s->'contributions'->key; cap:=c->'capacity'; day:=cap->>'date'; a:=old_atoms->day; b:=new_atoms->day;
  if proposed ? key and proposed->key<>r then raise exception 'contribution-lineage-changed'; end if;
  unchanged:=proposed ? key and b is not null and a->>'primaryId'=b->>'primaryId' and (cap->>'offset')::bigint+(cap->>'units')::bigint<=(b->>'units')::bigint;
  if unchanged then
   if c->>'status' in ('pending','held') then
    if (b->>'endInstantMs')::bigint<=(e->>'at')::bigint and b->'endInstantMs'<>c->'endInstantMs' then raise exception 'historical-repayment-rebind'; end if;
    s:=jsonb_set(s,array['contributions',key,'endInstantMs'],b->'endInstantMs');
   end if;
   continue;
  end if;
  if proposed ? key then raise exception 'changed-duty-reuses-contribution'; end if;
  if c->>'status' not in ('pending','held') then continue; end if;
  s:=jsonb_set(s,array['contributions',key,'status'],'"cancelled"');
  if b is not null and a->>'primaryId'<>b->>'primaryId' then
   off:=(cap->>'offset')::bigint; shared:=greatest(0,least((a->>'units')::bigint,(b->>'units')::bigint,off+(cap->>'units')::bigint)-off); amount:=0;
   for cell in select generate_series(off,off+shared-1) loop
    select exists(select 1 from jsonb_array_elements(coalesce(after_pub->'intents','[]')) i,jsonb_array_elements(i->'capacity') p where i->>'kind'='permanent' and not (s->'intents' ? (i->>'id')) and p->>'date'=day and cell>=(p->>'offset')::bigint and cell<(p->>'offset')::bigint+(p->>'units')::bigint) into exempt;
    if not exempt then excluded:=duty_private.compensation_exclude(excluded,jsonb_build_object('date',day,'offset',cell,'units',1)); amount:=amount+1; end if;
   end loop;
   if amount>0 and c->'claim'->>'creditorId'<>b->>'primaryId' then effects:=effects||jsonb_build_array(jsonb_build_object('debtorId',c->'claim'->'creditorId','creditorId',b->'primaryId','units',amount)); end if;
  end if;
 end loop;
 for intent in select value from jsonb_array_elements(coalesce(after_pub->'intents','[]')) order by value->>'id' COLLATE "C" loop
  key:=intent->>'id';
  if jsonb_typeof(intent) IS DISTINCT FROM 'object' or intent-array['id','kind','fromId','toId','capacity','route']<>'{}'
   or jsonb_typeof(intent->'id') IS DISTINCT FROM 'string' or key !~ '^[A-Za-z0-9][A-Za-z0-9_./:-]{0,159}$'
   or jsonb_typeof(intent->'fromId') IS DISTINCT FROM 'string' or jsonb_typeof(intent->'toId') IS DISTINCT FROM 'string'
   or jsonb_typeof(intent->'capacity') IS DISTINCT FROM 'array' then raise exception 'invalid-intent'; end if;
  if coalesce(key,'')='' or intent->>'kind' not in ('temporary','permanent') or intent->>'kind' is null
   or (select count(*) from jsonb_array_elements(after_pub->'intents') i where i->>'id'=key)>1 then raise exception 'invalid-intent'; end if;
  previous:=s->'intents'->key;
  if previous is not null then if previous<>intent then raise exception 'intent-lineage-changed'; end if; continue; end if;
  if not coalesce(s->'members' ? (intent->>'fromId'),false) or not coalesce(s->'members' ? (intent->>'toId'),false) or intent->>'fromId'=intent->>'toId' then raise exception 'invalid-endpoints'; end if;
  route:=intent->'route';
  if route is not null then
   if jsonb_typeof(route) IS DISTINCT FROM 'array' or jsonb_array_length(route)=0 or route->0->>'fromId'<>intent->>'fromId'
    or route->-1->>'toId'<>intent->>'toId' or route->0->>'kind'<>intent->>'kind' then raise exception 'invalid-intent-route'; end if;
   for leg,route_index in select value,ordinality::int-1 from jsonb_array_elements(route) with ordinality loop
    trail:=leg->'counterparts';
    if jsonb_typeof(leg) IS DISTINCT FROM 'object' or leg-array['fromId','toId','kind','transferIds','deferredClaim','counterparts']<>'{}'
     or jsonb_typeof(leg->'fromId') IS DISTINCT FROM 'string' or jsonb_typeof(leg->'toId') IS DISTINCT FROM 'string'
     or coalesce(leg->>'kind','') not in ('temporary','permanent') or not coalesce(s->'members' ? (leg->>'fromId'),false)
     or not coalesce(s->'members' ? (leg->>'toId'),false) or leg->>'fromId'=leg->>'toId'
     or (route_index>0 and route->(route_index-1)->>'toId'<>leg->>'fromId')
     or jsonb_typeof(leg->'transferIds') IS DISTINCT FROM 'array' or jsonb_array_length(leg->'transferIds')=0
     or jsonb_typeof(trail) IS DISTINCT FROM 'array' or jsonb_array_length(trail)<>jsonb_array_length(leg->'transferIds')
     or (trail->0->>'fromId') IS DISTINCT FROM coalesce(leg->'deferredClaim'->>'debtorId',leg->>'fromId')
     or (trail->-1->>'toId') IS DISTINCT FROM (leg->>'toId') or (leg ? 'deferredClaim' and (leg->'deferredClaim'->>'creditorId') IS DISTINCT FROM (leg->>'fromId')) then raise exception 'invalid-intent-route'; end if;
    if leg ? 'deferredClaim' then
     if jsonb_typeof(leg->'deferredClaim') IS DISTINCT FROM 'object' or (leg->'deferredClaim')-array['debtorId','creditorId','path']<>'{}'
      or jsonb_typeof(leg->'deferredClaim'->'debtorId') IS DISTINCT FROM 'string' or jsonb_typeof(leg->'deferredClaim'->'creditorId') IS DISTINCT FROM 'string' then raise exception 'invalid-intent-route'; end if;
     perform duty_private.compensation_segment(leg->'deferredClaim','{"at":0,"sequence":0,"lotId":"reference"}');
     if duty_private.compensation_locate(s,leg->'deferredClaim') is null then raise exception 'invalid-deferred-source'; end if;
    end if;
    for t,leg_index in select value,ordinality::int-1 from jsonb_array_elements(trail) with ordinality loop
     if jsonb_typeof(t) IS DISTINCT FROM 'object' or t-array['id','fromId','toId','units','kind']<>'{}'
      or jsonb_typeof(t->'id') IS DISTINCT FROM 'string' or jsonb_typeof(leg->'transferIds'->leg_index) IS DISTINCT FROM 'string'
      or jsonb_typeof(t->'fromId') IS DISTINCT FROM 'string' or jsonb_typeof(t->'toId') IS DISTINCT FROM 'string'
      or coalesce(btrim(t->>'id'),'')='' or (t->>'id') IS DISTINCT FROM (leg->'transferIds'->>leg_index) or (t->>'kind') IS DISTINCT FROM (leg->>'kind')
      or (leg_index>0 and trail->(leg_index-1)->>'toId'<>t->>'fromId')
      or not coalesce(s->'members' ? (t->>'fromId'),false) or not coalesce(s->'members' ? (t->>'toId'),false) or t->>'fromId'=t->>'toId' then raise exception 'invalid-intent-route'; end if;
     perform duty_private.compensation_units(t->'units',true);
    end loop;
   end loop;
  end if;
  if jsonb_array_length(intent->'capacity')=0 then raise exception 'unfunded-intent'; end if;
  amount:=0;
  for cap in select value from jsonb_array_elements(intent->'capacity') loop
   if jsonb_typeof(cap) IS DISTINCT FROM 'object' or cap-array['date','offset','units']<>'{}' or jsonb_typeof(cap->'date') IS DISTINCT FROM 'string' then raise exception 'invalid-capacity-slice'; end if;
   day:=cap->>'date'; a:=old_atoms->day; b:=new_atoms->day;
   if b is null or duty_private.compensation_units(cap->'offset')+duty_private.compensation_units(cap->'units',true)>(b->>'units')::bigint then raise exception 'invalid-capacity-slice'; end if;
   if b->>'primaryId'<>intent->>'toId' then raise exception 'intent-primary-mismatch'; end if;
   if a is not null and a->>'primaryId'<>intent->>'toId' and a->>'primaryId'<>intent->>'fromId' then raise exception 'intent-counterpart-mismatch'; end if;
   if a->>'primaryId'=intent->>'toId' and (cap->>'offset')::bigint<least((a->>'units')::bigint,(b->>'units')::bigint) then raise exception 'unchanged-capacity-intent'; end if;
   excluded:=duty_private.compensation_exclude(excluded,cap); amount:=amount+(cap->>'units')::bigint;
  end loop;
  s:=jsonb_set(s,array['intents',key],intent);
  if route is not null then
   for leg,route_index in select value,ordinality::int-1 from jsonb_array_elements(route) with ordinality loop
    for t in select value from jsonb_array_elements(leg->'counterparts') loop
     if (t->>'units')::bigint<amount then raise exception 'unfunded-intent-route'; end if;
     budget:=route_budgets->(t->>'id');
     if budget is not null and budget->'transfer'<>t then raise exception 'intent-counterpart-lineage-changed'; end if;
     if coalesce((budget->>'used')::bigint,0)+amount>(t->>'units')::bigint then raise exception 'unfunded-intent-route'; end if;
     route_budgets:=jsonb_set(route_budgets,array[t->>'id'],jsonb_build_object('transfer',t,'used',coalesce((budget->>'used')::bigint,0)+amount));
    end loop;
    if leg->>'kind'='temporary' then applied:=applied||jsonb_build_array(jsonb_build_object('id',key||'/route/'||route_index,
     'fromId',leg->'fromId','toId',leg->'toId','units',amount)); end if;
   end loop;
  elsif intent->>'kind'='temporary' then applied:=applied||jsonb_build_array(intent||jsonb_build_object('units',amount)); end if;
 end loop;
 for day,a in select * from jsonb_each(old_atoms) order by key loop
  b:=new_atoms->day;
  if (a->>'endInstantMs')::bigint<=(e->>'at')::bigint or b is null or a->>'primaryId'=b->>'primaryId' then continue; end if;
  shared:=least((a->>'units')::bigint,(b->>'units')::bigint); amount:=0;
  for cell in select generate_series(0,shared-1) loop
   if not coalesce(excluded->day,'[]') @> jsonb_build_array(cell) then
    excluded:=duty_private.compensation_exclude(excluded,jsonb_build_object('date',day,'offset',cell,'units',1)); amount:=amount+1;
   end if;
  end loop;
  if amount>0 then effects:=effects||jsonb_build_array(jsonb_build_object('debtorId',a->'primaryId','creditorId',b->'primaryId','units',amount)); end if;
 end loop;
 for c in select value from jsonb_array_elements(effects) loop
  temporary:=temporary||jsonb_build_array(duty_private.compensation_segment(c||jsonb_build_object('path',jsonb_build_array(jsonb_build_object('lotId',idx::text,'offset',0,'units',c->'units'))),jsonb_build_object('at',e->'at','sequence',e->'sequence','lotId',idx::text))); idx:=idx+1;
 end loop;
 idx:=0;
 for c in select value from jsonb_array_elements(duty_private.compensation_normalize(temporary,s->'members')->'claims') loop
  s:=duty_private.compensation_lot(s,e,(e->>'sourceKey')||'/transfer/'||idx,c->>'debtorId',c->>'creditorId',(c->>'units')::bigint); idx:=idx+1;
 end loop;
 for intent in select value from jsonb_array_elements(applied) loop
  s:=duty_private.compensation_lot(s,e,(e->>'sourceKey')||'/intent/'||(intent->>'id'),intent->>'fromId',intent->>'toId',(intent->>'units')::bigint);
 end loop;
 if after_pub is null then s:=jsonb_set(s,'{publications}',(s->'publications')-(op->>'month'));
 else s:=jsonb_set(s,array['publications',op->>'month'],after_pub); end if;
 return jsonb_build_object('state',s,'proposed',proposed,'excluded',excluded,'before',before_pub,'atoms',new_atoms);
end $$;

-- Source: schemas/policies/duty_allocations.sql
CREATE POLICY allocations_read ON public.duty_allocations FOR SELECT TO authenticated
 USING ((SELECT duty_private.is_manager()));

-- Source: schemas/functions/duty_private/allocation_bind.sql
-- Bind independently compiled intent to exclusive real primary date capacity.
-- Returned metadata is server-produced; callers cannot supply lots or balances.
CREATE OR REPLACE FUNCTION duty_private.allocation_bind(f jsonb, draft jsonb, s jsonb, allocation_id uuid, publication jsonb, instant bigint) RETURNS jsonb
 LANGUAGE plpgsql STABLE SET search_path TO '' AS $$
#variable_conflict use_column
declare assignments jsonb; checked jsonb; plan jsonb; atoms jsonb; taken jsonb; funding jsonb; route jsonb; leg jsonb;
 intents jsonb:='[]'; reservations jsonb:='[]'; before_state jsonb:=s; next_state jsonb; e jsonb; c jsonb; r jsonb; candidate jsonb; intent jsonb;
 pool jsonb:='[]'; entry jsonb; original jsonb; ref jsonb; capacity jsonb; idx integer:=0; pos integer; n bigint; remaining bigint; off bigint; lo bigint; hi bigint;
 leg_index integer; path_index integer; routed_units bigint; new_lot text;
begin
 select jsonb_object_agg(d->>'id',jsonb_build_object('primary',d->'primary','secondary',d->'secondary')) into assignments from jsonb_array_elements(f->'duties') d;
 checked:=duty_private.generation_validate(f,draft->'targetsUnits',assignments);
 plan:=duty_private.allocation_compile(f,draft,checked->'actualUnits',s);
 atoms:=duty_private.compensation_atoms(publication);
 for funding in select value from jsonb_array_elements(plan->'funding') loop
  taken:=duty_private.allocation_take(atoms,funding->>'carrierId',(funding->>'units')::bigint); atoms:=taken->'atoms';
  select jsonb_agg((l-array['units','normalizedDeferredClaims'])||jsonb_build_object('counterparts',
   (select jsonb_agg(t order by j) from jsonb_array_elements_text(l->'transferIds') with ordinality ids(id,j)
     join jsonb_array_elements(draft->'transfers') t on t->>'id'=id)) order by i) into route
   from jsonb_array_elements(funding->'route') with ordinality legs(l,i);
  intents:=intents||jsonb_build_array(jsonb_build_object('id','allocation/'||allocation_id||'/intent/'||idx,
   'kind',route->0->'kind','fromId',route->0->'fromId','toId',funding->'carrierId','route',route,'capacity',taken->'capacity')); idx:=idx+1;
 end loop;
 publication:=publication||jsonb_build_object('intents',intents,'reservations','[]'::jsonb);
 e:=jsonb_build_object('sequence',coalesce((s->'events'->-1->>'sequence')::bigint,0)+1,'sourceKey','publication/'||(publication->>'id')||'/'||(coalesce((s->'events'->-1->>'sequence')::bigint,0)+1),
  'at',instant,'actor',coalesce(auth.uid()::text,'system'),'operation',jsonb_build_object('kind','publication','month',publication->'month',
  'beforeId',s->'publications'->(publication->>'month')->'id','after',publication));
 next_state:=duty_private.compensation_apply(s,e);
 -- A deferral may normalize through the original source's oldest prefix, but
 -- cannot quietly route through another obligation or disappear by netting.
 for intent in select value from jsonb_array_elements(intents) loop
  for leg,leg_index in select value,ordinality::int-1 from jsonb_array_elements(intent->'route') with ordinality where value ? 'deferredClaim' loop
   new_lot:=(e->>'sourceKey')||'/intent/'||(intent->>'id')||'/route/'||leg_index; routed_units:=0;
   for c in select value from jsonb_array_elements(next_state->'claims') loop
    select i::int-1 into path_index from jsonb_array_elements(c->'path') with ordinality a(p,i) where p->>'lotId'=new_lot;
    if path_index is null or path_index<=0 then continue; end if;
    if exists(select 1 from jsonb_array_elements(s->'claims') old where old->>'debtorId'=leg->'deferredClaim'->>'debtorId'
     and old->>'creditorId'=leg->>'fromId' and jsonb_array_length(old->'path')=path_index and not exists(
      select 1 from jsonb_array_elements(old->'path') with ordinality a(p,i) where p->>'lotId'<>c->'path'->(i::int-1)->>'lotId'
       or (c->'path'->(i::int-1)->>'offset')::bigint<(p->>'offset')::bigint
       or (c->'path'->(i::int-1)->>'offset')::bigint+(c->>'units')::bigint>(p->>'offset')::bigint+(p->>'units')::bigint)) then routed_units:=routed_units+(c->>'units')::bigint; end if;
   end loop;
   if routed_units<>(select sum((p->>'units')::bigint) from jsonb_array_elements(intent->'capacity') p) then raise exception 'review-normalized-deferral-route'; end if;
  end loop;
 end loop;
 if exists(select 1 from jsonb_each(s->'contributions') c where c.value->>'status'='pending'
  and next_state->'contributions'->c.key->>'holdReason'='claim-changed') then raise exception 'review-existing-reservation-normalization'; end if;
 -- Preserve each approved source's budget, but permit its still-unreserved
 -- suffix after new transfer normalization consumes the oldest prefix.
 for original in select value from jsonb_array_elements(duty_private.compensation_candidates(s)) loop
  for candidate in select value from jsonb_array_elements(duty_private.compensation_candidates(next_state)) where value->>'debtorId'=original->>'debtorId'
   and value->>'creditorId'=original->>'creditorId' and jsonb_array_length(value->'path')=jsonb_array_length(original->'path') loop
   if exists(select 1 from jsonb_array_elements(candidate->'path') with ordinality a(p,i) where p->>'lotId'<>original->'path'->(i::int-1)->>'lotId') then continue; end if;
   select greatest(0,max((original->'path'->(i::int-1)->>'offset')::bigint-(p->>'offset')::bigint)),
    least((candidate->>'units')::bigint,min((original->'path'->(i::int-1)->>'offset')::bigint+(original->>'units')::bigint-(p->>'offset')::bigint)) into lo,hi
    from jsonb_array_elements(candidate->'path') with ordinality a(p,i);
   if hi>lo then pool:=pool||jsonb_build_array(jsonb_build_object('source',original,'claim',duty_private.compensation_slice(candidate,hi-lo,lo),'units',hi-lo)); end if;
  end loop;
 end loop;
 idx:=0;
 for r in select value from jsonb_array_elements(plan->'repayments') loop
  remaining:=(r->>'units')::bigint;
  for entry,pos in select value,ordinality::int-1 from jsonb_array_elements(pool) with ordinality where (value->>'units')::bigint>0 loop
   if remaining=0 then exit; end if;
   original:=entry->'source';
   if duty_private.compensation_locate(jsonb_build_object('claims',jsonb_build_array(original)),r->'claim') is null then continue; end if;
   n:=least(remaining,(entry->>'units')::bigint); remaining:=remaining-n; ref:=duty_private.compensation_slice(entry->'claim',n);
   taken:=duty_private.allocation_take(atoms,ref->>'debtorId',n); atoms:=taken->'atoms'; off:=0;
   for capacity in select value from jsonb_array_elements(taken->'capacity') loop
    reservations:=reservations||jsonb_build_array(jsonb_build_object('id','allocation/'||allocation_id||'/repayment/'||idx,
     'capacity',capacity,'claim',duty_private.compensation_slice(ref,(capacity->>'units')::bigint,off)));
    off:=off+(capacity->>'units')::bigint; idx:=idx+1;
   end loop;
   pool:=jsonb_set(pool,array[pos::text,'units'],to_jsonb((entry->>'units')::bigint-n));
   if (entry->>'units')::bigint>n then pool:=jsonb_set(pool,array[pos::text,'claim'],duty_private.compensation_slice(entry->'claim',(entry->>'units')::bigint-n,n)); end if;
  end loop;
 end loop;
 publication:=publication||jsonb_build_object('reservations',reservations);
 -- The final replay independently verifies routes, normalization and exclusivity.
 perform duty_private.compensation_apply(before_state,jsonb_set(e,'{operation,after}',publication));
 return jsonb_build_object('intents',intents,'reservations',reservations,'fingerprint',md5((before_state->'events')::text));
end $$;

-- Source: schemas/functions/duty_private/allocation_compile.sql
-- Reconstruct allocation tokens from reviewed counterpart operations. All claim
-- capacity comes from the server's projected ledger, excluding other reservations.
CREATE OR REPLACE FUNCTION duty_private.allocation_compile(f jsonb, draft jsonb, actual jsonb, s jsonb) RETURNS jsonb
 LANGUAGE plpgsql STABLE SET search_path TO '' AS $$
#variable_conflict use_column
declare ids jsonb:=f->'seniority'; candidates jsonb:=duty_private.compensation_candidates(s); expected jsonb; table_value jsonb;
 tokens jsonb:='[]'; reserved jsonb:='[]'; funding jsonb:='[]'; used jsonb:='[]'; seen text[]:='{}';
 r jsonb; c jsonb; t jsonb; moved jsonb; transfer jsonb; route jsonb; leg jsonb; ref jsonb; ranges int8multirange; part int8range;
 id text; name text; n bigint; take bigint; remaining bigint; capacity bigint; idx integer; position integer; amount bigint; total bigint;
begin
 if jsonb_typeof(draft) IS DISTINCT FROM 'object' or draft-array['baselineUnits','offeredUnits','targetsUnits','repayments','transfers','pending','sourceKey']<>'{}'
  or jsonb_typeof(draft->'sourceKey') IS DISTINCT FROM 'string' or coalesce(draft->>'sourceKey','')=''
  or jsonb_typeof(draft->'repayments') IS DISTINCT FROM 'array' or jsonb_typeof(draft->'transfers') IS DISTINCT FROM 'array'
  or draft->'pending' IS DISTINCT FROM '[]'::jsonb then raise exception 'invalid-confirmed-allocation'; end if;
 foreach name in array array['baselineUnits','offeredUnits','targetsUnits'] loop
  table_value:=draft->name;
  if jsonb_typeof(table_value) IS DISTINCT FROM 'object' or (select count(*) from jsonb_each(table_value))<>jsonb_array_length(ids)
   or exists(select 1 from jsonb_each(table_value) where not ids ? key) then raise exception 'invalid-allocation-members'; end if;
  total:=0; for id in select jsonb_array_elements_text(ids) loop total:=total+duty_private.compensation_units(table_value->id); end loop;
  if total<>(select sum((x->>'units')::bigint) from jsonb_array_elements(f->'duties') x) then raise exception 'invalid-allocation-total'; end if;
 end loop;
 expected:=draft->'baselineUnits';
 for id in select x from jsonb_array_elements_text(ids) x order by x COLLATE "C" loop
  tokens:=tokens||jsonb_build_array(jsonb_build_object('carrier',id,'origin',id,'units',expected->id,'claim',null,'trail','[]'::jsonb,'prior','[]'::jsonb));
 end loop;
 for r in select value from jsonb_array_elements(draft->'repayments') loop
  if jsonb_typeof(r) IS DISTINCT FROM 'object' or r-array['claim','units']<>'{}' then raise exception 'invalid-repayment-source'; end if;
  n:=duty_private.compensation_units(r->'units',true);
  c:=duty_private.compensation_locate(jsonb_build_object('claims',candidates),r->'claim');
  if c is null or r->'claim'->'priority' IS DISTINCT FROM c->'priority' or r->'claim'->'units' IS DISTINCT FROM r->'units'
   or r->'claim'->'frozen' IS DISTINCT FROM 'false'::jsonb or r->'claim'->'path'->0->'units' IS DISTINCT FROM r->'units'
   or not ids ? (c->>'debtorId') or not ids ? (c->>'creditorId') then raise exception 'invalid-repayment-source'; end if;
  if exists(select 1 from jsonb_array_elements(used) a,jsonb_array_elements(a->'path') p,jsonb_array_elements(r->'claim'->'path') q
    where p->>'lotId'=q->>'lotId' and (p->>'offset')::bigint<(q->>'offset')::bigint+n and (q->>'offset')::bigint<(p->>'offset')::bigint+(p->>'units')::bigint) then raise exception 'duplicate-repayment-source'; end if;
  used:=used||jsonb_build_array(r->'claim');
  expected:=jsonb_set(expected,array[c->>'debtorId'],to_jsonb((expected->>(c->>'debtorId'))::bigint+n));
  expected:=jsonb_set(expected,array[c->>'creditorId'],to_jsonb((expected->>(c->>'creditorId'))::bigint-n));
  remaining:=n;
  for t,position in select value,ordinality::integer-1 from jsonb_array_elements(tokens) with ordinality where value->>'carrier'=c->>'creditorId' and value->'claim'='null' loop
   take:=least(remaining,(t->>'units')::bigint); remaining:=remaining-take;
   tokens:=jsonb_set(tokens,array[position::text,'units'],to_jsonb((t->>'units')::bigint-take));
  end loop;
  if remaining<>0 then raise exception 'repayment-exceeds-creditor-relief'; end if;
  tokens:=tokens||jsonb_build_array(jsonb_build_object('carrier',c->'debtorId','origin',c->'creditorId','units',n,'claim',r->'claim','trail','[]'::jsonb,'prior','[]'::jsonb));
 end loop;
 if expected<>draft->'offeredUnits' then raise exception 'invalid-offered-allocation'; end if;
 for transfer in select value from jsonb_array_elements(draft->'transfers') loop
  if jsonb_typeof(transfer) IS DISTINCT FROM 'object' or transfer-array['id','fromId','toId','units','kind']<>'{}'
   or coalesce(btrim(transfer->>'id'),'')='' or transfer->>'id'=any(seen) or coalesce(transfer->>'kind','') not in ('temporary','permanent')
   or not ids ? (transfer->>'fromId') or not ids ? (transfer->>'toId') or transfer->>'fromId'=transfer->>'toId' then raise exception 'invalid-counterpart'; end if;
  seen:=array_append(seen,transfer->>'id'); remaining:=duty_private.compensation_units(transfer->'units',true);
  expected:=jsonb_set(expected,array[transfer->>'fromId'],to_jsonb((expected->>(transfer->>'fromId'))::bigint-remaining));
  expected:=jsonb_set(expected,array[transfer->>'toId'],to_jsonb((expected->>(transfer->>'toId'))::bigint+remaining));
  -- Deferral consumes newest repayment tokens first, then ordinary responsibility.
  for t,position in select value,ordinality::integer-1 from jsonb_array_elements(tokens) with ordinality
   where value->>'carrier'=transfer->>'fromId' and (value->>'units')::bigint>0
   order by (value->'claim'<>'null') desc,(value->'claim'->'priority'->>'at')::bigint desc,
    (value->'claim'->'priority'->>'sequence')::bigint desc,value->'claim'->'priority'->>'lotId' COLLATE "C" desc,value->'claim'->>'id' COLLATE "C" desc,ordinality loop
   if remaining=0 then exit; end if;
   take:=least(remaining,(t->>'units')::bigint); remaining:=remaining-take;
   moved:=duty_private.allocation_part(t,take,(t->>'units')::bigint-take);
   if (t->>'units')::bigint>take then tokens:=jsonb_set(tokens,array[position::text],duty_private.allocation_part(t,(t->>'units')::bigint-take));
   else tokens:=jsonb_set(tokens,array[position::text,'units'],'0'); end if;
   moved:=jsonb_set(moved,'{carrier}',transfer->'toId');
   if transfer->>'kind'='permanent' then
    if jsonb_array_length(moved->'trail')>0 and moved->>'origin'<>transfer->>'fromId' then
     leg:=jsonb_build_object('fromId',moved->'origin','toId',transfer->'fromId','units',take,'kind','temporary','transferIds',moved->'trail');
     if moved->'claim'<>'null' then leg:=leg||jsonb_build_object('deferredClaim',duty_private.compensation_slice(moved->'claim',take)); end if;
     moved:=jsonb_set(moved,'{prior}',(moved->'prior')||jsonb_build_array(leg));
    end if;
    moved:=moved||jsonb_build_object('origin',transfer->'toId','claim',null,'trail','[]'::jsonb,'prior',(moved->'prior')||jsonb_build_array(
     jsonb_build_object('fromId',transfer->'fromId','toId',transfer->'toId','kind','permanent','units',take,'transferIds',jsonb_build_array(transfer->'id'))));
   else moved:=jsonb_set(moved,'{trail}',(moved->'trail')||jsonb_build_array(transfer->'id')); end if;
   tokens:=tokens||jsonb_build_array(moved);
  end loop;
  if remaining<>0 then raise exception 'transfer-exceeds-source-target'; end if;
 end loop;
 if expected<>draft->'targetsUnits' then raise exception 'unexplained-target-edit'; end if;
 for id in select x from jsonb_array_elements_text(ids) x order by x COLLATE "C" loop
  capacity:=(actual->>id)::bigint;
  for t in select value from jsonb_array_elements(tokens) tok(value) where value->>'carrier'=id and (value->>'units')::bigint>0
   order by case when value->'claim'<>'null' and value->>'carrier'=value->'claim'->>'debtorId' or
     (value->'claim'='null' and jsonb_array_length(value->'trail')>0 and exists(select 1 from jsonb_array_elements(candidates) c where c->>'debtorId'=id and c->>'creditorId'=tok.value->>'origin')) then 1
    when jsonb_array_length(value->'trail')>0 and value->>'origin'<>id then 2 else 0 end,
    (value->'claim'->'priority'->>'at')::bigint,(value->'claim'->'priority'->>'sequence')::bigint,
    value->'claim'->'priority'->>'lotId' COLLATE "C",value->'claim'->>'id' COLLATE "C" loop
   take:=least(capacity,(t->>'units')::bigint); capacity:=capacity-take; if take=0 then continue; end if;
   moved:=duty_private.allocation_part(t,take); route:=moved->'prior';
   if moved->'claim'<>'null' and moved->>'carrier'=moved->'claim'->>'debtorId' then reserved:=reserved||jsonb_build_array(jsonb_build_object('claim',duty_private.compensation_slice(moved->'claim',take),'units',take));
   elsif jsonb_array_length(moved->'trail')>0 and moved->>'origin'<>id then
    leg:=jsonb_build_object('fromId',moved->'origin','toId',id,'units',take,'kind','temporary','transferIds',moved->'trail');
    if moved->'claim'<>'null' then leg:=leg||jsonb_build_object('deferredClaim',duty_private.compensation_slice(moved->'claim',take)); end if;
    route:=route||jsonb_build_array(leg);
   end if;
   if jsonb_array_length(route)>0 then funding:=funding||jsonb_build_array(jsonb_build_object('carrierId',id,'units',take,'route',route)); end if;
  end loop;
 end loop;
 -- Reverse ordinary burdens repay existing debt; publication must not forgive
 -- it by immediately creating an opposing origin before any work completes.
 for t,position in select value,ordinality::integer-1 from jsonb_array_elements(funding) with ordinality loop
  for leg in select value from jsonb_array_elements(t->'route') where value->>'kind'='temporary' and not value ? 'deferredClaim' loop
   if not exists(select 1 from jsonb_array_elements(s->'claims') c where c->>'debtorId'=leg->>'toId' and c->>'creditorId'=leg->>'fromId') then continue; end if;
   if jsonb_array_length(t->'route')<>1 or leg->>'toId'<>t->>'carrierId' then raise exception 'review-compound-reverse-obligation'; end if;
   remaining:=(t->>'units')::bigint;
   for c in select value from jsonb_array_elements(candidates) where value->>'debtorId'=leg->>'toId' and value->>'creditorId'=leg->>'fromId' loop
    ranges:=int8multirange(int8range(0,(c->>'units')::bigint,'[)'));
    for r in select value from jsonb_array_elements(reserved) where value->'claim'->>'debtorId'=c->>'debtorId' and value->'claim'->>'creditorId'=c->>'creditorId' and value->'claim'->'path'->0->>'lotId'=c->'path'->0->>'lotId' loop
     amount:=(r->'claim'->'path'->0->>'offset')::bigint-(c->'path'->0->>'offset')::bigint;
     ranges:=ranges-int8multirange(int8range(amount,amount+(r->>'units')::bigint,'[)'));
    end loop;
    for part in select unnest(ranges) loop
     take:=least(remaining,upper(part)-lower(part)); if take=0 then continue; end if;
     reserved:=reserved||jsonb_build_array(jsonb_build_object('claim',duty_private.compensation_slice(c,take,lower(part)),'units',take)); remaining:=remaining-take;
    end loop;
   end loop;
   if remaining<>0 then raise exception 'review-unavailable-reverse-obligation'; end if;
   funding:=jsonb_set(funding,array[position::text,'units'],'0');
  end loop;
 end loop;
 return jsonb_build_object('repayments',reserved,'funding',coalesce((select jsonb_agg(x) from jsonb_array_elements(funding) x where (x->>'units')::bigint>0),'[]'));
end $$;

-- Source: schemas/functions/duty_private/allocation_part.sql
CREATE OR REPLACE FUNCTION duty_private.allocation_part(t jsonb, amount bigint, off bigint DEFAULT 0) RETURNS jsonb
 LANGUAGE plpgsql STABLE SET search_path TO '' AS $$
declare claim jsonb:=nullif(t->'claim','null'); prior jsonb;
begin
 if amount<=0 or off<0 or off+amount>(t->>'units')::bigint then raise exception 'invalid-token-slice'; end if;
 if claim is not null then claim:=claim||duty_private.compensation_slice(claim,amount,off)||jsonb_build_object('units',amount); end if;
 select coalesce(jsonb_agg((p||jsonb_build_object('units',amount))||case when p ? 'deferredClaim' then jsonb_build_object('deferredClaim',duty_private.compensation_slice(p->'deferredClaim',amount,off)) else '{}' end order by i),'[]')
 into prior from jsonb_array_elements(t->'prior') with ordinality a(p,i);
 return t||jsonb_build_object('units',amount,'claim',claim,'prior',prior);
end $$;

-- Source: schemas/functions/duty_private/allocation_take.sql
CREATE OR REPLACE FUNCTION duty_private.allocation_take(atoms jsonb, engineer text, amount bigint) RETURNS jsonb
 LANGUAGE plpgsql STABLE SET search_path TO '' AS $$
declare day text; a jsonb; n bigint; capacity jsonb:='[]';
begin
 for day,a in select * from jsonb_each(atoms) where value->>'primaryId'=engineer order by key loop
  n:=least(amount,(a->>'units')::bigint-coalesce((a->>'offset')::bigint,0)); if n=0 then continue; end if;
  capacity:=capacity||jsonb_build_array(jsonb_build_object('date',day,'offset',coalesce((a->>'offset')::bigint,0),'units',n));
  atoms:=jsonb_set(atoms,array[day,'offset'],to_jsonb(coalesce((a->>'offset')::bigint,0)+n)); amount:=amount-n;
 end loop;
 if amount<>0 then raise exception 'unbindable-duty-capacity'; end if;
 return jsonb_build_object('atoms',atoms,'capacity',capacity);
end $$;

-- Source: schemas/functions/duty_private/compensation_candidates.sql
-- Unreserved normalized slices, oldest first. Held reservations remain exclusive.
CREATE OR REPLACE FUNCTION duty_private.compensation_candidates(s jsonb) RETURNS jsonb
 LANGUAGE plpgsql STABLE SET search_path TO '' AS $$
declare c jsonb; r jsonb; a jsonb; b jsonb; ranges int8multirange; part int8range; result jsonb:='[]'; lo bigint; hi bigint;
begin
 for c in select value from jsonb_array_elements(s->'claims') where not (value->>'frozen')::boolean
  order by (value->'priority'->>'at')::bigint,(value->'priority'->>'sequence')::bigint,value->'priority'->>'lotId' COLLATE "C",value->>'id' COLLATE "C" loop
  ranges:=int8multirange(int8range(0,(c->>'units')::bigint,'[)'));
  for r in select value from jsonb_each(s->'contributions') where value->>'status' in ('pending','held') loop
   for a in select value from jsonb_array_elements(c->'path') loop
    for b in select value from jsonb_array_elements(r->'claim'->'path') where value->>'lotId'=a->>'lotId' loop
     lo:=greatest(0,(b->>'offset')::bigint-(a->>'offset')::bigint); hi:=least((c->>'units')::bigint,(b->>'offset')::bigint+(b->>'units')::bigint-(a->>'offset')::bigint);
     if hi>lo then ranges:=ranges-int8multirange(int8range(lo,hi,'[)')); end if;
    end loop;
   end loop;
  end loop;
  for part in select unnest(ranges) loop result:=result||jsonb_build_array(duty_private.compensation_segment(duty_private.compensation_slice(c,upper(part)-lower(part),lower(part)),c->'priority')); end loop;
 end loop;
 return result;
end $$;

-- Source: schemas/functions/duty_private/confirm_allocation.sql
CREATE OR REPLACE FUNCTION duty_private.confirm_allocation(p_month text, p_allocation jsonb, p_locks jsonb, p_approvals jsonb, p_revision bigint, p_fingerprint text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare ctx jsonb; facts jsonb; assignments jsonb; checked jsonb; projected jsonb; old_meta public.duty_allocations;
begin
 ctx:=duty_private.generation_context(p_month,p_revision);
 if p_fingerprint IS DISTINCT FROM ctx->>'fingerprint' then raise exception 'Generation inputs changed. Refresh and review.' using errcode='40001'; end if;
 if length(p_allocation::text)>1000000 or length(p_approvals::text)>100000 or length(p_locks::text)>100000 then raise exception 'Allocation too large'; end if;
 if not exists(select 1 from public.duty_months where month=p_month and status='draft') then raise exception 'An open month draft is required'; end if;
 facts:=(ctx->'facts')||jsonb_build_object('locks',p_locks,'approvals',p_approvals);
 if exists(select 1 from jsonb_array_elements(p_locks) l where not exists(select 1 from jsonb_array_elements(facts->'duties') d where d->>'id'=l->>'dutyId' and d->>'primary'=l->>'engineer')) then raise exception 'Lock requires its existing primary assignment'; end if;
 select jsonb_object_agg(d->>'id',jsonb_build_object('primary',
  (select l->'engineer' from jsonb_array_elements(p_locks) l where l->>'dutyId'=d->>'id'),'secondary',d->'secondary')) into assignments from jsonb_array_elements(facts->'duties') d;
 checked:=duty_private.generation_validate(facts,p_allocation->'targetsUnits',assignments);
 projected:=duty_private.compensation_reconcile(duty_private.compensation_state(),greatest((ctx->>'actualAtMs')::bigint,(ctx->>'coverageStartMs')::bigint),false);
 select * into old_meta from public.duty_allocations where month=p_month and publication_id is null;
 -- Copies retain original reviewed provenance, even when its claims have already
 -- settled. A new proposal must use current unreserved sources instead.
 if old_meta.source_publication_id is null or old_meta.allocation IS DISTINCT FROM p_allocation then
  perform duty_private.allocation_compile(facts,p_allocation,checked->'actualUnits',projected);
  perform duty_private.allocation_baseline(facts,p_allocation->'baselineUnits');
  if old_meta.month is not null and old_meta.calendar_fingerprint=md5((select jsonb_agg(d-array['primary','secondary'] order by d->>'id')::text from jsonb_array_elements(facts->'duties') d))
   and (select array_agg(key order by key) from jsonb_each(old_meta.allocation->'baselineUnits'))=(select array_agg(key order by key) from jsonb_each(p_allocation->'baselineUnits'))
   and old_meta.allocation->'baselineUnits'<>p_allocation->'baselineUnits' then raise exception 'Ordinary baseline is immutable. Classify target changes as transfers.'; end if;
  if old_meta.source_publication_id is not null and p_allocation->'transfers'<>'[]' then raise exception 'Review published transfer lineage before changing allocation'; end if;
 end if;
 insert into public.duty_allocations(month,allocation,locks,approvals,accounting_fingerprint,calendar_fingerprint)
 values(p_month,p_allocation,p_locks,p_approvals,ctx->>'accountingFingerprint',md5((select jsonb_agg(d-array['primary','secondary'] order by d->>'id')::text from jsonb_array_elements(facts->'duties') d)))
 on conflict(month,publication_id) do update set allocation=excluded.allocation,locks=excluded.locks,approvals=excluded.approvals,
  accounting_fingerprint=excluded.accounting_fingerprint,calendar_fingerprint=excluded.calendar_fingerprint,generation=null,
  allocation_id=case when duty_allocations.allocation=excluded.allocation then duty_allocations.allocation_id else gen_random_uuid() end,
  source_publication_id=case when duty_allocations.allocation=excluded.allocation then duty_allocations.source_publication_id end;
 update public.duty_workspace set revision=revision+1 where id;
 return duty_private.generation_context(p_month,(select revision from public.duty_workspace where id));
end $$;

-- Source: schemas/functions/duty_private/generation_context.sql
-- Also used inside checked writes, after taking the shared revision lock.
CREATE OR REPLACE FUNCTION duty_private.generation_context(p_month text, p_revision bigint) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare s jsonb; before_count integer; instant bigint; opening bigint; facts jsonb; projected jsonb;
begin
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 perform duty_private.check_revision(p_revision);
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 instant:=duty_private.compensation_now();
 s:=duty_private.compensation_state(); before_count:=jsonb_array_length(s->'events');
 s:=duty_private.compensation_reconcile(s,greatest(instant,coalesce((s->'events'->-1->>'at')::bigint,0)));
 if before_count<>jsonb_array_length(s->'events') then update public.duty_workspace set revision=revision+1 where id; end if;
 facts:=duty_private.generation_facts(p_month);
 opening:=(extract(epoch from (((facts->'duties'->0->>'startDate')::date+time '09:00') at time zone 'Asia/Jerusalem'))*1000)::bigint;
 projected:=duty_private.compensation_reconcile(s,greatest(instant,opening),false);
 return jsonb_build_object('revision',(select revision from public.duty_workspace where id),'actualAtMs',instant,'coverageStartMs',opening,
  'generationAllowed',instant<opening,'facts',facts,'actual',duty_private.compensation_view(s),'projected',duty_private.compensation_view(projected),
  'accountingFingerprint',md5((s->'events')::text),'fingerprint',md5(facts::text||(s->'events')::text));
end $$;

-- Source: schemas/functions/duty_private/generation_duties.sql
-- Canonicalize persisted calendar facts, filling absent ordinary blocks. Saturday
-- belongs to Friday's owner, even across a year. No client weights enter here.
CREATE OR REPLACE FUNCTION duty_private.generation_duties(p_month text) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
declare d date; until_day date; finish date; pub uuid; a public.duty_assignments;
 result jsonb:='[]'; split boolean; units bigint;
begin
 if p_month IS NULL or p_month !~ '^(19[0-9]{2}|[2-9][0-9]{3})-(0[1-9]|1[0-2])$' or p_month>='9999' then raise exception 'invalid-month'; end if;
 select case when status='published' then current_publication_id end into pub from public.duty_months where month=p_month;
 d:=(p_month||'-01')::date; finish:=(d+interval '1 month')::date;
 if extract(dow from d)=6 then d:=d+1; end if;
 if extract(dow from finish)=6 then finish:=finish+1; end if;
 while d<finish loop
  select * into a from public.duty_assignments where publication_id is not distinct from pub and day=d;
  split:=extract(dow from d)=5 and (coalesce(a.end_day=d+1,false) or exists(select 1 from public.duty_assignments where publication_id is not distinct from pub and day=d+1));
  until_day:=d+case when extract(dow from d)=5 and not split then 2 else 1 end;
  if a.id is not null and a.end_day<>until_day then raise exception 'noncanonical-duty'; end if;
  units:=duty_private.compensation_units(to_jsonb((case when until_day=d+2 then 1 when extract(dow from d) in (5,6) then 0.5 else 1 end+coalesce(a.extra_points,0))*2),true);
  result:=result||jsonb_build_array(jsonb_build_object('id',d,'startDate',d,'endDate',until_day,'units',units,
   'primary',a.primary_id,'secondary',a.secondary_id,'title',coalesce(a.title,''),'extra',coalesce(a.extra_points,0),
   'weekendId',case when extract(dow from d)=5 then d when extract(dow from d)=6 then d-1 end));
  d:=until_day;
 end loop;
 if exists(select 1 from public.duty_assignments x where x.publication_id is not distinct from pub and duty_private.duty_owner(x.day)=p_month
  and not exists(select 1 from jsonb_array_elements(result) r where r->>'id'=x.day::text)) then raise exception 'noncanonical-duty'; end if;
 return result;
end $$;

-- Source: schemas/functions/duty_private/generation_facts.sql
CREATE OR REPLACE FUNCTION duty_private.generation_facts(p_month text) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
declare duties jsonb:=duty_private.generation_duties(p_month); meta public.duty_allocations; neighbors jsonb;
begin
 select x.* into meta from public.duty_allocations x join public.duty_months m using(month)
 where x.month=p_month and x.publication_id is not distinct from (case when m.status='published' then m.current_publication_id end);
 select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'ownerMonth',m.month,'start',a.day,'end',a.end_day,'engineer',a.primary_id,
  'source',case when a.publication_id is null then 'working' else 'published' end) order by m.month,a.day,a.id),'[]') into neighbors
 from public.duty_months m join public.duty_assignments a on duty_private.duty_owner(a.day)=m.month
 and (a.publication_id=m.current_publication_id or (m.status='draft' and a.publication_id is null))
 where m.month in (to_char((p_month||'-01')::date-interval '1 month','YYYY-MM'),to_char((p_month||'-01')::date+interval '1 month','YYYY-MM')) and a.primary_id is not null;
 return jsonb_build_object('month',p_month,'duties',duties,'neighbors',neighbors,
  'members',coalesce((select jsonb_agg(jsonb_build_object('id',id,'active',active,'approved',status='approved','eligible',status='approved' and active) order by id) from public.duty_members),'[]'),
  'seniority',coalesce((select jsonb_agg(id order by seniority,joined_at,id) from public.duty_members where status='approved' and active),'[]'),
  'constraints',coalesce((select jsonb_object_agg(member_id,days) from (select member_id,jsonb_object_agg(day,kind order by day) days from public.duty_constraints
    where day>=(duties->0->>'startDate')::date and day<(duties->-1->>'endDate')::date group by member_id) c),'{}'),
  'allocation',meta.allocation,'allocationId',meta.allocation_id,'locks',coalesce(meta.locks,'[]'),'approvals',coalesce(meta.approvals,'[]'),
  'sourcePublicationId',meta.source_publication_id,'generation',meta.generation);
end $$;

-- Source: schemas/functions/duty_private/generation_validate.sql
-- Independent validator: no solver witness, proof status, client calendar,
-- eligibility, point total or override boolean is authoritative.
CREATE OR REPLACE FUNCTION duty_private.generation_validate(f jsonb, targets jsonb, assignments jsonb) RETURNS jsonb
 LANGUAGE plpgsql STABLE SET search_path TO '' AS $$
#variable_conflict use_column
declare d jsonb; a jsonb; l jsonb; approval jsonb; n jsonb; previous jsonb; m jsonb; denied jsonb;
 ids jsonb:=f->'seniority'; totals jsonb:='{}'; weekends jsonb; fixed_weekends jsonb; k text; engineer text;
 total bigint:=0; assigned bigint:=0; amount bigint; scopes text[]:='{}'; scope text; locked_points bigint;
begin
 if jsonb_typeof(targets) IS DISTINCT FROM 'object' or jsonb_typeof(assignments) IS DISTINCT FROM 'object'
  or jsonb_typeof(f->'locks') IS DISTINCT FROM 'array' or jsonb_typeof(f->'approvals') IS DISTINCT FROM 'array'
  or jsonb_array_length(ids)=0 then raise exception 'invalid-generation-input'; end if;
 if (select count(*) from jsonb_each(targets))<>jsonb_array_length(ids) or exists(select 1 from jsonb_each(targets) where not ids ? key) then raise exception 'invalid-target-members'; end if;
 for k in select jsonb_array_elements_text(ids) loop
  amount:=duty_private.compensation_units(targets->k); total:=total+amount; totals:=totals||jsonb_build_object(k,0);
 end loop;
 if total<>(select sum((x->>'units')::bigint) from jsonb_array_elements(f->'duties') x) then raise exception 'target-total-mismatch'; end if;
 if (select count(*) from jsonb_each(assignments))<>jsonb_array_length(f->'duties')
  or exists(select 1 from jsonb_each(assignments) where not exists(select 1 from jsonb_array_elements(f->'duties') d where d->>'id'=key)) then raise exception 'assignment-coverage-shape'; end if;
 for l in select value from jsonb_array_elements(f->'locks') loop
  if jsonb_typeof(l) IS DISTINCT FROM 'object' or l-array['dutyId','engineer']<>'{}' or not ids ? (l->>'engineer')
   or not exists(select 1 from jsonb_array_elements(f->'duties') d where d->>'id'=l->>'dutyId')
   or (select count(*) from jsonb_array_elements(f->'locks') x where x->>'dutyId'=l->>'dutyId')<>1 then raise exception 'invalid-lock'; end if;
 end loop;
 for approval in select value from jsonb_array_elements(f->'approvals') loop
  if jsonb_typeof(approval) IS DISTINCT FROM 'object' or jsonb_typeof(approval->'reason') IS DISTINCT FROM 'string' or coalesce(approval->>'reason','') !~ '[^[:space:]]' or length(approval->>'reason')>2000 then raise exception 'approval-reason-required'; end if;
  case approval->>'rule'
  when 'availability' then
   if approval-array['rule','reason','dutyId','engineer','dates']<>'{}' then raise exception 'invalid-approval'; end if;
   select x into d from jsonb_array_elements(f->'duties') x where x->>'id'=approval->>'dutyId';
   select coalesce(jsonb_agg(day::date::text order by day),'[]') into denied from generate_series((d->>'startDate')::date,(d->>'endDate')::date-1,interval '1 day') day
    where f->'constraints'->(approval->>'engineer')->>day::date::text='no';
   if denied='[]' or denied IS DISTINCT FROM (select jsonb_agg(x order by x) from jsonb_array_elements(approval->'dates') x)
    or not (f->'locks') @> jsonb_build_array(jsonb_build_object('dutyId',approval->'dutyId','engineer',approval->'engineer')) then raise exception 'invalid-availability-approval'; end if;
   scope:='availability/'||(approval->>'dutyId');
  when 'consecutive' then
   if approval-array['rule','reason','duties']<>'{}' or jsonb_array_length(approval->'duties')<>2 then raise exception 'invalid-pair-approval'; end if;
   select x into d from jsonb_array_elements(f->'duties') x where x->>'id'=approval->'duties'->>0;
   select x into previous from jsonb_array_elements(f->'duties') x where x->>'id'=approval->'duties'->>1;
   select x into l from jsonb_array_elements(f->'locks') x where x->>'dutyId'=d->>'id';
   if d is null or previous is null or d->>'endDate'<>previous->>'startDate' or l is null
    or not (f->'locks') @> jsonb_build_array(jsonb_build_object('dutyId',previous->'id','engineer',l->'engineer')) then raise exception 'invalid-pair-approval'; end if;
   scope:='consecutive/'||(d->>'id')||'/'||(previous->>'id');
  when 'boundary' then
   if approval-array['rule','reason','dutyId','neighborId']<>'{}' then raise exception 'invalid-boundary-approval'; end if;
   select x into d from jsonb_array_elements(f->'duties') x where x->>'id'=approval->>'dutyId';
   select x into n from jsonb_array_elements(f->'neighbors') x where x->>'id'=approval->>'neighborId';
   if d is null or n is null or not (d->>'endDate'=n->>'start' or d->>'startDate'=n->>'end')
    or not (f->'locks') @> jsonb_build_array(jsonb_build_object('dutyId',d->'id','engineer',n->'engineer')) then raise exception 'invalid-boundary-approval'; end if;
   scope:='boundary/'||(d->>'id')||'/'||(n->>'ownerMonth')||'/'||(n->>'start')||'/'||(n->>'end')||'/'||(n->>'engineer');
  when 'weekends' then
   if approval-array['rule','reason','engineer','weekends']<>'{}' then raise exception 'invalid-weekend-approval'; end if;
   select coalesce(jsonb_agg(w order by w),'[]') into fixed_weekends from (select distinct d->'weekendId' w from jsonb_array_elements(f->'duties') d
    join jsonb_array_elements(f->'locks') l on l->>'dutyId'=d->>'id' where l->>'engineer'=approval->>'engineer' and d->>'weekendId' is not null) q;
   if jsonb_array_length(fixed_weekends)<2 or fixed_weekends IS DISTINCT FROM (select jsonb_agg(x order by x) from jsonb_array_elements(approval->'weekends') x) then raise exception 'invalid-weekend-approval'; end if;
   scope:='weekends/'||(approval->>'engineer');
  else raise exception 'unknown-approval';
  end case;
  if scope=any(scopes) then raise exception 'duplicate-approval-scope'; end if; scopes:=array_append(scopes,scope);
 end loop;
 for d in select value from jsonb_array_elements(f->'duties') loop
  a:=assignments->(d->>'id'); engineer:=a->>'primary';
  if jsonb_typeof(a) IS DISTINCT FROM 'object' or a-array['primary','secondary']<>'{}' or not a ? 'primary'
   or coalesce(a->'secondary','null') IS DISTINCT FROM d->'secondary' then raise exception 'secondary-changed'; end if;
  select x into l from jsonb_array_elements(f->'locks') x where x->>'dutyId'=d->>'id';
  if l is not null and l->>'engineer' IS DISTINCT FROM engineer then raise exception 'lock-changed'; end if;
  if engineer is null then continue; end if;
  if not ids ? engineer or engineer=d->>'secondary' then raise exception 'ineligible-primary'; end if;
  if exists(select 1 from generate_series((d->>'startDate')::date,(d->>'endDate')::date-1,interval '1 day') day where f->'constraints'->engineer->>day::date::text='no')
   and not exists(select 1 from jsonb_array_elements(f->'approvals') v where v->>'rule'='availability' and v->>'dutyId'=d->>'id' and v->>'engineer'=engineer) then raise exception 'unavailable-primary'; end if;
  amount:=(totals->>engineer)::bigint+(d->>'units')::bigint;
  if amount>(targets->>engineer)::bigint then raise exception 'target-exceeded'; end if;
  totals:=jsonb_set(totals,array[engineer],to_jsonb(amount)); assigned:=assigned+(d->>'units')::bigint;
  for n in select value from jsonb_array_elements(f->'neighbors') where value->>'engineer'=engineer loop
   if (d->>'startDate')::date>(n->>'end')::date or (n->>'start')::date>(d->>'endDate')::date then continue; end if;
   if not exists(select 1 from jsonb_array_elements(f->'approvals') v join jsonb_array_elements(f->'neighbors') reviewed on reviewed->>'id'=v->>'neighborId'
     where v->>'rule'='boundary' and v->>'dutyId'=d->>'id' and reviewed-array['id','source']=n-array['id','source']) then raise exception 'neighbor-conflict'; end if;
  end loop;
 end loop;
 for k in select jsonb_array_elements_text(ids) loop
  select coalesce(jsonb_agg(w order by w),'[]') into weekends from (select distinct d->'weekendId' w from jsonb_array_elements(f->'duties') d
   where assignments->(d->>'id')->>'primary'=k and d->>'weekendId' is not null) q;
  select v into approval from jsonb_array_elements(f->'approvals') v where v->>'rule'='weekends' and v->>'engineer'=k;
  if (approval is null and jsonb_array_length(weekends)>1) or (approval is not null and not (approval->'weekends') @> weekends) then raise exception 'weekend-cap'; end if;
  previous:=null;
  for d in select value from jsonb_array_elements(f->'duties') where assignments->(value->>'id')->>'primary'=k order by value->>'startDate' loop
   if previous->>'endDate'=d->>'startDate' and not exists(select 1 from jsonb_array_elements(f->'approvals') v where v->>'rule'='consecutive' and v->'duties'=jsonb_build_array(previous->'id',d->'id')) then raise exception 'consecutive-primary'; end if;
   previous:=d;
  end loop;
 end loop;
 return jsonb_build_object('actualUnits',totals,'assignedUnits',assigned,'missingUnits',total-assigned,'complete',assigned=total);
end $$;

-- Source: schemas/functions/duty_private/save_generation.sql
CREATE OR REPLACE FUNCTION duty_private.save_generation(p_month text, p_assignments jsonb, p_revision bigint, p_fingerprint text, p_seed integer) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
#variable_conflict use_column
declare ctx jsonb; f jsonb; checked jsonb; meta public.duty_allocations; d jsonb; s jsonb;
begin
 ctx:=duty_private.generation_context(p_month,p_revision);
 if p_fingerprint IS DISTINCT FROM ctx->>'fingerprint' then raise exception 'Generation inputs changed. Refresh and review.' using errcode='40001'; end if;
 if p_seed is null or p_seed<0 or length(p_assignments::text)>100000 then raise exception 'Invalid generation result'; end if;
 -- Sample after obtaining the workspace lock, and again immediately before the
 -- mutation. A lock wait can cross opening without any revision change.
 if duty_private.compensation_now()>=(ctx->>'coverageStartMs')::bigint then raise exception 'generation-window-closed'; end if;
 if not exists(select 1 from public.duty_months where month=p_month and status='draft') then raise exception 'An open month draft is required'; end if;
 select * into meta from public.duty_allocations where month=p_month and publication_id is null;
 if meta.month is null then raise exception 'Confirmed allocation required'; end if;
 if meta.accounting_fingerprint IS DISTINCT FROM ctx->>'accountingFingerprint' then raise exception 'Compensation changed. Refresh and review.' using errcode='40001'; end if;
 f:=ctx->'facts';
 if meta.calendar_fingerprint<>md5((select jsonb_agg(d-array['primary','secondary'] order by d->>'id')::text from jsonb_array_elements(f->'duties') d)) then raise exception 'Calendar changed. Confirm allocation again.' using errcode='40001'; end if;
 checked:=duty_private.generation_validate(f,meta.allocation->'targetsUnits',p_assignments);
 if meta.source_publication_id is null then
  s:=duty_private.compensation_reconcile(duty_private.compensation_state(),(ctx->>'coverageStartMs')::bigint,false);
  perform duty_private.allocation_compile(f,meta.allocation,checked->'actualUnits',s);
 end if;
 if duty_private.compensation_now()>=(ctx->>'coverageStartMs')::bigint then raise exception 'generation-window-closed'; end if;
 for d in select value from jsonb_array_elements(f->'duties') loop
  insert into public.duty_assignments(day,end_day,primary_id,secondary_id,title,extra_points)
  values((d->>'startDate')::date,(d->>'endDate')::date,(p_assignments->(d->>'id')->>'primary')::uuid,(d->>'secondary')::uuid,d->>'title',(d->>'extra')::numeric)
  on conflict(publication_id,day) do update set primary_id=excluded.primary_id;
 end loop;
 update public.duty_allocations set generation=jsonb_build_object('seed',p_seed,'sourceRevision',p_revision,'fingerprint',p_fingerprint,
  'savedAtMs',ctx->'actualAtMs','metrics',checked) where month=p_month and publication_id is null;
 update public.duty_months set generated=true where month=p_month;
 update public.duty_workspace set revision=revision+1 where id;
 return duty_private.generation_context(p_month,(select revision from public.duty_workspace where id));
end $$;

-- Source: schemas/functions/public/duty_confirm_allocation.sql
CREATE OR REPLACE FUNCTION public.duty_confirm_allocation(p_month text, p_allocation jsonb, p_locks jsonb, p_approvals jsonb, p_revision bigint, p_fingerprint text) RETURNS jsonb
 LANGUAGE sql SET search_path TO '' AS $$
 select duty_private.confirm_allocation(p_month,p_allocation,p_locks,p_approvals,p_revision,p_fingerprint);
$$;

-- Source: schemas/functions/public/duty_generation_context.sql
CREATE OR REPLACE FUNCTION public.duty_generation_context(p_month text, p_revision bigint) RETURNS jsonb
 LANGUAGE sql SET search_path TO '' AS $$
 select duty_private.generation_context(p_month,p_revision);
$$;

-- Source: schemas/functions/public/duty_save_generation.sql
CREATE OR REPLACE FUNCTION public.duty_save_generation(p_month text, p_assignments jsonb, p_revision bigint, p_fingerprint text, p_seed integer) RETURNS jsonb
 LANGUAGE sql SET search_path TO '' AS $$
 select duty_private.save_generation(p_month,p_assignments,p_revision,p_fingerprint,p_seed);
$$;

-- Source: schemas/functions/duty_private/allocation_baseline.sql
CREATE OR REPLACE FUNCTION duty_private.allocation_baseline(f jsonb, baseline jsonb) RETURNS void
 LANGUAGE plpgsql IMMUTABLE SET search_path TO '' AS $$
declare weights integer[]; capacities integer[]; n integer; total integer; cost bigint; quantum integer:=0; w integer;
begin
 select array_agg((d->>'units')::integer order by (d->>'units')::integer desc),sum((d->>'units')::integer) into weights,total from jsonb_array_elements(f->'duties') d;
 select array_agg(value::integer order by value::integer desc) into capacities from jsonb_each(baseline);
 n:=cardinality(capacities);
 foreach w in array weights loop quantum:=gcd(quantum,w); end loop;
 select sum((n*x::bigint-total)^2)::bigint into cost from unnest(capacities) x;
 if not duty_private.allocation_partition(weights,capacities) or duty_private.allocation_better_baseline(weights,array_fill(0,array[n]),cost,quantum,total) then raise exception 'invalid-ordinary-baseline'; end if;
end $$;

-- Source: schemas/functions/duty_private/allocation_better_baseline.sql
-- Exact branch-and-bound decision: does ANY canonical partition have lower
-- ordinary squared cost? The water-filled quantum relaxation is only a pruning
-- lower bound; it is never accepted as a feasible partition or solver proof.
CREATE OR REPLACE FUNCTION duty_private.allocation_better_baseline(weights integer[], bins integer[], ceiling_cost bigint, quantum integer, total integer) RETURNS boolean
 LANGUAGE plpgsql IMMUTABLE SET search_path TO '' AS $$
declare relaxed integer[]:=bins; remaining integer; i integer; j integer; previous integer:=-1; cost bigint; next_bins integer[]; n integer:=cardinality(bins);
begin
 select coalesce(sum(w),0) into remaining from unnest(weights) w;
 -- Distribute remaining indivisible quantum units into the lightest bin. This
 -- permits splitting actual duties and therefore only bounds the search below.
 for i in 1..(remaining/quantum) loop
  select k into j from generate_subscripts(relaxed,1) k order by relaxed[k],k limit 1;
  relaxed[j]:=relaxed[j]+quantum;
 end loop;
 select sum((n*x::bigint-total)^2)::bigint into cost from unnest(relaxed) x;
 if cost>=ceiling_cost then return false; end if;
 if coalesce(cardinality(weights),0)=0 then return true; end if;
 for i in 1..n loop
  if bins[i]=previous then continue; end if; previous:=bins[i];
  next_bins:=bins; next_bins[i]:=next_bins[i]+weights[1];
  select array_agg(x order by x) into next_bins from unnest(next_bins) x;
  if duty_private.allocation_better_baseline(weights[2:],next_bins,ceiling_cost,quantum,total) then return true; end if;
 end loop;
 return false;
end $$;

-- Source: schemas/functions/duty_private/allocation_partition.sql
-- Exact canonical-weight partition check, independent of availability and solver
-- output. Equal residual bins are symmetric; process largest duties first.
CREATE OR REPLACE FUNCTION duty_private.allocation_partition(weights integer[], capacities integer[]) RETURNS boolean
 LANGUAGE plpgsql IMMUTABLE SET search_path TO '' AS $$
declare i integer; previous integer:=-1; next_bins integer[]; weight integer:=weights[1];
begin
 if coalesce(cardinality(weights),0)=0 then return not exists(select 1 from unnest(capacities) x where x<>0); end if;
 for i in 1..cardinality(capacities) loop
  if capacities[i]<weight or capacities[i]=previous then continue; end if;
  previous:=capacities[i]; next_bins:=capacities; next_bins[i]:=next_bins[i]-weight;
  select array_agg(x order by x desc) into next_bins from unnest(next_bins) x;
  if duty_private.allocation_partition(weights[2:],next_bins) then return true; end if;
 end loop;
 return false;
end $$;

-- Source: schemas/functions/duty_private/allocation_rebind.sql
-- Republishing a restored/generated arrangement never replays old origins.
-- Carried reservations retain their IDs; still-outstanding cancelled plans can
-- bind new real capacity using fresh IDs and the retained source publication.
CREATE OR REPLACE FUNCTION duty_private.allocation_rebind(s jsonb, publication jsonb, source_publication uuid, allocation_id uuid, instant bigint) RETURNS jsonb
 LANGUAGE plpgsql STABLE SET search_path TO '' AS $$
#variable_conflict use_column
declare original jsonb; r jsonb; c jsonb; e jsonb; after_state jsonb; finish jsonb; excluded jsonb; reservations jsonb:=publication->'reservations';
 atoms jsonb; day text; a jsonb; cell bigint; remaining bigint; off bigint; ref jsonb; key text; wanted bigint[]; position integer;
begin
 select x->'operation'->'after' into original from jsonb_array_elements(s->'events') x where x->'operation'->'after'->>'id'=source_publication::text limit 1;
 if original is null then raise exception 'Review missing allocation publication lineage'; end if;
 e:=jsonb_build_object('sequence',coalesce((s->'events'->-1->>'sequence')::bigint,0)+1,'sourceKey','publication/'||(publication->>'id')||'/'||(coalesce((s->'events'->-1->>'sequence')::bigint,0)+1),'at',instant,
  'actor',coalesce(auth.uid()::text,'system'),'operation',jsonb_build_object('kind','publication','month',publication->'month','beforeId',s->'publications'->(publication->>'month')->'id','after',publication));
 finish:=duty_private.compensation_transition(s,e); excluded:=finish->'excluded'; atoms:=finish->'atoms';
 after_state:=duty_private.compensation_apply(s,e);
 for r in select value from jsonb_array_elements(reservations) loop excluded:=duty_private.compensation_exclude(excluded,r->'capacity'); end loop;
 for r in select value from jsonb_array_elements(original->'reservations') order by value->>'id' COLLATE "C" loop
  c:=after_state->'contributions'->(r->>'id');
  if c->>'status'='settled' or exists(select 1 from jsonb_array_elements(reservations) kept where kept->>'id'=r->>'id') then continue; end if;
  wanted:='{}';
  for off in 0..(r->'capacity'->>'units')::bigint-1 loop
   ref:=duty_private.compensation_slice(r->'claim',1,off);
   -- Historical ancestors may already have carried or earned descendants with
   -- different IDs. Compare original source slices, not contribution IDs.
   if exists(select 1 from jsonb_each(after_state->'contributions') child where
    (child.value->>'status'='settled' or (child.value->>'status' in ('pending','held') and exists(select 1 from jsonb_array_elements(reservations) kept where kept->>'id'=child.key)))
    and duty_private.compensation_locate(jsonb_build_object('claims',jsonb_build_array(duty_private.compensation_segment(child.value->'claim','{"at":0,"sequence":0,"lotId":"lineage"}'))),ref) is not null) then continue; end if;
   -- Explicit manager release is not an invitation to reserve the same work
   -- again through an older publication's metadata.
   if exists(select 1 from jsonb_array_elements(s->'events') released join jsonb_each(s->'contributions') child on child.key=released->'operation'->>'contributionId'
    where released->'operation'->>'kind'='release' and duty_private.compensation_locate(jsonb_build_object('claims',jsonb_build_array(
     duty_private.compensation_segment(child.value->'claim','{"at":0,"sequence":0,"lotId":"lineage"}'))),ref) is not null) then raise exception 'Repayment lineage changed. Refresh and review.' using errcode='40001'; end if;
   if duty_private.compensation_locate(jsonb_build_object('claims',duty_private.compensation_candidates(after_state)),ref) is null then raise exception 'Repayment lineage changed. Refresh and review.' using errcode='40001'; end if;
   wanted:=array_append(wanted,off);
  end loop;
  remaining:=cardinality(wanted); position:=1;
  for day,a in select * from jsonb_each(atoms) where value->>'primaryId'=r->'claim'->>'debtorId' order by key loop
   if (a->>'endInstantMs')::bigint<=instant then continue; end if;
   for cell in 0..(a->>'units')::bigint-1 loop
    if remaining=0 then exit; end if;
    if coalesce(excluded->day,'[]') @> jsonb_build_array(cell) then continue; end if;
    off:=wanted[position]; key:='allocation/'||allocation_id||'/rebind/'||md5((publication->>'id')||'/'||(r->>'id')||'/'||off);
    ref:=duty_private.compensation_slice(r->'claim',1,off);
    reservations:=reservations||jsonb_build_array(jsonb_build_object('id',key,'capacity',jsonb_build_object('date',day,'offset',cell,'units',1),'claim',ref));
    excluded:=duty_private.compensation_exclude(excluded,jsonb_build_object('date',day,'offset',cell,'units',1));
    -- Reserve selected source units in the preview too, so later plans cannot
    -- borrow a prefix already earmarked by this operation.
    after_state:=jsonb_set(after_state,array['contributions',key],jsonb_build_object('id',key,'claim',ref,'status','pending'));
    remaining:=remaining-1; position:=position+1;
   end loop;
  end loop;
  if remaining<>0 then raise exception 'Repayment capacity changed. Refresh and review.' using errcode='40001'; end if;
 end loop;
 return jsonb_build_object('fingerprint',md5((s->'events')::text),'intents',publication->'intents','reservations',reservations);
end $$;

-- Source: schemas/grants/functions.sql
REVOKE ALL ON FUNCTION duty_private.assert_admin_remains() FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION duty_private.check_revision(p_revision bigint) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION duty_private.current_duties() FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION duty_private.delete_publication(p_publication uuid, p_revision bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION duty_private.delete_publication(p_publication uuid, p_revision bigint) TO authenticated;

REVOKE ALL ON FUNCTION duty_private.duty_owner(p_day date) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION duty_private.is_manager() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION duty_private.is_manager() TO authenticated;

REVOKE ALL ON FUNCTION duty_private.is_member() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION duty_private.is_member() TO authenticated;

REVOKE ALL ON FUNCTION duty_private.join_team(p_name text) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION duty_private.join_team(p_name text) TO authenticated;

REVOKE ALL ON FUNCTION duty_private.reconcile_publication_swaps() FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION duty_private.reconcile_swaps(p_month text) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION duty_private.rename_self(p_name text, p_revision bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION duty_private.rename_self(p_name text, p_revision bigint) TO authenticated;

REVOKE ALL ON FUNCTION duty_private.request_swap(p_from uuid, p_to uuid, p_explanation text, p_revision bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION duty_private.request_swap(p_from uuid, p_to uuid, p_explanation text, p_revision bigint) TO authenticated;

REVOKE ALL ON FUNCTION duty_private.resolve_swap(p_request uuid, p_action text, p_revision bigint, p_override_reason text) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION duty_private.resolve_swap(p_request uuid, p_action text, p_revision bigint, p_override_reason text) TO authenticated;

REVOKE ALL ON FUNCTION duty_private.restore_publication(p_publication uuid, p_revision bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION duty_private.restore_publication(p_publication uuid, p_revision bigint) TO authenticated;

REVOKE ALL ON FUNCTION duty_private.review_member(p_member uuid, p_status text, p_revision bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION duty_private.review_member(p_member uuid, p_status text, p_revision bigint) TO authenticated;

REVOKE ALL ON FUNCTION duty_private.save_schedule(p_state jsonb, p_revision bigint, p_publish text) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION duty_private.save_schedule(p_state jsonb, p_revision bigint, p_publish text) TO authenticated;

REVOKE ALL ON FUNCTION duty_private.set_constraints(p_member uuid, p_days date[], p_kind text, p_note text, p_revision bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION duty_private.set_constraints(p_member uuid, p_days date[], p_kind text, p_note text, p_revision bigint) TO authenticated;

REVOKE ALL ON FUNCTION duty_private.set_role(p_member uuid, p_role text, p_revision bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION duty_private.set_role(p_member uuid, p_role text, p_revision bigint) TO authenticated;

REVOKE ALL ON FUNCTION duty_private.validate_swap(p_from uuid, p_to uuid, p_publication uuid, p_override boolean) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.duty_delete_publication(p_publication uuid, p_revision bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.duty_delete_publication(p_publication uuid, p_revision bigint) TO authenticated;
GRANT ALL ON FUNCTION public.duty_delete_publication(p_publication uuid, p_revision bigint) TO service_role;

REVOKE ALL ON FUNCTION public.duty_join(p_name text) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.duty_join(p_name text) TO authenticated;
GRANT ALL ON FUNCTION public.duty_join(p_name text) TO service_role;

REVOKE ALL ON FUNCTION public.duty_load() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.duty_load() TO authenticated;
GRANT ALL ON FUNCTION public.duty_load() TO service_role;

REVOKE ALL ON FUNCTION public.duty_rename_self(p_name text, p_revision bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.duty_rename_self(p_name text, p_revision bigint) TO authenticated;
GRANT ALL ON FUNCTION public.duty_rename_self(p_name text, p_revision bigint) TO service_role;

REVOKE ALL ON FUNCTION public.duty_request_swap(p_from uuid, p_to uuid, p_explanation text, p_revision bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.duty_request_swap(p_from uuid, p_to uuid, p_explanation text, p_revision bigint) TO service_role;
GRANT ALL ON FUNCTION public.duty_request_swap(p_from uuid, p_to uuid, p_explanation text, p_revision bigint) TO authenticated;

REVOKE ALL ON FUNCTION public.duty_resolve_swap(p_request uuid, p_action text, p_revision bigint, p_override_reason text) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.duty_resolve_swap(p_request uuid, p_action text, p_revision bigint, p_override_reason text) TO service_role;
GRANT ALL ON FUNCTION public.duty_resolve_swap(p_request uuid, p_action text, p_revision bigint, p_override_reason text) TO authenticated;

REVOKE ALL ON FUNCTION public.duty_restore_publication(p_publication uuid, p_revision bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.duty_restore_publication(p_publication uuid, p_revision bigint) TO authenticated;
GRANT ALL ON FUNCTION public.duty_restore_publication(p_publication uuid, p_revision bigint) TO service_role;

REVOKE ALL ON FUNCTION public.duty_review_member(p_member uuid, p_status text, p_revision bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.duty_review_member(p_member uuid, p_status text, p_revision bigint) TO authenticated;
GRANT ALL ON FUNCTION public.duty_review_member(p_member uuid, p_status text, p_revision bigint) TO service_role;

REVOKE ALL ON FUNCTION public.duty_save_schedule(p_state jsonb, p_revision bigint, p_publish text) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.duty_save_schedule(p_state jsonb, p_revision bigint, p_publish text) TO authenticated;
GRANT ALL ON FUNCTION public.duty_save_schedule(p_state jsonb, p_revision bigint, p_publish text) TO service_role;

REVOKE ALL ON FUNCTION public.duty_set_constraints(p_member uuid, p_days date[], p_kind text, p_note text, p_revision bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.duty_set_constraints(p_member uuid, p_days date[], p_kind text, p_note text, p_revision bigint) TO authenticated;
GRANT ALL ON FUNCTION public.duty_set_constraints(p_member uuid, p_days date[], p_kind text, p_note text, p_revision bigint) TO service_role;

REVOKE ALL ON FUNCTION public.duty_set_role(p_member uuid, p_role text, p_revision bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.duty_set_role(p_member uuid, p_role text, p_revision bigint) TO authenticated;
GRANT ALL ON FUNCTION public.duty_set_role(p_member uuid, p_role text, p_revision bigint) TO service_role;

REVOKE ALL ON FUNCTION duty_private.cancel_draft(text, bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION duty_private.cancel_draft(text, bigint) TO authenticated;
REVOKE ALL ON FUNCTION public.duty_cancel_draft(text, bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.duty_cancel_draft(text, bigint) TO authenticated, service_role;

-- Compensation persistence privileges.
REVOKE ALL ON FUNCTION duty_private.compensation(jsonb, text, text, bigint, text, bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION duty_private.compensation(jsonb, text, text, bigint, text, bigint) TO authenticated;
REVOKE ALL ON FUNCTION duty_private.compensation_append(jsonb, jsonb, text, bigint, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION duty_private.compensation_apply(jsonb, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION duty_private.compensation_atoms(jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION duty_private.compensation_consume(jsonb, jsonb, bigint, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION duty_private.compensation_exclude(jsonb, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION duty_private.compensation_immutable() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION duty_private.compensation_locate(jsonb, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION duty_private.compensation_lot(jsonb, jsonb, text, text, text, bigint, jsonb, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION duty_private.compensation_members() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION duty_private.compensation_normalize(jsonb, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION duty_private.compensation_now() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION duty_private.compensation_publication(text, uuid, jsonb, boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION duty_private.compensation_reconcile(jsonb, bigint, boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION duty_private.compensation_record(jsonb, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION duty_private.compensation_reserve(jsonb, jsonb, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION duty_private.compensation_segment(jsonb, jsonb, boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION duty_private.compensation_slice(jsonb, bigint, bigint) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION duty_private.compensation_snapshot(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION duty_private.compensation_state() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION duty_private.compensation_transition(jsonb, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION duty_private.compensation_units(jsonb, boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION duty_private.compensation_view(jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.duty_compensation(jsonb, text, text, bigint, text, bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.duty_compensation(jsonb, text, text, bigint, text, bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.duty_compensation(jsonb, text, text, bigint, text, bigint) TO service_role;

REVOKE ALL ON FUNCTION duty_private.allocation_bind(f jsonb, draft jsonb, s jsonb, allocation_id uuid, publication jsonb, instant bigint) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION duty_private.allocation_compile(f jsonb, draft jsonb, actual jsonb, s jsonb) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION duty_private.allocation_part(t jsonb, amount bigint, off bigint) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION duty_private.allocation_take(atoms jsonb, engineer text, amount bigint) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION duty_private.compensation_candidates(s jsonb) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION duty_private.confirm_allocation(p_month text, p_allocation jsonb, p_locks jsonb, p_approvals jsonb, p_revision bigint, p_fingerprint text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION duty_private.confirm_allocation(p_month text, p_allocation jsonb, p_locks jsonb, p_approvals jsonb, p_revision bigint, p_fingerprint text) TO authenticated;

REVOKE ALL ON FUNCTION duty_private.generation_context(p_month text, p_revision bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION duty_private.generation_context(p_month text, p_revision bigint) TO authenticated;

REVOKE ALL ON FUNCTION duty_private.generation_duties(p_month text) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION duty_private.generation_facts(p_month text) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION duty_private.generation_validate(f jsonb, targets jsonb, assignments jsonb) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION duty_private.save_generation(p_month text, p_assignments jsonb, p_revision bigint, p_fingerprint text, p_seed integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION duty_private.save_generation(p_month text, p_assignments jsonb, p_revision bigint, p_fingerprint text, p_seed integer) TO authenticated;

REVOKE ALL ON FUNCTION public.duty_confirm_allocation(p_month text, p_allocation jsonb, p_locks jsonb, p_approvals jsonb, p_revision bigint, p_fingerprint text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.duty_confirm_allocation(p_month text, p_allocation jsonb, p_locks jsonb, p_approvals jsonb, p_revision bigint, p_fingerprint text) TO authenticated;

REVOKE ALL ON FUNCTION public.duty_generation_context(p_month text, p_revision bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.duty_generation_context(p_month text, p_revision bigint) TO authenticated;

REVOKE ALL ON FUNCTION public.duty_save_generation(p_month text, p_assignments jsonb, p_revision bigint, p_fingerprint text, p_seed integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.duty_save_generation(p_month text, p_assignments jsonb, p_revision bigint, p_fingerprint text, p_seed integer) TO authenticated;

REVOKE ALL ON FUNCTION duty_private.allocation_baseline(f jsonb, baseline jsonb) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION duty_private.allocation_better_baseline(weights integer[], bins integer[], ceiling_cost bigint, quantum integer, total integer) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION duty_private.allocation_partition(weights integer[], capacities integer[]) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION duty_private.allocation_rebind(s jsonb, publication jsonb, source_publication uuid, allocation_id uuid, instant bigint) FROM PUBLIC, anon, authenticated, service_role;

-- Source: schemas/grants/tables.sql
-- Client writes are permitted only through checked RPCs. Explicit grants override platform defaults.
REVOKE ALL ON TABLE public.duty_roles FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.duty_roles TO authenticated;
GRANT ALL ON TABLE public.duty_roles TO service_role;
REVOKE ALL ON TABLE public.duty_member_statuses FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.duty_member_statuses TO authenticated;
GRANT ALL ON TABLE public.duty_member_statuses TO service_role;
REVOKE ALL ON TABLE public.duty_month_statuses FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.duty_month_statuses TO authenticated;
GRANT ALL ON TABLE public.duty_month_statuses TO service_role;
REVOKE ALL ON TABLE public.duty_constraint_types FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.duty_constraint_types TO authenticated;
GRANT ALL ON TABLE public.duty_constraint_types TO service_role;
REVOKE ALL ON TABLE public.duty_members FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.duty_members TO authenticated;
GRANT ALL ON TABLE public.duty_members TO service_role;
REVOKE ALL ON TABLE public.duty_workspace FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.duty_workspace TO authenticated;
GRANT ALL ON TABLE public.duty_workspace TO service_role;
REVOKE ALL ON TABLE public.duty_months FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.duty_months TO authenticated;
GRANT ALL ON TABLE public.duty_months TO service_role;
REVOKE ALL ON TABLE public.duty_publications FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.duty_publications TO authenticated;
GRANT ALL ON TABLE public.duty_publications TO service_role;
REVOKE ALL ON TABLE public.duty_assignments FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.duty_assignments TO authenticated;
GRANT ALL ON TABLE public.duty_assignments TO service_role;
REVOKE ALL ON TABLE public.duty_constraints FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.duty_constraints TO authenticated;
GRANT ALL ON TABLE public.duty_constraints TO service_role;
REVOKE ALL ON TABLE public.duty_swap_requests FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.duty_swap_requests TO authenticated;
GRANT ALL ON TABLE public.duty_swap_requests TO service_role;

-- Compensation audit privileges. Even service_role cannot rewrite history.
REVOKE ALL ON TABLE public.duty_compensation_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.duty_compensation_events TO authenticated, service_role;

REVOKE ALL ON TABLE public.duty_allocations FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.duty_allocations TO authenticated;

RESET check_function_bodies;
NOTIFY pgrst, 'reload schema';
