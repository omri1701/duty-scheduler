-- Ledger fixes found by the generator-based ledger hunt (decision 2026-11-06).
-- 1. Permanent edit: the engineer being replaced, whoever holds the duty now, gives it away
--    for good. No debt for anyone: no owner walk and no Temporary "return" leg, so editing a
--    swapped duty Permanent no longer makes the swap partner owe the old owner.
--    H1: giving it back to someone who held it before a Temporary change still in effect is
--    that change's undo (a Temporary `edit/` intent), so the earlier debt cancels.
--    duty_edit_returns tells Edit duty who that is, so its summary says what is booked.
-- 2. Deleting the live version back to an earlier one is that version's exact undo. New
--    deletion events say so ("revert": true): capacity the removed version's intents moved
--    returns without an ordinary debt, Temporary legs are reversed, and a repayment a
--    Permanent move cancelled counts as done again. Earlier events replay as recorded.
-- 3. A weighted swap's copied plan targets follow the swap (as an edit's do), so Reopen +
--    Publish of a month after a weighted swap no longer fails target-exceeded.
-- 4. Plan the month on a published month whose duty points an edit changed: the stored plan's
--    baseline no longer fits those points, so Confirm takes the new plan's baseline instead of
--    refusing it as "Ordinary baseline is immutable".
-- Existing functions keep their owner, SECURITY DEFINER, search_path and grants.

-- Source: schemas/functions/duty_private/edit_returns.sql
-- Who a Permanent edit of this published duty would return it to as an undo (rule H1,
-- decision 2026-11-06): the engineers who held it before a Temporary change still in
-- effect, most recent first. Replays the duty's version lineage forward: a Temporary edit
-- (only this duty changed hands, no new intent) adds its previous holder; a return to one
-- of them (a Temporary `edit/` intent) drops the undone changes; a swap, a Permanent edit,
-- a plan or any other change starts again. Versions restored by deletion keep the chain of
-- the version they restore. Manager only; nothing leaves but member ids.
CREATE FUNCTION duty_private.edit_returns(p_publication uuid, p_day date) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare d public.duty_assignments; m text; target text:=p_publication::text; seq bigint; op jsonb; prior jsonb;
 lineage jsonb:='[]'; step jsonb; holder text; previous text; chain jsonb:='[]'; intent jsonb; k integer;
begin
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 select * into d from public.duty_assignments where publication_id=p_publication and day=p_day;
 if d.id is null or d.primary_id is null then return chain; end if;
 m:=duty_private.duty_owner(d.day);
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
  select x->>'primaryId' into previous from jsonb_array_elements(step->'before'->'duties') x where x->>'startDate'=d.day::text and x->>'endDate'=d.end_day::text;
  select x->>'primaryId' into holder from jsonb_array_elements(step->'after'->'duties') x where x->>'startDate'=d.day::text and x->>'endDate'=d.end_day::text;
  if previous is null or holder is null then chain:='[]'; continue; end if;
  if previous=holder then continue; end if;
  select i into intent from jsonb_array_elements(step->'after'->'intents') i
   where not coalesce(step->'before'->'intents' @> jsonb_build_array(jsonb_build_object('id',i->>'id')),false)
    and exists(select 1 from jsonb_array_elements(i->'capacity') c where (c->>'date')::date>=d.day and (c->>'date')::date<d.end_day) limit 1;
  if intent is not null then
   -- A return to an earlier holder undoes the changes after it; anything else starts again.
   select max(n) into k from jsonb_array_elements_text(chain) with ordinality o(v,n) where v=holder;
   chain:=case when intent->>'kind'='temporary' and starts_with(intent->>'id','edit/') and intent->'route' is null and k is not null
    then coalesce((select jsonb_agg(v order by n) from jsonb_array_elements_text(chain) with ordinality o(v,n) where n<k),'[]') else '[]' end;
  elsif (select count(*) from jsonb_array_elements(step->'after'->'duties') x where not exists(select 1 from jsonb_array_elements(step->'before'->'duties') y
    where y->>'startDate'=x->>'startDate' and y->>'endDate'=x->>'endDate' and y->>'primaryId'=x->>'primaryId'))=1 then
   chain:=chain||to_jsonb(previous);
  else chain:='[]';
  end if;
 end loop;
 -- Most recent first; only engineers who can still take the duty.
 return coalesce((select jsonb_agg(v order by n desc) from jsonb_array_elements_text(chain) with ordinality o(v,n)
  where exists(select 1 from public.duty_members where id::text=v and active and status='approved')),'[]');
end $$;

-- Source: schemas/functions/public/duty_edit_returns.sql
CREATE FUNCTION public.duty_edit_returns(p_publication uuid, p_day date) RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$select duty_private.edit_returns(p_publication,p_day)$$;

-- Source: schemas/grants/functions.sql
REVOKE ALL ON FUNCTION duty_private.edit_returns(p_publication uuid, p_day date) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION duty_private.edit_returns(p_publication uuid, p_day date) TO authenticated;
REVOKE ALL ON FUNCTION public.duty_edit_returns(p_publication uuid, p_day date) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.duty_edit_returns(p_publication uuid, p_day date) TO authenticated;

-- Source: schemas/functions/duty_private/edit_published_duty.sql
-- An admin changes one published duty's engineer and/or extra points without a
-- swap, publishing a new version. Accounting stays canonical: the ordinary
-- publication transition makes the old engineer owe the new one each date's shared
-- units (Temporary); Permanent adds a reviewed permanent intent from that old engineer
-- over exactly those units, so no debt. Added extra counts for whoever does the duty.
CREATE OR REPLACE FUNCTION duty_private.edit_published_duty(p_publication uuid, p_day date, p_primary uuid, p_extra_points numeric, p_saturday_extra_points numeric, p_kind text, p_revision bigint, p_override_reason text DEFAULT ''::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare d public.duty_assignments; m public.duty_months; publication uuid; next_version integer; reason text:=btrim(coalesce(p_override_reason,''),U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');
 saturday numeric:=coalesce(p_saturday_extra_points,0); changed boolean; conflicts boolean:=false; capacity jsonb:='[]'; old_atoms jsonb; new_atoms jsonb; atom text; a jsonb;
 plan jsonb; intent jsonb; back boolean;
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
  -- Permanent: the engineer being replaced, whoever holds the duty now, gives it away for
  -- good (decision 2026-11-06). A permanent intent over each date's shared units, so no
  -- debt for anyone; earlier swaps, edits and the plan's own changes keep their balances.
  -- H1: giving it back to someone who held it before a Temporary change still in effect is
  -- that change's undo: a Temporary `edit/` intent, so the earlier debt cancels.
  back:=duty_private.edit_returns(p_publication,d.day) ? p_primary::text;
  old_atoms:=duty_private.compensation_atoms(duty_private.compensation_snapshot(p_publication));
  new_atoms:=duty_private.compensation_atoms(duty_private.compensation_snapshot(publication));
  for atom,a in select key,value from jsonb_each(old_atoms) where (value->>'date')::date>=d.day and (value->>'date')::date<d.end_day order by key loop
   capacity:=capacity||jsonb_build_array(jsonb_build_object('date',atom,'offset',0,'units',least((a->>'units')::bigint,(new_atoms->atom->>'units')::bigint)));
  end loop;
  intent:=jsonb_build_object('id','edit/'||publication,'kind',case when back then 'temporary' else 'permanent' end,'fromId',d.primary_id,'toId',p_primary,'capacity',capacity);
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
 -- Saving cancels a pending swap of this duty (decision 2026-11-02; Edit duty names it
 -- before saving): consent was given for the earlier engineer and points, so the
 -- pointer hook's re-ask of a new counterpart is not kept either.
 update public.duty_swap_requests set status='invalidated',accepted_by=null,accepted_at=null,resolved_at=now(),resolved_by=null
 where duty_swap_requests.month=m.month and duty_swap_requests.status in ('awaiting_engineer','awaiting_admin')
  and ((from_day=d.day and from_end_day=d.end_day) or (to_day=d.day and to_end_day=d.end_day));
 update public.duty_workspace set revision=revision+1 where id;
 return jsonb_build_object('publication',publication,'version',next_version);
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
 reverted jsonb:='{}'::jsonb; given jsonb:='{}'::jsonb; cells jsonb;
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
 -- Deleting the live version back to an earlier one is its exact undo (decision 2026-11-06).
 -- Capacity an intent of the removed version moved returns without an ordinary debt, each
 -- Temporary leg of it is reversed, and a repayment it cancelled by a Permanent move counts
 -- as done again. Only events that say so: earlier deletions replay as they were recorded.
 -- Same as lib/compensation/publication.ts.
 if op ? 'revert' then
  if op->'revert'<>'true'::jsonb or coalesce(op->>'mode','')<>'delete' or after_pub is null or before_pub is null then raise exception 'invalid-publication-deletion'; end if;
  for intent in select value from jsonb_array_elements(coalesce(before_pub->'intents','[]')) order by value->>'id' COLLATE "C" loop
   if exists(select 1 from jsonb_array_elements(after_pub->'intents') i where i->>'id'=intent->>'id') then continue; end if;
   amount:=0;
   for cap in select value from jsonb_array_elements(intent->'capacity') loop
    day:=cap->>'date'; a:=old_atoms->day; b:=new_atoms->day;
    if a is null or b is null or a->>'primaryId'<>intent->>'toId' or b->>'primaryId'<>intent->>'fromId' then continue; end if;
    select coalesce(jsonb_agg(i),'[]') into cells from generate_series((cap->>'offset')::bigint,least((cap->>'offset')::bigint+(cap->>'units')::bigint,(a->>'units')::bigint,(b->>'units')::bigint)-1) i;
    reverted:=reverted||jsonb_build_object(day,coalesce(reverted->day,'[]')||cells);
    if intent->>'kind'='permanent' and intent->'route' is null then given:=given||jsonb_build_object(day,coalesce(given->day,'[]')||cells); end if;
    amount:=amount+jsonb_array_length(cells);
   end loop;
   if amount>0 then
    for leg in select value from jsonb_array_elements(coalesce(intent->'route',jsonb_build_array(intent))) with ordinality o(value,n) order by n loop
     if leg->>'kind'='temporary' then effects:=effects||jsonb_build_array(jsonb_build_object('debtorId',leg->'toId','creditorId',leg->'fromId','units',amount)); end if;
    end loop;
   end if;
  end loop;
  for r in select value from jsonb_array_elements(after_pub->'reservations') order by value->>'id' COLLATE "C" loop
   if exists(select 1 from jsonb_array_elements(before_pub->'reservations') o where o->>'id'=r->>'id') or s->'contributions'->(r->>'id')->>'status' is distinct from 'cancelled' then continue; end if;
   select count(*) into amount from jsonb_array_elements(coalesce(given->(r->'capacity'->>'date'),'[]')) g
    where (g#>>'{}')::bigint>=(r->'capacity'->>'offset')::bigint and (g#>>'{}')::bigint<(r->'capacity'->>'offset')::bigint+(r->'capacity'->>'units')::bigint;
   if amount>0 then effects:=effects||jsonb_build_array(jsonb_build_object('debtorId',r->'claim'->'creditorId','creditorId',r->'claim'->'debtorId','units',amount)); end if;
  end loop;
 end if;
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
    select exists(select 1 from jsonb_array_elements(coalesce(after_pub->'intents','[]')) i,jsonb_array_elements(i->'capacity') p where i->>'kind'='permanent' and not (s->'intents' ? (i->>'id')) and p->>'date'=day and cell>=(p->>'offset')::bigint and cell<(p->>'offset')::bigint+(p->>'units')::bigint)
     or coalesce(reverted->day,'[]') @> jsonb_build_array(cell) into exempt;
    if not exempt then excluded:=duty_private.compensation_exclude(excluded,jsonb_build_object('date',day,'offset',cell,'units',1)); amount:=amount+1; end if;
   end loop;
   if amount>0 and c->'claim'->>'creditorId'<>b->>'primaryId' then effects:=effects||jsonb_build_array(jsonb_build_object('debtorId',c->'claim'->'creditorId','creditorId',b->'primaryId','units',amount)); end if;
  end if;
 end loop;
 -- Returned capacity owes nothing; a cancelled repayment above was exempt over it too.
 for day,cells in select * from jsonb_each(reverted) order by key loop
  for cell in select (x#>>'{}')::bigint from jsonb_array_elements(cells) x loop
   excluded:=duty_private.compensation_exclude(excluded,jsonb_build_object('date',day,'offset',cell,'units',1));
  end loop;
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

-- Source: schemas/functions/duty_private/compensation_publication.sql
-- edit: a server-built published duty edit, {intents, reason}. Its permanent
-- intents join the carried ones; the reason is the event's manager-only audit.
CREATE OR REPLACE FUNCTION duty_private.compensation_publication(month text, publication uuid, metadata jsonb DEFAULT NULL, deleting boolean DEFAULT false, edit jsonb DEFAULT NULL) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
#variable_conflict use_column
declare s jsonb; before_pub jsonb; after_pub jsonb; op jsonb; atoms jsonb; old_atoms jsonb; reservations jsonb; instant bigint; known jsonb; allocation public.duty_allocations; facts jsonb; checked jsonb; assignments jsonb; ledger text;
begin
 perform 1 from public.duty_workspace where id for update;
 s:=duty_private.compensation_state(); before_pub:=s->'publications'->month;
 instant:=greatest(duty_private.compensation_now(),coalesce((s->'events'->-1->>'at')::bigint,0));
 s:=duty_private.compensation_reconcile(s,instant);
 -- Ordinary copies retain accounting metadata and contribution identities.
 if before_pub->>'id'=publication::text then return; end if;
 if before_pub is null and publication is null then return; end if;
 ledger:=md5((s->'events')::text);
 select * into allocation from public.duty_allocations where publication_id=publication and duty_allocations.month=month;
 -- A new plan for a published month replaces that month's ledger entries in this
 -- transaction (decision 2026-11-01): audited corrections reverse every lot its
 -- publications booked and the publication is deleted, cancelling its pending
 -- repayments; the plan is then booked as a first publication. Refused while another
 -- month's repayment uses those lots (review-replan-later:<month>) or once it started. A month
 -- whose only version was deleted keeps its lots live until then; they are reversed too.
 if not deleting and publication is not null and allocation.month is not null and allocation.source_publication_id is null then
  -- The ledger may have moved since the plan was confirmed (another month published): the
  -- re-plan and the binding below re-check every source, so the plan publishes whenever it
  -- still books (decision 2026-11-01); only a plan that no longer books asks to refresh.
  -- A month that can't be re-planned says why: refreshing would not change that.
  begin s:=duty_private.compensation_replan(s,month,instant,true);
  exception when others then
   if SQLERRM not like 'review-replan-%' and allocation.accounting_fingerprint<>ledger then raise exception 'Compensation changed. Refresh and review.' using errcode='40001'; end if;
   raise;
  end;
  before_pub:=null;
 end if;
 after_pub:=duty_private.compensation_snapshot(publication);
 if deleting and after_pub is not null then
  select x->'operation'->'after' into known from jsonb_array_elements(s->'events') x where x->'operation'->>'kind'='publication' and x->'operation'->'after'->>'id'=publication::text limit 1;
  -- Pre-cutover history was never committed in this ledger. For an unknown
  -- version compare only this live transition; never replay its old origins.
  if known is not null then after_pub:=known; end if;
  if known is not null and duty_private.compensation_replanned(s,month,publication) then raise exception '% was re-planned after this version, so its points can''t come back. Reopen the month and change its plan instead.',to_char(to_date(month||'-01','YYYY-MM-DD'),'FMMonth YYYY'); end if;
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
  if allocation.month is not null then
   if metadata is not null then raise exception 'Allocation accounting is server-owned'; end if;
   if allocation.source_publication_id is null then
    if before_pub is not null and allocation.allocation->'transfers'<>'[]' then raise exception 'Review published transfer lineage before changing allocation'; end if;
    facts:=duty_private.generation_facts(month);
    begin metadata:=duty_private.allocation_bind(facts,allocation.allocation,s,allocation.allocation_id,after_pub,instant);
    exception when others then
     if allocation.accounting_fingerprint<>ledger then raise exception 'Compensation changed. Refresh and review.' using errcode='40001'; end if;
     raise;
    end;
   elsif allocation.origin<>'swap' then
    if allocation.source_publication_id::text is distinct from s->'publications'->month->>'id' and duty_private.compensation_replanned(s,month,allocation.source_publication_id) then raise exception '% was re-planned after this version, so its points can''t come back. Reopen the month and change its plan instead.',to_char(to_date(month||'-01','YYYY-MM-DD'),'FMMonth YYYY'); end if;
    metadata:=duty_private.allocation_rebind(s,after_pub,allocation.source_publication_id,allocation.allocation_id,instant);
   end if;
  end if;
  -- Client metadata (a month without a confirmed allocation) cannot borrow the
  -- identities the server reserves for compiled allocation intent and system
  -- uneven-month credit, which duty_balance would otherwise label as such.
  if allocation.month is null and metadata is not null and exists(select 1 from jsonb_array_elements(case when jsonb_typeof(metadata->'intents')='array' then metadata->'intents' else '[]'::jsonb end) i
   where jsonb_typeof(i)='object' and not coalesce(s->'intents' ? (i->>'id'),false) and (starts_with(coalesce(i->>'id',''),'allocation/')
    or exists(select 1 from jsonb_array_elements(case when jsonb_typeof(i->'route')='array' then i->'route' else '[]'::jsonb end) l where jsonb_typeof(l)='object'
     and (exists(select 1 from jsonb_array_elements(case when jsonb_typeof(l->'transferIds')='array' then l->'transferIds' else '[]'::jsonb end) t where starts_with(coalesce(t#>>'{}',''),'uneven/'))
      or exists(select 1 from jsonb_array_elements(case when jsonb_typeof(l->'counterparts')='array' then l->'counterparts' else '[]'::jsonb end) c where starts_with(coalesce(c->>'id',''),'uneven/')))))) then raise exception 'invalid-intent'; end if;
  if metadata is not null then
   if jsonb_typeof(metadata) IS DISTINCT FROM 'object' or metadata - array['fingerprint','reservations','intents']<>'{}' then raise exception 'Invalid compensation metadata'; end if;
   if metadata->>'fingerprint' is distinct from md5((s->'events')::text) then raise exception 'Compensation changed. Refresh and review.' using errcode='40001'; end if;
   after_pub:=after_pub||jsonb_build_object('reservations',coalesce(metadata->'reservations',reservations),'intents',coalesce(metadata->'intents',before_pub->'intents','[]'));
  end if;
  if edit is not null then
   if metadata is not null or deleting or before_pub is null then raise exception 'invalid-publication-edit'; end if;
   after_pub:=jsonb_set(after_pub,'{intents}',(after_pub->'intents')||coalesce(edit->'intents','[]'));
  end if;
 end if;
 op:=jsonb_build_object('kind','publication','month',month,'beforeId',before_pub->'id','after',after_pub);
 -- Unknown pre-cutover versions preserve completed facts below the ordinary
 -- transition rules. Known deletion uses the core's terminal handling.
 -- Deleting back to a known earlier version is that version's exact undo (decision 2026-11-06).
 if deleting and (after_pub is null or known is not null) and before_pub is not null then
  op:=op||case when after_pub is null then '{"mode":"delete"}' else '{"mode":"delete","revert":true}' end::jsonb;
 end if;
 perform duty_private.compensation_append(s,op,'publication/'||coalesce(publication::text,'none')||'/'||(coalesce((s->'events'->-1->>'sequence')::bigint,0)+1),instant,coalesce(auth.uid()::text,'system'),nullif(edit->>'reason',''));
end $$;

-- Source: schemas/functions/duty_private/resolve_swap.sql
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

-- Source: schemas/functions/duty_private/confirm_allocation.sql
CREATE OR REPLACE FUNCTION duty_private.confirm_allocation(p_month text, p_allocation jsonb, p_locks jsonb, p_approvals jsonb, p_revision bigint, p_fingerprint text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare ctx jsonb; facts jsonb; assignments jsonb; checked jsonb; projected jsonb; old_meta public.duty_allocations; instant bigint; fits boolean:=true;
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
 select * into old_meta from public.duty_allocations where month=p_month and publication_id is null;
 -- Copies retain original reviewed provenance, even when its claims have already
 -- settled. A new proposal must use current unreserved sources instead.
 if old_meta.source_publication_id is null or old_meta.allocation IS DISTINCT FROM p_allocation then
  -- A new plan for a published month is checked against the ledger without that month's
  -- own entries, as its publication will book it (decision 2026-11-01). Re-planned now and
  -- projected after, as generation_context does: the re-plan keys carry the ledger position.
  projected:=duty_private.compensation_state();
  instant:=greatest((ctx->>'actualAtMs')::bigint,coalesce((projected->'events'->-1->>'at')::bigint,0));
  projected:=duty_private.compensation_replan(projected,p_month,instant);
  projected:=duty_private.compensation_reconcile(projected,greatest(instant,(ctx->>'coverageStartMs')::bigint,coalesce((projected->'events'->-1->>'at')::bigint,0)),false);
  perform duty_private.allocation_compile(facts,p_allocation,checked->'actualUnits',projected);
  perform duty_private.allocation_baseline(facts,p_allocation->'baselineUnits');
  -- The transfer list is derived, never chosen: the per-person changes and the
  -- recorded pairs must give exactly this list under the current seniority.
  if p_allocation->'transfers' IS DISTINCT FROM duty_private.allocation_transfers(facts->'seniority',p_allocation->'changes',p_allocation->'pairs') then raise exception 'invalid-derived-transfers'; end if;
  -- Uneven-month credit is derived too: exactly the fitted baseline's excess over the
  -- plain split that each creditor still carries after permanent changes, owed by the
  -- members still below it, paired under the current seniority. A manager can neither
  -- add, enlarge, redirect nor drop it.
  if coalesce(p_allocation->'uneven','[]'::jsonb) IS DISTINCT FROM duty_private.allocation_uneven(facts,p_allocation->'baselineUnits',p_allocation->'changes') then raise exception 'invalid-uneven-credit'; end if;
  -- A stored baseline the month's duties can no longer split into (a published edit changed their
  -- points, and the copied plan's calendar follows it) is replaced by the new plan's (2026-11-06).
  if old_meta.month is not null and old_meta.allocation->'baselineUnits'<>p_allocation->'baselineUnits' then
   begin perform duty_private.allocation_baseline(facts,old_meta.allocation->'baselineUnits');
   exception when raise_exception then if SQLERRM<>'invalid-ordinary-baseline' then raise; end if; fits:=false;
   end;
  end if;
  if fits and old_meta.month is not null and old_meta.calendar_fingerprint=md5((select jsonb_agg(d-array['primary','secondary'] order by d->>'id')::text from jsonb_array_elements(facts->'duties') d))
   and (select array_agg(key order by key) from jsonb_each(old_meta.allocation->'baselineUnits'))=(select array_agg(key order by key) from jsonb_each(p_allocation->'baselineUnits'))
   and old_meta.allocation->'baselineUnits'<>p_allocation->'baselineUnits' then raise exception 'Ordinary baseline is immutable. Classify target changes as transfers.'; end if;
 end if;
 insert into public.duty_allocations(month,allocation,locks,approvals,accounting_fingerprint,calendar_fingerprint)
 values(p_month,p_allocation,p_locks,p_approvals,ctx->>'accountingFingerprint',md5((select jsonb_agg(d-array['primary','secondary'] order by d->>'id')::text from jsonb_array_elements(facts->'duties') d)))
 on conflict(month,publication_id) do update set allocation=excluded.allocation,locks=excluded.locks,approvals=excluded.approvals,
  accounting_fingerprint=excluded.accounting_fingerprint,calendar_fingerprint=excluded.calendar_fingerprint,generation=null,
  allocation_id=case when duty_allocations.allocation=excluded.allocation then duty_allocations.allocation_id else gen_random_uuid() end,
  source_publication_id=case when duty_allocations.allocation=excluded.allocation then duty_allocations.source_publication_id end;
 update public.duty_assignments a set locked=exists(select 1 from jsonb_array_elements(p_locks) l where l->>'dutyId'=a.day::text) where a.publication_id is null and duty_private.duty_owner(a.day)=p_month;
 update public.duty_workspace set revision=revision+1 where id;
 return duty_private.generation_context(p_month,(select revision from public.duty_workspace where id));
end $$;

NOTIFY pgrst, 'reload schema';
