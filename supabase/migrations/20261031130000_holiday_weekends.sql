-- Holiday weekends (decision 2026-10-31): a special range touching a weekend no longer
-- splits it. The weekend stays one combined Friday–Sunday duty with one member, and every
-- holiday date adds its own extra: weekday 1 + extra, Friday 0.5 + extra, Saturday
-- 0.5 + extra, so a combined holiday weekend weighs 1 + extra_fri + extra_sat (3 points at
-- +1 on both dates). A weekend the manager splits by hand keeps each date's own points.
-- The combined row stores Saturday's own extra in the new saturday_extra_points column
-- (zero on every other row); extra_points keeps describing the row's first date.
-- lib/scheduling/calendar.ts canonicalDuties and lib/rota/engine.ts blocks compute the
-- same weights; duty_private.generation_duties and the stored points column are the
-- database's copies, and duty_private.compensation_snapshot / compensation_atoms give each
-- weekend date its own accounting atom. Existing rows keep their value: split halves
-- already stored their own extra, and combined rows could not carry one before.
ALTER TABLE public.duty_assignments ADD COLUMN saturday_extra_points numeric DEFAULT 0 NOT NULL;
ALTER TABLE public.duty_assignments ADD CONSTRAINT duty_assignments_saturday_extra_points_check CHECK (((saturday_extra_points >= (0)::numeric) AND (saturday_extra_points <= (20)::numeric) AND ((end_day = (day + 2)) OR (saturday_extra_points = (0)::numeric))));
ALTER TABLE public.duty_assignments DROP COLUMN points;
ALTER TABLE public.duty_assignments ADD COLUMN points numeric GENERATED ALWAYS AS ((
CASE
    WHEN (end_day = (day + 2)) THEN (((1)::numeric + extra_points) + saturday_extra_points)
    WHEN (EXTRACT(dow FROM day) = ANY (ARRAY[(5)::numeric, (6)::numeric])) THEN (0.5 + extra_points)
    ELSE ((1)::numeric + extra_points)
END)) STORED;
ALTER TABLE public.duty_assignments DROP CONSTRAINT duty_assignment_span;
ALTER TABLE public.duty_assignments ADD CONSTRAINT duty_assignment_span CHECK (((end_day = (day + 1)) OR ((EXTRACT(dow FROM day) = (5)::numeric) AND (end_day = (day + 2)))));

-- Canonicalize persisted calendar facts, filling absent ordinary blocks. Saturday
-- belongs to Friday's owner, even across a year. No client weights enter here.
CREATE OR REPLACE FUNCTION duty_private.generation_duties(p_month text) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
declare d date; until_day date; finish date; pub uuid; a public.duty_assignments;
 result jsonb:='[]'; split boolean; units bigint; extra numeric; saturday_extra numeric;
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
  -- Every holiday date adds its own extra: weekday 2 + 2·extra units, Friday or Saturday
  -- 1 + 2·extra; a combined weekend is the sum of its two dates (saturday_extra_points is
  -- Saturday's own extra). Same formula as lib/scheduling/calendar.ts canonicalDuties.
  extra:=coalesce(a.extra_points,0); saturday_extra:=coalesce(a.saturday_extra_points,0);
  units:=duty_private.compensation_units(to_jsonb((case when until_day=d+2 then 1+extra+saturday_extra
   when extract(dow from d) in (5,6) then 0.5+extra else 1+extra end)*2),true);
  result:=result||jsonb_build_array(jsonb_build_object('id',d,'startDate',d,'endDate',until_day,'units',units,
   'primary',a.primary_id,'secondary',a.secondary_id,'title',coalesce(a.title,''),'extra',extra,
   'weekendId',case when extract(dow from d)=5 then d when extract(dow from d)=6 then d-1 end)
   ||case when saturday_extra<>0 then jsonb_build_object('saturdayExtra',saturday_extra) else '{}'::jsonb end);
  d:=until_day;
 end loop;
 if exists(select 1 from public.duty_assignments x where x.publication_id is not distinct from pub and duty_private.duty_owner(x.day)=p_month
  and not exists(select 1 from jsonb_array_elements(result) r where r->>'id'=x.day::text)) then raise exception 'noncanonical-duty'; end if;
 return result;
end $$;

CREATE OR REPLACE FUNCTION duty_private.compensation_atoms(p jsonb) RETURNS jsonb
 LANGUAGE plpgsql STABLE SET search_path TO '' AS $$
#variable_conflict use_column
declare result jsonb:='{}'::jsonb; d jsonb; first_day date; end_day date; day date; amount bigint; combined boolean; finish bigint; saturday bigint;
begin
 if p is null or p='null'::jsonb then return result; end if;
 for d in select value from jsonb_array_elements(p->'duties') order by value->>'startDate' loop
  first_day:=(d->>'startDate')::date; end_day:=(d->>'endDate')::date; amount:=duty_private.compensation_units(d->'units',true);
  combined:=extract(dow from first_day)=5 and end_day=first_day+2;
  if duty_private.duty_owner(first_day)<>p->>'month' or (not combined and (end_day<>first_day+1 or d ? 'saturdayUnits'))
   or amount<(case when not combined and extract(dow from first_day) in (5,6) then 1 else 2 end) or amount>(case when combined then 82 when extract(dow from first_day) in (5,6) then 41 else 42 end) then raise exception 'invalid-published-duty'; end if;
  finish:=(extract(epoch from ((end_day+time '09:00') at time zone 'Asia/Jerusalem'))*1000)::bigint;
  -- A combined weekend has one atom per date, each carrying its own date's points:
  -- Saturday its saturdayUnits (one plus twice its extra), Friday the rest.
  saturday:=case when combined then duty_private.compensation_units(coalesce(d->'saturdayUnits','1'::jsonb),true) else 0 end;
  if combined and (saturday>41 or amount-saturday<1 or amount-saturday>41) then raise exception 'invalid-published-duty'; end if;
  for day in select generate_series(first_day,end_day-1,interval '1 day')::date loop
   if result ? day::text then raise exception 'overlapping-published-duty'; end if;
   result:=result||jsonb_build_object(day::text,jsonb_build_object('date',day,'units',case when not combined then amount when day=first_day then amount-saturday else saturday end,'primaryId',d->'primaryId','endInstantMs',finish));
  end loop;
 end loop;
 return result;
end $$;

-- Accounting snapshots exclude secondary cover, titles and private notes. A combined
-- weekend also carries Saturday's own units so each date atom keeps its own points.
CREATE OR REPLACE FUNCTION duty_private.compensation_snapshot(publication uuid) RETURNS jsonb
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $$
 select jsonb_build_object('id',p.id,'month',p.month,'intents','[]'::jsonb,'reservations','[]'::jsonb,'duties',coalesce(
  (select jsonb_agg(jsonb_build_object('startDate',a.day,'endDate',a.end_day,'primaryId',a.primary_id,'units',a.points*2)
    ||case when a.end_day=a.day+2 then jsonb_build_object('saturdayUnits',1+a.saturday_extra_points*2) else '{}'::jsonb end order by a.day)
   from public.duty_assignments a where a.publication_id=p.id and duty_private.duty_owner(a.day)=p.month),'[]'::jsonb))
 from public.duty_publications p where p.id=publication;
$$;

CREATE OR REPLACE FUNCTION duty_private.save_schedule(p_state jsonb, p_revision bigint, p_publish text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
#variable_conflict use_column
declare x record; item jsonb; d date; a public.duty_assignments; m public.duty_months; first_day date; last_day date; publication uuid; next_version integer; locks_before jsonb; changed_locks jsonb; f jsonb; result jsonb; allocation public.duty_allocations;
begin
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 perform duty_private.check_revision(p_revision);
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 if jsonb_typeof(p_state->'duties') is distinct from 'array' or jsonb_typeof(p_state->'months') is distinct from 'object' or jsonb_typeof(p_state->'team') is distinct from 'array' or length(p_state::text)>2000000 then raise exception 'Invalid schedule'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('day',a.day,'end_day',a.end_day,'primary_id',a.primary_id,'points',a.points)),'[]') into locks_before
 from public.duty_assignments a where a.publication_id is null and a.locked;
 if p_state ? 'lock_edits' and (jsonb_typeof(p_state->'lock_edits') is distinct from 'array' or exists(select 1 from jsonb_array_elements_text(p_state->'lock_edits') d where not (p_state->'months' ? duty_private.duty_owner(d::date)))) then raise exception 'Invalid lock review'; end if;
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
  insert into public.duty_assignments(day,end_day,primary_id,secondary_id,manager_override,title,extra_points,saturday_extra_points,locked)
  values((item->>'day')::date,(item->>'end_day')::date,nullif(item->>'primary_id','')::uuid,nullif(item->>'secondary_id','')::uuid,coalesce((item->>'manager_override')::boolean,false),coalesce(item->>'title',''),coalesce((item->>'extra_points')::numeric,0),coalesce((item->>'saturday_extra_points')::numeric,0),coalesce((item->>'locked')::boolean,false))
  on conflict(publication_id,day) do update set end_day=excluded.end_day,primary_id=excluded.primary_id,secondary_id=excluded.secondary_id,manager_override=excluded.manager_override,title=excluded.title,extra_points=excluded.extra_points,saturday_extra_points=excluded.saturday_extra_points,locked=case when item ? 'locked' then excluded.locked else duty_assignments.locked end;
 end loop;
 if exists(select 1 from public.duty_assignments first_duty join public.duty_assignments other_duty on first_duty.day<other_duty.day and first_duty.end_day>other_duty.day where first_duty.publication_id is null and other_duty.publication_id is null) then raise exception 'Duty dates overlap'; end if;
 if exists(select 1 from jsonb_array_elements(locks_before) l where not exists(select 1 from public.duty_assignments a where a.publication_id is null
  and a.day=(l->>'day')::date and a.end_day=(l->>'end_day')::date and a.primary_id=(l->>'primary_id')::uuid and a.points=(l->>'points')::numeric and a.locked) and not coalesce(p_state->'lock_edits','[]') ? (l->>'day')) then raise exception 'Explicitly review locks before changing locked work'; end if;
 -- Lock edits are atomic with the primary save. Unrelated locks and approvals survive.
 select coalesce(jsonb_agg(l),'[]') into changed_locks from jsonb_array_elements(locks_before) l
 where not exists(select 1 from public.duty_assignments a where a.publication_id is null and a.locked
  and a.day=(l->>'day')::date and a.end_day=(l->>'end_day')::date and a.primary_id=(l->>'primary_id')::uuid and a.points=(l->>'points')::numeric);
 update public.duty_allocations meta set
  locks=coalesce((select jsonb_agg(jsonb_build_object('dutyId',a.day,'engineer',a.primary_id) order by a.day)
   from public.duty_assignments a where a.publication_id is null and a.locked and duty_private.duty_owner(a.day)=meta.month),'[]'),
  approvals=coalesce((select jsonb_agg(v) from jsonb_array_elements(meta.approvals) v where not exists(
   select 1 from jsonb_array_elements(changed_locks) l where
    (v->>'rule' in ('availability','boundary') and v->>'dutyId'=l->>'day')
    or (v->>'rule'='consecutive' and (v->'duties') ? (l->>'day'))
    or (v->>'rule'='weekends' and v->>'engineer'=l->>'primary_id'))),'[]')
 where meta.publication_id is null and p_state->'months' ? meta.month;
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
  insert into public.duty_assignments(publication_id,day,end_day,primary_id,secondary_id,manager_override,title,extra_points,saturday_extra_points,locked)
  select publication,day,end_day,primary_id,secondary_id,manager_override,title,extra_points,saturday_extra_points,locked from public.duty_assignments where publication_id is null and duty_private.duty_owner(day)=p_publish;
  insert into public.duty_allocations(month,publication_id,allocation_id,allocation,locks,approvals,accounting_fingerprint,calendar_fingerprint,source_publication_id,generation)
  select month,publication,allocation_id,allocation,locks,approvals,accounting_fingerprint,calendar_fingerprint,source_publication_id,generation from public.duty_allocations where month=p_publish and publication_id is null;
  perform duty_private.compensation_publication(p_publish,publication,p_state->'compensation');
  delete from public.duty_assignments where publication_id is null and duty_private.duty_owner(day)=p_publish;
  delete from public.duty_allocations where month=p_publish and publication_id is null;
  update public.duty_months set current_publication_id=publication,status='published',generated=true where month=p_publish;
 end if;
 update public.duty_workspace set revision=revision+1 where id;
end $$;

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
  insert into public.duty_assignments(day,end_day,primary_id,secondary_id,title,extra_points,saturday_extra_points)
  values((d->>'startDate')::date,(d->>'endDate')::date,(p_assignments->(d->>'id')->>'primary')::uuid,(d->>'secondary')::uuid,d->>'title',(d->>'extra')::numeric,coalesce((d->>'saturdayExtra')::numeric,0))
  on conflict(publication_id,day) do update set primary_id=excluded.primary_id;
 end loop;
 update public.duty_allocations set generation=jsonb_build_object('seed',p_seed,'sourceRevision',p_revision,'fingerprint',p_fingerprint,
  'savedAtMs',ctx->'actualAtMs','metrics',checked) where month=p_month and publication_id is null;
 update public.duty_months set generated=true where month=p_month;
 update public.duty_workspace set revision=revision+1 where id;
 return duty_private.generation_context(p_month,(select revision from public.duty_workspace where id));
end $$;

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
  insert into public.duty_assignments(day,end_day,primary_id,secondary_id,manager_override,title,extra_points,saturday_extra_points,locked)
  select day,end_day,primary_id,secondary_id,manager_override,title,extra_points,saturday_extra_points,locked from public.duty_assignments
  where publication_id=v.id and duty_private.duty_owner(day)=v.month;
  insert into public.duty_allocations(month,publication_id,allocation_id,allocation,locks,approvals,accounting_fingerprint,calendar_fingerprint,source_publication_id,generation)
  select month,null,allocation_id,allocation,locks,approvals,accounting_fingerprint,calendar_fingerprint,p_publication,generation from public.duty_allocations where publication_id=p_publication;
 end if;
 update public.duty_months set current_publication_id=replacement,status=case when replacement is null then 'draft' else status end where current_publication_id=v.id;
 delete from public.duty_publications where id=v.id;
 update public.duty_workspace set revision=revision+1 where id;
end $$;

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
 insert into public.duty_assignments(day,end_day,primary_id,secondary_id,manager_override,title,extra_points,saturday_extra_points,locked)
 select day,end_day,primary_id,secondary_id,manager_override,title,extra_points,saturday_extra_points,locked
 from public.duty_assignments where publication_id=p_publication and duty_private.duty_owner(day)=v.month;
 delete from public.duty_allocations where month=v.month and publication_id is null;
 insert into public.duty_allocations(month,publication_id,allocation_id,allocation,locks,approvals,accounting_fingerprint,calendar_fingerprint,source_publication_id,generation,origin)
 select month,null,allocation_id,allocation,locks,approvals,md5((duty_private.compensation_state()->'events')::text),calendar_fingerprint,p_publication,generation,'restored' from public.duty_allocations where publication_id=p_publication;
 update public.duty_months set status='draft',generated=true where month=v.month;
 update public.duty_workspace set revision=revision+1 where id;
end $$;

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
