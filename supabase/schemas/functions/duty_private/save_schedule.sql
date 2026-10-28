CREATE FUNCTION duty_private.save_schedule(p_state jsonb, p_revision bigint, p_publish text DEFAULT NULL::text) RETURNS void
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
  insert into public.duty_assignments(day,end_day,primary_id,secondary_id,manager_override,title,extra_points,locked)
  values((item->>'day')::date,(item->>'end_day')::date,nullif(item->>'primary_id','')::uuid,nullif(item->>'secondary_id','')::uuid,coalesce((item->>'manager_override')::boolean,false),coalesce(item->>'title',''),coalesce((item->>'extra_points')::numeric,0),coalesce((item->>'locked')::boolean,false))
  on conflict(publication_id,day) do update set end_day=excluded.end_day,primary_id=excluded.primary_id,secondary_id=excluded.secondary_id,manager_override=excluded.manager_override,title=excluded.title,extra_points=excluded.extra_points,locked=case when item ? 'locked' then excluded.locked else duty_assignments.locked end;
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
  insert into public.duty_assignments(publication_id,day,end_day,primary_id,secondary_id,manager_override,title,extra_points,locked)
  select publication,day,end_day,primary_id,secondary_id,manager_override,title,extra_points,locked from public.duty_assignments where publication_id is null and duty_private.duty_owner(day)=p_publish;
  insert into public.duty_allocations(month,publication_id,allocation_id,allocation,locks,approvals,accounting_fingerprint,calendar_fingerprint,source_publication_id,generation)
  select month,publication,allocation_id,allocation,locks,approvals,accounting_fingerprint,calendar_fingerprint,source_publication_id,generation from public.duty_allocations where month=p_publish and publication_id is null;
  perform duty_private.compensation_publication(p_publish,publication,p_state->'compensation');
  delete from public.duty_assignments where publication_id is null and duty_private.duty_owner(day)=p_publish;
  delete from public.duty_allocations where month=p_publish and publication_id is null;
  update public.duty_months set current_publication_id=publication,status='published',generated=true where month=p_publish;
 end if;
 update public.duty_workspace set revision=revision+1 where id;
end $$;
