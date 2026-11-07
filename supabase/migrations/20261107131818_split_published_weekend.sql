-- Split a published weekend (decision 2026-11-07): Edit duty saves a published weekend as one
-- Friday–Sunday duty or as two days, with the same Temporary/Permanent choice. Each half keeps
-- its own date's points exactly as typed; different people on the two dates split it, the
-- same person joins it back (until Friday starts). The ledger stays per date: Temporary makes
-- each date's old holder owe its new one, Permanent books no debt, and giving a date back
-- undoes the earlier Temporary change (H1), so joining back reverses the debt exactly.
-- 1. duty_edit_published_weekend: the checked, admin-only RPC (revision, current publication,
--    open draft, today, availability override with a reason, half points 0 to 20).
-- 2. edit_returns follows each date through split and joined versions, so H1 works per half.
-- 3. An approved swap that gives someone both halves joins them into one weekend, as an edit does.
-- 4. Edit duty's Permanent edit of a whole weekend gives each date its own undo (H1) when the two
--    dates' histories differ; a weekday or a weekend whose dates agree books exactly as before.
-- No table or data changes. Existing functions keep their owner, SECURITY DEFINER, search_path
-- and grants; the new ones are granted like duty_edit_published_duty.

-- Source: schemas/functions/duty_private/edit_returns.sql
-- Who a Permanent edit of this published date would return it to as an undo (rule H1,
-- decision 2026-11-06): the engineers who held the date before a Temporary change still in
-- effect, most recent first. Replays the version lineage forward per date, so a split or
-- joined weekend keeps each date's chain (decision 2026-11-07): an edit (only dates of this
-- duty's weekend, or of this day, changed hands, and no one gave and took within it, no new
-- intent) adds the date's previous holder; a return to one of them (a Temporary `edit/`
-- intent) drops the undone changes; a swap, a Permanent edit, a plan or any other change
-- starts again. Versions restored by deletion keep the chain of the version they restore.
-- p_day may be any date of a duty. Manager only; nothing leaves but member ids.
CREATE OR REPLACE FUNCTION duty_private.edit_returns(p_publication uuid, p_day date) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare d public.duty_assignments; m text; target text:=p_publication::text; seq bigint; op jsonb; prior jsonb;
 lineage jsonb:='[]'; step jsonb; holder text; previous text; chain jsonb:='[]'; intent jsonb; k integer;
 before_atoms jsonb; after_atoms jsonb; changed jsonb; scope_start date; scope_end date;
begin
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 select * into d from public.duty_assignments where publication_id=p_publication and day<=p_day and end_day>p_day;
 if d.id is null or d.primary_id is null then return chain; end if;
 m:=duty_private.duty_owner(d.day);
 -- A weekend date's edits may change either date of its weekend; a weekday's only itself.
 scope_start:=case when extract(dow from p_day)=6 then p_day-1 else p_day end;
 scope_end:=case when extract(dow from p_day) in (5,6) then scope_start+2 else p_day+1 end;
 -- Back to the month's first version or its latest plan, newest first.
 loop
  select e.sequence,e.operation into seq,op from public.duty_compensation_events e where e.operation->>'kind'='publication' and e.operation->>'month'=m
   and not (e.operation ? 'mode') and e.operation->'after'->>'id'=target and (seq is null or e.sequence<seq) order by e.sequence desc limit 1;
  exit when not found or op->>'beforeId' is null;
  select e.operation into prior from public.duty_compensation_events e where e.operation->>'kind'='publication' and e.operation->>'month'=m
   and not (e.operation ? 'mode') and e.operation->'after'->>'id'=op->>'beforeId' and e.sequence<seq order by e.sequence desc limit 1;
  exit when prior is null;
  lineage:=jsonb_build_array(jsonb_build_object('before',prior->'after','after',op->'after'))||lineage;
  target:=op->>'beforeId';
 end loop;
 for step in select value from jsonb_array_elements(lineage) with ordinality o(value,n) order by n loop
  before_atoms:=duty_private.compensation_atoms(step->'before'); after_atoms:=duty_private.compensation_atoms(step->'after');
  previous:=before_atoms->p_day::text->>'primaryId'; holder:=after_atoms->p_day::text->>'primaryId';
  if previous is null or holder is null then chain:='[]'; continue; end if;
  if previous=holder then continue; end if;
  select i into intent from jsonb_array_elements(step->'after'->'intents') i
   where not coalesce(step->'before'->'intents' @> jsonb_build_array(jsonb_build_object('id',i->>'id')),false)
    and exists(select 1 from jsonb_array_elements(i->'capacity') c where (c->>'date')::date=p_day) limit 1;
  select coalesce(jsonb_agg(jsonb_build_object('date',dk,'before',before_atoms->dk->>'primaryId','after',after_atoms->dk->>'primaryId')),'[]') into changed
  from (select jsonb_object_keys(before_atoms) union select jsonb_object_keys(after_atoms)) x(dk)
  where before_atoms->dk->>'primaryId' is distinct from after_atoms->dk->>'primaryId';
  if intent is not null then
   -- A return to an earlier holder undoes the changes after it; anything else starts again.
   select max(n) into k from jsonb_array_elements_text(chain) with ordinality o(v,n) where v=holder;
   chain:=case when intent->>'kind'='temporary' and starts_with(intent->>'id','edit/') and intent->'route' is null and k is not null
    then coalesce((select jsonb_agg(v order by n) from jsonb_array_elements_text(chain) with ordinality o(v,n) where n<k),'[]') else '[]' end;
  elsif not exists(select 1 from jsonb_array_elements(changed) c where (c->>'date')::date<scope_start or (c->>'date')::date>=scope_end)
   and not exists(select 1 from jsonb_array_elements(changed) a,jsonb_array_elements(changed) b where a->>'before'=b->>'after') then
   chain:=chain||to_jsonb(previous);
  else chain:='[]';
  end if;
 end loop;
 -- Most recent first; only engineers who can still take the duty.
 return coalesce((select jsonb_agg(v order by n desc) from jsonb_array_elements_text(chain) with ordinality o(v,n)
  where exists(select 1 from public.duty_members where id::text=v and active and status='approved')),'[]');
end $$;

-- Source: schemas/functions/duty_private/join_weekend_halves.sql
-- A weekend whose two published halves end up on the same person (same cover and lock, not
-- started) is one ordinary Friday–Sunday duty again (decisions 2026-11-07), as Edit duty does:
-- an approved swap that hands someone the other half joins them. Each date keeps its own
-- extra; the copied plan's lock of Saturday goes with the row. True when it joined. Internal:
-- only resolve_swap calls it, on the version it is creating, before the pointer moves.
CREATE FUNCTION duty_private.join_weekend_halves(p_publication uuid, p_day date) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare friday date; fri public.duty_assignments; sat public.duty_assignments;
begin
 -- Only a version being made: a published one (current or history) never changes.
 if exists(select 1 from public.duty_months where current_publication_id=p_publication) then raise exception 'Published versions are immutable'; end if;
 if p_day is null or extract(dow from p_day) not in (5,6) then return false; end if;
 friday:=case when extract(dow from p_day)=6 then p_day-1 else p_day end;
 select * into fri from public.duty_assignments a where a.publication_id=p_publication and a.day=friday and a.end_day=friday+1;
 select * into sat from public.duty_assignments a where a.publication_id=p_publication and a.day=friday+1 and a.end_day=friday+2;
 if fri.id is null or sat.id is null or friday<(now() at time zone 'Asia/Jerusalem')::date or fri.primary_id is null or fri.primary_id is distinct from sat.primary_id
  or fri.secondary_id is distinct from sat.secondary_id or fri.locked<>sat.locked then return false; end if;
 delete from public.duty_assignments where id=sat.id;
 update public.duty_assignments set end_day=friday+2,saturday_extra_points=sat.extra_points,manager_override=fri.manager_override or sat.manager_override,
  title=case when fri.title='' then sat.title else fri.title end where id=fri.id;
 update public.duty_allocations a set locks=(select coalesce(jsonb_agg(l),'[]') from jsonb_array_elements(a.locks) l where l->>'dutyId'<>sat.day::text)
 where a.publication_id=p_publication;
 return true;
end $$;

-- Source: schemas/functions/duty_private/resolve_swap.sql
CREATE OR REPLACE FUNCTION duty_private.resolve_swap(p_request uuid, p_action text, p_revision bigint, p_override_reason text DEFAULT ''::text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare r public.duty_swap_requests; a public.duty_assignments; b public.duty_assignments;
 current_publication uuid; publication uuid; next_version integer; reason text:=trim(coalesce(p_override_reason,'')); side text; next_status text;
 party boolean:=false; joined boolean:=false;
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
  -- A weighted swap moves points between the two engineers: the copied plan's targets
  -- follow it, so a reopened copy of this version still matches its plan (2026-11-06).
  insert into public.duty_allocations(month,publication_id,allocation_id,allocation,locks,approvals,accounting_fingerprint,calendar_fingerprint,source_publication_id,generation,origin)
  select month,publication,allocation_id,case when jsonb_typeof(allocation->'targetsUnits')='object' and a.points<>b.points then
    jsonb_set(jsonb_set(allocation,array['targetsUnits',r.requester_id::text],to_jsonb(coalesce((allocation->'targetsUnits'->>r.requester_id::text)::bigint,0)-(a.points*2)::bigint+(b.points*2)::bigint)),
     array['targetsUnits',r.other_id::text],to_jsonb(coalesce((allocation->'targetsUnits'->>r.other_id::text)::bigint,0)-(b.points*2)::bigint+(a.points*2)::bigint))
   else allocation end,
   (select coalesce(jsonb_agg(case when l->>'dutyId'=a.day::text then jsonb_set(l,'{engineer}',to_jsonb(r.other_id::text)) when l->>'dutyId'=b.day::text then jsonb_set(l,'{engineer}',to_jsonb(r.requester_id::text)) else l end),'[]') from jsonb_array_elements(locks) l),
   (select coalesce(jsonb_agg(v),'[]') from jsonb_array_elements(approvals) v where
    not (v->>'rule' in ('availability','boundary') and v->>'dutyId' in (a.day::text,b.day::text))
    and not (v->>'rule'='consecutive' and ((v->'duties') ? a.day::text or (v->'duties') ? b.day::text))
    and not (v->>'rule'='weekends' and v->>'engineer' in (r.requester_id::text,r.other_id::text))),accounting_fingerprint,calendar_fingerprint,current_publication,generation,'swap' from public.duty_allocations where publication_id=current_publication;
  -- Both halves of a weekend on one person are one weekend again (decision 2026-11-07).
  joined:=duty_private.join_weekend_halves(publication,a.day);
  joined:=duty_private.join_weekend_halves(publication,b.day) or joined;
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
  -- A joined weekend changed the month's calendar; the copied plan follows it.
  if joined then
   update public.duty_allocations set calendar_fingerprint=md5((select jsonb_agg(d-array['primary','secondary'] order by d->>'id')::text
    from jsonb_array_elements(duty_private.generation_facts(r.month)->'duties') d)) where publication_id=publication;
  end if;
 end if;
 update public.duty_workspace set revision=revision+1 where id;
 return (select status from public.duty_swap_requests where id=r.id);
end $$;

-- Source: schemas/functions/duty_private/edit_published_duty.sql
-- An admin changes one published duty's engineer and/or extra points without a
-- swap, publishing a new version. Accounting stays canonical: the ordinary
-- publication transition makes the old engineer owe the new one each date's shared
-- units (Temporary); Permanent adds a reviewed permanent intent from that old engineer
-- over exactly those units, so no debt. Added extra counts for whoever does the duty.
-- A weekend whose two halves end up identical (same primary, cover and lock, neither started)
-- is one ordinary Friday–Sunday duty again (decision 2026-11-07): swaps and weekend rules see
-- one weekend, never a half each. Each date keeps its own extra; already-saved identical
-- halves heal on the next edit of either.
CREATE OR REPLACE FUNCTION duty_private.edit_published_duty(p_publication uuid, p_day date, p_primary uuid, p_extra_points numeric, p_saturday_extra_points numeric, p_kind text, p_revision bigint, p_override_reason text DEFAULT ''::text) RETURNS jsonb
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

-- Source: schemas/functions/duty_private/edit_published_weekend.sql
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
 insert into public.duty_publications(month,version,published_by) values(m.month,next_version,auth.uid()) returning id into publication;
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

-- Source: schemas/functions/public/duty_edit_published_weekend.sql
CREATE FUNCTION public.duty_edit_published_weekend(p_publication uuid, p_friday date, p_friday_primary uuid, p_friday_extra numeric, p_saturday_primary uuid, p_saturday_extra numeric, p_kind text, p_revision bigint, p_override_reason text DEFAULT ''::text) RETURNS jsonb
    LANGUAGE sql
    SET search_path TO ''
    AS $$select duty_private.edit_published_weekend(p_publication,p_friday,p_friday_primary,p_friday_extra,p_saturday_primary,p_saturday_extra,p_kind,p_revision,p_override_reason)$$;

REVOKE ALL ON FUNCTION duty_private.join_weekend_halves(uuid, date) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION duty_private.edit_published_weekend(uuid, date, uuid, numeric, uuid, numeric, text, bigint, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION duty_private.edit_published_weekend(uuid, date, uuid, numeric, uuid, numeric, text, bigint, text) TO authenticated;

REVOKE ALL ON FUNCTION public.duty_edit_published_weekend(uuid, date, uuid, numeric, uuid, numeric, text, bigint, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.duty_edit_published_weekend(uuid, date, uuid, numeric, uuid, numeric, text, bigint, text) TO authenticated;
