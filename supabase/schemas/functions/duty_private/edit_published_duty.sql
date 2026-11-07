-- An admin changes one published duty's engineer and/or extra points without a
-- swap, publishing a new version. Accounting stays canonical: the ordinary
-- publication transition makes the old engineer owe the new one each date's shared
-- units (Temporary); Permanent adds a reviewed permanent intent from that old engineer
-- over exactly those units, so no debt. Added extra counts for whoever does the duty.
-- A weekend whose two halves end up identical (same primary, cover and lock, neither started)
-- is one ordinary Friday–Sunday duty again (decision 2026-11-07): swaps and weekend rules see
-- one weekend, never a half each. Each date keeps its own extra; already-saved identical
-- halves heal on the next edit of either.
CREATE FUNCTION duty_private.edit_published_duty(p_publication uuid, p_day date, p_primary uuid, p_extra_points numeric, p_saturday_extra_points numeric, p_kind text, p_revision bigint, p_override_reason text DEFAULT ''::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare d public.duty_assignments; m public.duty_months; publication uuid; next_version integer; reason text:=btrim(coalesce(p_override_reason,''),U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');
 saturday numeric:=coalesce(p_saturday_extra_points,0); changed boolean; conflicts boolean:=false; capacity jsonb:='[]'; old_atoms jsonb; new_atoms jsonb; atom text; a jsonb;
 plan jsonb; intent jsonb; back boolean; backs jsonb:='[]'; fri public.duty_assignments; sat public.duty_assignments; edited bigint;
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
 select (x.points*2)::bigint into edited from public.duty_assignments x where x.publication_id=publication and x.day=d.day;
 select * into fri from public.duty_assignments x where x.publication_id=publication and extract(dow from x.day)=5 and x.end_day=x.day+1
  and x.day in (d.day,d.day-1);
 select * into sat from public.duty_assignments x where x.publication_id=publication and x.day=fri.day+1 and x.end_day=x.day+1;
 if fri.id is not null and sat.id is not null and fri.day>=(now() at time zone 'Asia/Jerusalem')::date and fri.primary_id is not distinct from sat.primary_id
  and fri.secondary_id is not distinct from sat.secondary_id and fri.locked=sat.locked then
  delete from public.duty_assignments where id=sat.id;
  update public.duty_assignments set end_day=fri.day+2,saturday_extra_points=sat.extra_points,manager_override=fri.manager_override or sat.manager_override,
   title=case when fri.title='' then sat.title else fri.title end where id=fri.id;
 else fri:=null;
 end if;
 -- The allocation keeps its lineage like an approved swap; locks follow the new
 -- engineer and approvals for the changed dates or the two engineers' weekends drop.
 -- Its targets follow the edit, so a reopened copy of this version still matches its plan.
 select allocation into plan from public.duty_allocations where publication_id=p_publication;
 if jsonb_typeof(plan->'targetsUnits')='object' then
  plan:=jsonb_set(plan,array['targetsUnits',d.primary_id::text],to_jsonb(coalesce((plan->'targetsUnits'->>d.primary_id::text)::bigint,0)-(d.points*2)::bigint));
  plan:=jsonb_set(plan,array['targetsUnits',p_primary::text],to_jsonb(coalesce((plan->'targetsUnits'->>p_primary::text)::bigint,0)
   +edited));
 end if;
 insert into public.duty_allocations(month,publication_id,allocation_id,allocation,locks,approvals,accounting_fingerprint,calendar_fingerprint,source_publication_id,generation,origin)
 select month,publication,allocation_id,plan,
  (select coalesce(jsonb_agg(case when changed and (l->>'dutyId')>=d.day::text and (l->>'dutyId')<d.end_day::text then jsonb_set(l,'{engineer}',to_jsonb(p_primary::text)) else l end),'[]') from jsonb_array_elements(locks) l
   where fri.id is null or l->>'dutyId'<>sat.day::text),
  (select coalesce(jsonb_agg(v),'[]') from jsonb_array_elements(approvals) v where not changed or (
   not (v->>'rule' in ('availability','boundary') and (v->>'dutyId')>=d.day::text and (v->>'dutyId')<d.end_day::text)
   and not (v->>'rule'='consecutive' and exists(select 1 from jsonb_array_elements_text(case when jsonb_typeof(v->'duties')='array' then v->'duties' else '[]' end) k where k>=d.day::text and k<d.end_day::text))
   and not (v->>'rule'='weekends' and v->>'engineer' in (d.primary_id::text,p_primary::text)))),
  accounting_fingerprint,calendar_fingerprint,p_publication,generation,'swap'
 from public.duty_allocations where publication_id=p_publication;
 if changed and p_kind='permanent' then
  -- Permanent: the engineer being replaced, whoever holds the duty now, gives it away for
  -- good (decision 2026-11-06). A permanent intent over each date's shared units, so no
  -- debt for anyone; earlier swaps, edits and the plan's own changes keep their balances.
  -- H1: giving it back to someone who held it before a Temporary change still in effect is
  -- that change's undo: a Temporary `edit/` intent, so the earlier debt cancels. Each date
  -- of a weekend keeps its own history (decision 2026-11-07): when its two dates disagree,
  -- each gets its own intent.
  old_atoms:=duty_private.compensation_atoms(duty_private.compensation_snapshot(p_publication));
  new_atoms:=duty_private.compensation_atoms(duty_private.compensation_snapshot(publication));
  for atom,a in select key,value from jsonb_each(old_atoms) where (value->>'date')::date>=d.day and (value->>'date')::date<d.end_day order by key loop
   capacity:=capacity||jsonb_build_array(jsonb_build_object('date',atom,'offset',0,'units',least((a->>'units')::bigint,(new_atoms->atom->>'units')::bigint)));
   backs:=backs||to_jsonb(duty_private.edit_returns(p_publication,atom::date) ? p_primary::text);
  end loop;
  if (select count(distinct v) from jsonb_array_elements(backs) v)<=1 then
   back:=coalesce((backs->>0)::boolean,false);
   intent:=jsonb_build_object('id','edit/'||publication,'kind',case when back then 'temporary' else 'permanent' end,'fromId',d.primary_id,'toId',p_primary,'capacity',capacity);
  else
   intent:=(select jsonb_agg(jsonb_build_object('id','edit/'||publication||'/'||(c->>'date'),'kind',case when (backs->>(n::integer-1))::boolean then 'temporary' else 'permanent' end,
    'fromId',d.primary_id,'toId',p_primary,'capacity',jsonb_build_array(c)) order by n) from jsonb_array_elements(capacity) with ordinality o(c,n));
  end if;
 end if;
 -- Record the accounting with this edit before the pointer moves; the pointer
 -- trigger then finds the version recorded and only reconciles pending swaps.
 perform duty_private.compensation_publication(m.month,publication,NULL,false,jsonb_build_object(
  'intents',case when intent is null then '[]'::jsonb when jsonb_typeof(intent)='array' then intent else jsonb_build_array(intent) end,
  'reason','Published duty edit '||d.day||' ('||p_kind||')'||case when conflicts then '. Availability override: '||reason else '' end));
 update public.duty_months set current_publication_id=publication where month=m.month;
 -- New points, or a weekend joined again, change the month's calendar; the copied plan follows it.
 if p_extra_points<>d.extra_points or saturday<>d.saturday_extra_points or fri.id is not null then
  update public.duty_allocations set calendar_fingerprint=md5((select jsonb_agg(x-array['primary','secondary'] order by x->>'id')::text
   from jsonb_array_elements(duty_private.generation_facts(m.month)->'duties') x)) where publication_id=publication;
 end if;
 -- Saving cancels a pending swap of this duty (decision 2026-11-02; Edit duty names it
 -- before saving): consent was given for the earlier engineer and points, so the
 -- pointer hook's re-ask of a new counterpart is not kept either.
 update public.duty_swap_requests set status='invalidated',accepted_by=null,accepted_at=null,resolved_at=now(),resolved_by=null
 where duty_swap_requests.month=m.month and duty_swap_requests.status in ('awaiting_engineer','awaiting_admin')
  and ((from_day=d.day and from_end_day=d.end_day) or (to_day=d.day and to_end_day=d.end_day)
   or (fri.id is not null and (from_day in (fri.day,sat.day) or to_day in (fri.day,sat.day))));
 update public.duty_workspace set revision=revision+1 where id;
 return jsonb_build_object('publication',publication,'version',next_version);
end $$;
