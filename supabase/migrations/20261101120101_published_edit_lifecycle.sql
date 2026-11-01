-- Published duty edits across the month lifecycle (2026-11-01 review).
-- 1. Permanent after Temporary: a Permanent edit gives the duty for good from
--    its owner, found by walking the month's recorded publications back past
--    Temporary moves. Returning it to the owner is the ordinary transition, which
--    cancels the earlier debt; giving it to a third engineer routes the holder's
--    return (Temporary) and the owner's permanent gift. No debt stays behind for
--    work nobody does.
-- 2. The copied allocation's targets (and, for new points, its calendar
--    fingerprint) follow the edit, so a reopened copy of an edited version
--    republishes unchanged instead of failing target-exceeded.
-- 3. New points on a duty invalidate a pending swap that includes it: consent was
--    given at the earlier points. Engineer changes keep the pointer hook's rules.
-- Owner, SECURITY DEFINER, search_path and grants are unchanged.
-- An admin changes one published duty's engineer and/or extra points without a
-- swap, publishing a new version. Accounting stays canonical: the ordinary
-- publication transition makes the old engineer owe the new one each date's shared
-- units (Temporary); Permanent adds a reviewed permanent intent over exactly those
-- units, so no debt. Added extra counts for whoever does the duty.
CREATE OR REPLACE FUNCTION duty_private.edit_published_duty(p_publication uuid, p_day date, p_primary uuid, p_extra_points numeric, p_saturday_extra_points numeric, p_kind text, p_revision bigint, p_override_reason text DEFAULT ''::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare d public.duty_assignments; m public.duty_months; publication uuid; next_version integer; reason text:=btrim(coalesce(p_override_reason,''),U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');
 saturday numeric:=coalesce(p_saturday_extra_points,0); changed boolean; conflicts boolean:=false; capacity jsonb:='[]'; old_atoms jsonb; new_atoms jsonb; atom text; a jsonb;
 plan jsonb; owner uuid; seq bigint; op jsonb; prior jsonb; target text; holder text; previous text; source jsonb; amount bigint; intent jsonb;
begin
 perform duty_private.check_revision(p_revision);
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 if p_kind is null or p_kind not in ('temporary','permanent') then raise exception 'Choose Temporary or Permanent'; end if;
 if length(reason)>500 then raise exception 'Keep the override reason under 500 characters'; end if;
 select * into m from public.duty_months where current_publication_id=p_publication for update;
 if m.month is null then raise exception 'This publication changed. Refresh first.' using errcode='40001'; end if;
 -- A reopened draft was copied from the earlier version; publishing it would silently undo this edit.
 if m.status<>'published' then raise exception 'Publish or cancel the open draft before editing published duties'; end if;
 select * into d from public.duty_assignments where publication_id=p_publication and duty_assignments.day=p_day;
 if d.id is null or duty_private.duty_owner(d.day)<>m.month then raise exception 'Choose a duty in this published month'; end if;
 if d.day<(now() at time zone 'Asia/Jerusalem')::date then raise exception 'Choose duties starting today or later'; end if;
 if d.primary_id is null then raise exception 'This duty has no primary engineer'; end if;
 if p_primary is null or not exists(select 1 from public.duty_members where id=p_primary and active and status='approved') then raise exception 'Choose an active approved engineer'; end if;
 if p_primary=d.secondary_id then raise exception 'A primary engineer cannot also be emergency cover'; end if;
 -- Half points stay exact; the table's own bounds apply to both dates.
 if p_extra_points is null or p_extra_points<0 or p_extra_points>20 or p_extra_points*2<>trunc(p_extra_points*2)
  or saturday<0 or saturday>20 or saturday*2<>trunc(saturday*2) or (d.end_day<>d.day+2 and saturday<>0) then raise exception 'Extra points must be 0 to 20 in half points'; end if;
 changed:=p_primary<>d.primary_id;
 if not changed and p_extra_points=d.extra_points and saturday=d.saturday_extra_points then raise exception 'Nothing changed'; end if;
 if changed then
  select exists(select 1 from public.duty_constraints c where c.kind='no' and c.member_id=p_primary and c.day>=d.day and c.day<d.end_day) into conflicts;
  if conflicts and reason='' then raise exception 'Availability conflict. An admin must explicitly override with a reason.'; end if;
 end if;
 update public.duty_months set publication_sequence=publication_sequence+1 where month=m.month returning publication_sequence into next_version;
 insert into public.duty_publications(month,version,published_by) values(m.month,next_version,auth.uid()) returning id into publication;
 insert into public.duty_assignments(publication_id,day,end_day,primary_id,secondary_id,manager_override,title,extra_points,saturday_extra_points,locked)
 select publication,x.day,x.end_day,case when x.id=d.id then p_primary else x.primary_id end,x.secondary_id,
  case when x.id=d.id and changed then exists(select 1 from public.duty_constraints c where c.kind='no' and c.day>=x.day and c.day<x.end_day and c.member_id in (p_primary,x.secondary_id))
   else x.manager_override end,x.title,case when x.id=d.id then p_extra_points else x.extra_points end,case when x.id=d.id then saturday else x.saturday_extra_points end,x.locked
 from public.duty_assignments x where x.publication_id=p_publication;
 -- The allocation keeps its lineage like an approved swap; locks follow the new
 -- engineer and approvals for the changed dates or the two engineers' weekends drop.
 -- Its targets follow the edit, so a reopened copy of this version still matches its plan.
 select allocation into plan from public.duty_allocations where publication_id=p_publication;
 if jsonb_typeof(plan->'targetsUnits')='object' then
  plan:=jsonb_set(plan,array['targetsUnits',d.primary_id::text],to_jsonb(coalesce((plan->'targetsUnits'->>d.primary_id::text)::bigint,0)-(d.points*2)::bigint));
  plan:=jsonb_set(plan,array['targetsUnits',p_primary::text],to_jsonb(coalesce((plan->'targetsUnits'->>p_primary::text)::bigint,0)
   +(select (x.points*2)::bigint from public.duty_assignments x where x.publication_id=publication and x.day=d.day)));
 end if;
 insert into public.duty_allocations(month,publication_id,allocation_id,allocation,locks,approvals,accounting_fingerprint,calendar_fingerprint,source_publication_id,generation,origin)
 select month,publication,allocation_id,plan,
  (select coalesce(jsonb_agg(case when changed and (l->>'dutyId')>=d.day::text and (l->>'dutyId')<d.end_day::text then jsonb_set(l,'{engineer}',to_jsonb(p_primary::text)) else l end),'[]') from jsonb_array_elements(locks) l),
  (select coalesce(jsonb_agg(v),'[]') from jsonb_array_elements(approvals) v where not changed or (
   not (v->>'rule' in ('availability','boundary') and (v->>'dutyId')>=d.day::text and (v->>'dutyId')<d.end_day::text)
   and not (v->>'rule'='consecutive' and exists(select 1 from jsonb_array_elements_text(case when jsonb_typeof(v->'duties')='array' then v->'duties' else '[]' end) k where k>=d.day::text and k<d.end_day::text))
   and not (v->>'rule'='weekends' and v->>'engineer' in (d.primary_id::text,p_primary::text)))),
  accounting_fingerprint,calendar_fingerprint,p_publication,generation,'swap'
 from public.duty_allocations where publication_id=p_publication;
 if changed and p_kind='permanent' then
  -- The duty's owner: walk the month's recorded publications back past Temporary
  -- moves (edits, swaps, a plan's temporary intent) to its last permanent holder.
  -- Permanent then gives the duty for good from the owner, so an earlier
  -- Temporary debt for this duty never stays behind for work nobody does.
  owner:=d.primary_id; target:=p_publication::text;
  loop
   select e.sequence,e.operation into seq,op from public.duty_compensation_events e where e.operation->>'kind'='publication' and e.operation->>'month'=m.month
    and e.operation->'after'->>'id'=target and (seq is null or e.sequence<seq) order by e.sequence desc limit 1;
   exit when not found;
   prior:=null;
   if op->>'beforeId' is not null then
    select e.operation into prior from public.duty_compensation_events e where e.operation->>'kind'='publication' and e.operation->>'month'=m.month
     and e.operation->'after'->>'id'=op->>'beforeId' and e.sequence<seq order by e.sequence desc limit 1;
   end if;
   select x->>'primaryId' into holder from jsonb_array_elements(op->'after'->'duties') x where x->>'startDate'=d.day::text and x->>'endDate'=d.end_day::text;
   exit when holder is distinct from owner::text;
   -- An intent recorded by this version for this duty decides its owner.
   select i into source from jsonb_array_elements(op->'after'->'intents') i where i->>'toId'=holder
    and not coalesce(prior->'after'->'intents' @> jsonb_build_array(jsonb_build_object('id',i->>'id')),false)
    and exists(select 1 from jsonb_array_elements(i->'capacity') k where (k->>'date')::date>=d.day and (k->>'date')::date<d.end_day) limit 1;
   if found then
    if source->>'kind'='temporary' and not coalesce(source->'route' @> '[{"kind":"permanent"}]',false) then owner:=(source->>'fromId')::uuid; end if;
    exit;
   end if;
   exit when prior is null;
   select x->>'primaryId' into previous from jsonb_array_elements(prior->'after'->'duties') x where x->>'startDate'=d.day::text and x->>'endDate'=d.end_day::text;
   exit when previous is null;
   owner:=previous::uuid; target:=op->>'beforeId';
  end loop;
  if not exists(select 1 from public.duty_members where id=owner and active and status='approved') then owner:=d.primary_id; end if;
  -- Returning the duty to its owner is the ordinary transition, which cancels the debt.
  if owner<>p_primary then
   old_atoms:=duty_private.compensation_atoms(duty_private.compensation_snapshot(p_publication));
   new_atoms:=duty_private.compensation_atoms(duty_private.compensation_snapshot(publication));
   for atom,a in select key,value from jsonb_each(old_atoms) where (value->>'date')::date>=d.day and (value->>'date')::date<d.end_day order by key loop
    capacity:=capacity||jsonb_build_array(jsonb_build_object('date',atom,'offset',0,'units',least((a->>'units')::bigint,(new_atoms->atom->>'units')::bigint)));
   end loop;
   intent:=jsonb_build_object('id','edit/'||publication,'kind','permanent','fromId',d.primary_id,'toId',p_primary,'capacity',capacity);
   -- The holder covers the owner temporarily: return it to the owner (cancelling
   -- that debt), then the owner gives it permanently to the new engineer.
   if owner<>d.primary_id then
    select sum((k->>'units')::bigint) into amount from jsonb_array_elements(capacity) k;
    intent:=intent||jsonb_build_object('kind','temporary','route',jsonb_build_array(
     jsonb_build_object('fromId',d.primary_id,'toId',owner,'kind','temporary','transferIds',jsonb_build_array('edit/'||publication||'/return'),
      'counterparts',jsonb_build_array(jsonb_build_object('id','edit/'||publication||'/return','fromId',d.primary_id,'toId',owner,'units',amount,'kind','temporary'))),
     jsonb_build_object('fromId',owner,'toId',p_primary,'kind','permanent','transferIds',jsonb_build_array('edit/'||publication||'/permanent'),
      'counterparts',jsonb_build_array(jsonb_build_object('id','edit/'||publication||'/permanent','fromId',owner,'toId',p_primary,'units',amount,'kind','permanent')))));
   end if;
  end if;
 end if;
 -- Record the accounting with this edit before the pointer moves; the pointer
 -- trigger then finds the version recorded and only reconciles pending swaps.
 perform duty_private.compensation_publication(m.month,publication,NULL,false,jsonb_build_object(
  'intents',case when intent is null then '[]'::jsonb else jsonb_build_array(intent) end,
  'reason','Published duty edit '||d.day||' ('||p_kind||')'||case when conflicts then '. Availability override: '||reason else '' end));
 update public.duty_months set current_publication_id=publication where month=m.month;
 -- New points change the month's calendar; the copied plan follows it as its targets do.
 if p_extra_points<>d.extra_points or saturday<>d.saturday_extra_points then
  update public.duty_allocations set calendar_fingerprint=md5((select jsonb_agg(x-array['primary','secondary'] order by x->>'id')::text
   from jsonb_array_elements(duty_private.generation_facts(m.month)->'duties') x)) where publication_id=publication;
 end if;
 -- Consent was given at the earlier points. The pointer hook already handles an
 -- engineer change; new points invalidate a pending swap of this duty.
 if not changed then
  update public.duty_swap_requests set status='invalidated',accepted_by=null,accepted_at=null,resolved_at=now(),resolved_by=null
  where duty_swap_requests.month=m.month and duty_swap_requests.status in ('awaiting_engineer','awaiting_admin')
   and ((from_day=d.day and from_end_day=d.end_day) or (to_day=d.day and to_end_day=d.end_day));
 end if;
 update public.duty_workspace set revision=revision+1 where id;
 return jsonb_build_object('publication',publication,'version',next_version);
end $$;
