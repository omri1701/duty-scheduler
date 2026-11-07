-- An admin edits one published weekend as one Friday–Sunday duty or as two days
-- (decision 2026-11-07), publishing a new version. Same people on both dates is one
-- duty; different people split it into a Friday and a Saturday row, each keeping its
-- date's points exactly as typed (0.5 + extra). Accounting stays per date: Temporary is
-- the ordinary publication transition (each date's old holder owes its new one that
-- date's shared units); Permanent adds a reviewed intent per changed date, so no debt,
-- unless it gives the date back to who held it before a Temporary change still in effect
-- (H1: that undo is a Temporary `edit/` intent and the earlier debt cancels). Joining
-- back and changing the halves are booked against the version just before, so undo
-- reverses exactly and nothing is booked twice. Only until Friday starts.
CREATE FUNCTION duty_private.edit_published_weekend(p_publication uuid, p_friday date, p_friday_primary uuid, p_friday_extra numeric, p_saturday_primary uuid, p_saturday_extra numeric, p_kind text, p_revision bigint, p_override_reason text DEFAULT ''::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare m public.duty_months; f public.duty_assignments; s public.duty_assignments; publication uuid; next_version integer;
 reason text:=btrim(coalesce(p_override_reason,''),U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');
 saturday date:=p_friday+1; was_joined boolean; joined boolean; old_saturday_extra numeric; fri_changed boolean; sat_changed boolean; conflicts boolean:=false;
 cover uuid; plan jsonb; intents jsonb:='[]'; old_atoms jsonb; new_atoms jsonb; x record; back boolean;
begin
 perform duty_private.check_revision(p_revision);
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 if p_kind is null or p_kind not in ('temporary','permanent') then raise exception 'Choose Temporary or Permanent'; end if;
 if length(reason)>500 then raise exception 'Keep the override reason under 500 characters'; end if;
 select * into m from public.duty_months where current_publication_id=p_publication for update;
 if m.month is null then raise exception 'This publication changed. Refresh first.' using errcode='40001'; end if;
 -- A reopened draft was copied from the earlier version; publishing it would silently undo this edit.
 if m.status<>'published' then raise exception 'Publish or cancel the open draft before editing published duties'; end if;
 if p_friday is null or extract(dow from p_friday)<>5 or duty_private.duty_owner(p_friday)<>m.month then raise exception 'Choose a weekend in this published month'; end if;
 select * into f from public.duty_assignments a where a.publication_id=p_publication and a.day<=p_friday and a.end_day>p_friday;
 select * into s from public.duty_assignments a where a.publication_id=p_publication and a.day<=saturday and a.end_day>saturday;
 if f.id is null or s.id is null or f.day<>p_friday then raise exception 'Choose a weekend in this published month'; end if;
 -- Split and joined until the weekend starts; a started weekend's Saturday is a normal day.
 if p_friday<(now() at time zone 'Asia/Jerusalem')::date then raise exception 'Choose duties starting today or later'; end if;
 if f.primary_id is null or s.primary_id is null then raise exception 'This duty has no primary engineer'; end if;
 if p_friday_primary is null or p_saturday_primary is null or exists(select 1 from unnest(array[p_friday_primary,p_saturday_primary]) u(member)
  where not exists(select 1 from public.duty_members dm where dm.id=u.member and dm.active and dm.status='approved')) then raise exception 'Choose an active approved engineer'; end if;
 -- Half points stay exact; the table's own bounds apply to both dates.
 if p_friday_extra is null or p_saturday_extra is null or p_friday_extra<0 or p_friday_extra>20 or p_friday_extra*2<>trunc(p_friday_extra*2)
  or p_saturday_extra<0 or p_saturday_extra>20 or p_saturday_extra*2<>trunc(p_saturday_extra*2) then raise exception 'Extra points must be 0 to 20 in half points'; end if;
 was_joined:=f.id=s.id; joined:=p_friday_primary=p_saturday_primary;
 old_saturday_extra:=case when was_joined then f.saturday_extra_points else s.extra_points end;
 fri_changed:=p_friday_primary<>f.primary_id; sat_changed:=p_saturday_primary<>s.primary_id;
 if joined=was_joined and not fri_changed and not sat_changed and p_friday_extra=f.extra_points and p_saturday_extra=old_saturday_extra then raise exception 'Nothing changed'; end if;
 -- Emergency cover stays with its date; one weekend keeps the cover of a date that kept its
 -- engineer (Friday first), else Friday's, else Saturday's.
 if joined then
  select c into cover from unnest(array[case when not fri_changed then f.secondary_id end,case when not sat_changed then s.secondary_id end,f.secondary_id,s.secondary_id]) with ordinality u(c,n)
  where c is not null order by n limit 1;
  if cover=p_friday_primary then raise exception 'A primary engineer cannot also be emergency cover'; end if;
 elsif p_friday_primary=f.secondary_id or p_saturday_primary=s.secondary_id then raise exception 'A primary engineer cannot also be emergency cover'; end if;
 -- A new engineer on a date, or a cover joined onto a date it didn't cover, needs a reason
 -- when they marked that date unavailable.
 select exists(select 1 from public.duty_constraints c where c.kind='no' and ((fri_changed and c.member_id=p_friday_primary and c.day=p_friday)
  or (sat_changed and c.member_id=p_saturday_primary and c.day=saturday)
  or (joined and c.member_id=cover and ((c.day=p_friday and cover is distinct from f.secondary_id) or (c.day=saturday and cover is distinct from s.secondary_id))))) into conflicts;
 if conflicts and reason='' then raise exception 'Availability conflict. An admin must explicitly override with a reason.'; end if;
 update public.duty_months set publication_sequence=publication_sequence+1 where month=m.month returning publication_sequence into next_version;
 insert into public.duty_publications(month,version,published_by) values(m.month,next_version,duty_private.current_member_id()) returning id into publication;
 insert into public.duty_assignments(publication_id,day,end_day,primary_id,secondary_id,manager_override,title,extra_points,saturday_extra_points,locked)
 select publication,a.day,a.end_day,a.primary_id,a.secondary_id,a.manager_override,a.title,a.extra_points,a.saturday_extra_points,a.locked
 from public.duty_assignments a where a.publication_id=p_publication and a.id not in (f.id,s.id);
 -- A row whose dates or engineer changed records an availability override again.
 if joined then
  insert into public.duty_assignments(publication_id,day,end_day,primary_id,secondary_id,manager_override,title,extra_points,saturday_extra_points,locked)
  values(publication,p_friday,p_friday+2,p_friday_primary,cover,
   case when was_joined and not fri_changed then f.manager_override else exists(select 1 from public.duty_constraints c where c.kind='no' and c.day in (p_friday,saturday) and c.member_id in (p_friday_primary,cover)) end,
   case when f.title='' then s.title else f.title end,p_friday_extra,p_saturday_extra,f.locked or s.locked);
 else
  insert into public.duty_assignments(publication_id,day,end_day,primary_id,secondary_id,manager_override,title,extra_points,saturday_extra_points,locked)
  values(publication,p_friday,saturday,p_friday_primary,f.secondary_id,
    case when was_joined or fri_changed then exists(select 1 from public.duty_constraints c where c.kind='no' and c.day=p_friday and c.member_id in (p_friday_primary,f.secondary_id)) else f.manager_override end,
    f.title,p_friday_extra,0,f.locked),
   (publication,saturday,saturday+1,p_saturday_primary,s.secondary_id,
    case when was_joined or sat_changed then exists(select 1 from public.duty_constraints c where c.kind='no' and c.day=saturday and c.member_id in (p_saturday_primary,s.secondary_id)) else s.manager_override end,
    s.title,p_saturday_extra,0,s.locked);
 end if;
 -- The allocation keeps its lineage like an approved swap. Its targets follow each row's
 -- points, its weekend locks follow the new rows and engineers, and approvals for the
 -- weekend's dates or the engineers' weekends drop when someone changed.
 select allocation into plan from public.duty_allocations where publication_id=p_publication;
 if jsonb_typeof(plan->'targetsUnits')='object' then
  for x in select a.primary_id id,-(a.points*2)::bigint units from public.duty_assignments a where a.id in (f.id,s.id)
   union all select a.primary_id,(a.points*2)::bigint from public.duty_assignments a where a.publication_id=publication and a.day in (p_friday,saturday) loop
   plan:=jsonb_set(plan,array['targetsUnits',x.id::text],to_jsonb(coalesce((plan->'targetsUnits'->>x.id::text)::bigint,0)+x.units));
  end loop;
 end if;
 insert into public.duty_allocations(month,publication_id,allocation_id,allocation,locks,approvals,accounting_fingerprint,calendar_fingerprint,source_publication_id,generation,origin)
 select a.month,publication,a.allocation_id,plan,
  (select coalesce(jsonb_agg(l),'[]') from (select l from jsonb_array_elements(a.locks) l where l->>'dutyId' not in (p_friday::text,saturday::text)
   union all select jsonb_set(jsonb_set(t.l,'{dutyId}',to_jsonb(r.day::text)),'{engineer}',to_jsonb(r.primary_id::text)) from public.duty_assignments r
    cross join lateral (select l from jsonb_array_elements(a.locks) l where l->>'dutyId' in (p_friday::text,saturday::text) order by l->>'dutyId' limit 1) t
    where r.publication_id=publication and r.day in (p_friday,saturday) and r.locked) k(l)),
  (select coalesce(jsonb_agg(v),'[]') from jsonb_array_elements(a.approvals) v where not (fri_changed or sat_changed) or (
   not (v->>'rule' in ('availability','boundary') and v->>'dutyId' in (p_friday::text,saturday::text))
   and not (v->>'rule'='consecutive' and exists(select 1 from jsonb_array_elements_text(case when jsonb_typeof(v->'duties')='array' then v->'duties' else '[]' end) k where k in (p_friday::text,saturday::text)))
   and not (v->>'rule'='weekends' and v->>'engineer' in (f.primary_id::text,s.primary_id::text,p_friday_primary::text,p_saturday_primary::text)))),
  a.accounting_fingerprint,a.calendar_fingerprint,p_publication,a.generation,'swap'
 from public.duty_allocations a where a.publication_id=p_publication;
 if p_kind='permanent' and (fri_changed or sat_changed) then
  -- Permanent: each date's current holder gives that date away for good (decision
  -- 2026-11-06): one permanent intent per changed date over its shared units, so no debt.
  -- H1: giving a date back to who held it before a Temporary change still in effect is
  -- that change's undo, a Temporary `edit/` intent, so the earlier debt cancels.
  old_atoms:=duty_private.compensation_atoms(duty_private.compensation_snapshot(p_publication));
  new_atoms:=duty_private.compensation_atoms(duty_private.compensation_snapshot(publication));
  for x in select * from (values(p_friday,f.primary_id,p_friday_primary),(saturday,s.primary_id,p_saturday_primary)) v(day,before,after) where before<>after order by day loop
   back:=duty_private.edit_returns(p_publication,x.day) ? x.after::text;
   intents:=intents||jsonb_build_array(jsonb_build_object('id','edit/'||publication||'/'||x.day,'kind',case when back then 'temporary' else 'permanent' end,
    'fromId',x.before,'toId',x.after,'capacity',jsonb_build_array(jsonb_build_object('date',x.day::text,'offset',0,
     'units',least((old_atoms->x.day::text->>'units')::bigint,(new_atoms->x.day::text->>'units')::bigint)))));
  end loop;
 end if;
 -- Record the accounting with this edit before the pointer moves; the pointer
 -- trigger then finds the version recorded and only reconciles pending swaps.
 perform duty_private.compensation_publication(m.month,publication,NULL,false,jsonb_build_object('intents',intents,
  'reason','Published weekend edit '||p_friday||' ('||case when joined then 'one weekend' else 'two days' end||', '||p_kind||')'||case when conflicts then '. Availability override: '||reason else '' end));
 update public.duty_months set current_publication_id=publication where month=m.month;
 -- The weekend's shape or points changed the month's calendar; the copied plan follows it.
 update public.duty_allocations set calendar_fingerprint=md5((select jsonb_agg(d-array['primary','secondary'] order by d->>'id')::text
  from jsonb_array_elements(duty_private.generation_facts(m.month)->'duties') d)) where publication_id=publication;
 -- Saving cancels a pending swap of either date (decision 2026-11-02; the editor names it first).
 update public.duty_swap_requests set status='invalidated',accepted_by=null,accepted_at=null,resolved_at=now(),resolved_by=null
 where duty_swap_requests.month=m.month and duty_swap_requests.status in ('awaiting_engineer','awaiting_admin')
  and (from_day in (p_friday,saturday) or to_day in (p_friday,saturday));
 update public.duty_workspace set revision=revision+1 where id;
 return jsonb_build_object('publication',publication,'version',next_version,'joined',joined);
end $$;
