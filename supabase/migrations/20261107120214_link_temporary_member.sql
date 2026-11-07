-- Link a new sign-up to a temporary member (decision 2026-11-07). An admin merges a pending
-- sign-up into a temporary member: that row keeps its id (no history moves) and gains the
-- sign-in through linked_user_id. So a member row's id no longer always equals the caller's
-- auth.uid(): every own-row check now goes through duty_private.current_member_id().
-- Expand-only: existing rows keep auth_user_id = id (temporary: NULL).

-- Source: schemas/tables/duty_members.sql
ALTER TABLE public.duty_members ADD COLUMN linked_user_id uuid,
 ADD CONSTRAINT duty_members_link_check CHECK ((linked_user_id IS NULL OR NOT is_temporary));
ALTER TABLE public.duty_members ALTER COLUMN auth_user_id SET EXPRESSION AS (CASE WHEN is_temporary THEN NULL::uuid ELSE COALESCE(linked_user_id, id) END);
CREATE UNIQUE INDEX duty_members_auth_user ON public.duty_members USING btree (auth_user_id);

-- Source: schemas/functions/duty_private/current_member_id.sql
-- The caller's own member row id (decision 2026-11-07). Equal to auth.uid() for a member who
-- joined; a sign-up linked to a former temporary member owns that member's original id.
-- NULL when signed out or without a row. Never use auth.uid() as a member id.
CREATE OR REPLACE FUNCTION duty_private.current_member_id() RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
 select id from public.duty_members where auth.uid() is not null and auth_user_id=auth.uid()
$$;

-- Source: schemas/functions/duty_private/join_team.sql
CREATE OR REPLACE FUNCTION duty_private.join_team(p_name text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare u auth.users; added integer;
begin
 if auth.uid() is null then raise exception 'Sign in first' using errcode='42501'; end if;
 select * into u from auth.users where id=auth.uid() and email_confirmed_at is not null and not is_anonymous;
 if u.id is null then raise exception 'A verified account is required' using errcode='42501'; end if;
 perform 1 from public.duty_workspace where id for update;
 -- A sign-up linked to a former temporary member already has its row (under that member's id).
 if exists(select 1 from public.duty_members where auth_user_id=u.id) then return; end if;
 insert into public.duty_members(id,email,name,seniority,color)
 values(u.id,lower(u.email),left(coalesce(nullif(trim(p_name),''),split_part(u.email,'@',1)),80),(select coalesce(max(seniority),0)+1 from public.duty_members),(array['#adc9ee','#f0ba95','#c9b1de','#9bcfbe','#e9a2aa','#e7d88f','#dfb4d2','#c1cf98','#94cad7','#cfb39b','#b1c1ca','#aaa8d9','#dbb677','#f1c3ba','#a5dfac'])[(select count(*)::int%15+1 from public.duty_members)]) on conflict(id) do nothing;
 get diagnostics added=row_count;
 if added>0 then update public.duty_workspace set revision=revision+1 where id; end if;
end $$;

-- Source: schemas/functions/duty_private/balance.sql
-- Read-only display projection. Due and future published work is simulated on
-- a private copy; nothing is appended and the workspace revision never changes.
-- Members receive only their own relationships; audit events/reasons never leave.
CREATE OR REPLACE FUNCTION duty_private.balance() RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
#variable_conflict use_column
declare me text; manager boolean; actual jsonb; projected jsonb; instant bigint; lines jsonb; net jsonb;
begin
 if not duty_private.is_member() then raise exception 'Member access required' using errcode='42501'; end if;
 me:=duty_private.current_member_id()::text; manager:=duty_private.is_manager();
 actual:=duty_private.compensation_state();
 instant:=greatest(duty_private.compensation_now(),coalesce((actual->'events'->-1->>'at')::bigint,0));
 actual:=duty_private.compensation_reconcile(actual,instant,false);
 projected:=duty_private.compensation_reconcile(actual,9007199254740991,false);
 with source as (
  -- Open actual relationships, described by their originating lot.
  select c->>'debtorId' debtor,c->>'creditorId' creditor,(c->>'units')::bigint units,
   case when jsonb_array_length(c->'path')>1 then 'routed'
    when lot ? 'correctionOf' then 'correction'
    -- A server-compiled allocation intent leg whose first counterpart is system uneven-month credit.
    when starts_with(lot->>'id',(lot->>'sourceKey')||'/intent/allocation/') and starts_with(coalesce(actual->'intents'->regexp_replace(substr(lot->>'id',length(lot->>'sourceKey')+9),'/route/[0-9]+$','')
     ->'route'->(substring(lot->>'id' from '/route/([0-9]+)$')::integer)->'transferIds'->>0,''),'uneven/') then 'uneven'
    when starts_with(lot->>'id',(lot->>'sourceKey')||'/intent/') then 'temporary'
    when starts_with(lot->>'id',(lot->>'sourceKey')||'/transfer/') then 'change'
    when lot->>'sourceKey' like 'manual/%' then 'manual' else 'other' end kind,
   case when jsonb_array_length(c->'path')=1 and starts_with(lot->>'id',(lot->>'sourceKey')||'/intent/') then
    (select min(p->>'date') from jsonb_array_elements(actual->'intents'->regexp_replace(substr(lot->>'id',length(lot->>'sourceKey')+9),'/route/[0-9]+$','')->'capacity') p) end AS day,
   case when jsonb_array_length(c->'path')=1 and starts_with(lot->>'id',(lot->>'sourceKey')||'/transfer/') then
    (select e->'operation'->>'month' from jsonb_array_elements(actual->'events') e where e->>'sourceKey'=lot->>'sourceKey' limit 1) end AS month
  from jsonb_array_elements(actual->'claims') c cross join lateral (select actual->'lots'->(c->'path'->0->>'lotId') lot) l
  union all
  -- Published repayments that settle only in the projection.
  select r->'claim'->>'debtorId',r->'claim'->>'creditorId',-(r->>'units')::bigint,'repayment',
   projected->'contributions'->(r->>'contributionId')->'capacity'->>'date',null
  from jsonb_each(projected->'settlements') x(id,r) where not (actual->'settlements' ? x.id) and r ? 'contributionId'
 ), side as (
  select creditor member,debtor counterpart,units,kind,day,month from source
  union all select debtor,creditor,-units,kind,day,month from source
 ), visible as (
  select * from side where manager or member=me
 ), relationship as (
  select member,counterpart from visible group by member,counterpart having sum(units)<>0
 )
 select coalesce(jsonb_agg(jsonb_build_object('memberId',v.member,'counterpartId',v.counterpart,'units',v.units,'kind',v.kind,'date',v.day,'month',v.month)
  order by v.member COLLATE "C",v.counterpart COLLATE "C",coalesce(v.day,v.month) COLLATE "C" nulls first,v.kind COLLATE "C",v.units),'[]')
 into lines from visible v join relationship o using(member,counterpart);
 net:=coalesce((select jsonb_object_agg(m.key,coalesce((select sum(case when c->>'creditorId'=m.key then (c->>'units')::bigint else -(c->>'units')::bigint end)
  from jsonb_array_elements(projected->'claims') c where m.key in (c->>'debtorId',c->>'creditorId')),0))
  from jsonb_each(projected->'members') m where manager or m.key=me),'{}');
 return jsonb_build_object('net',net,'lines',lines);
end $$;

-- Source: schemas/functions/duty_private/calendar_language.sql
-- The caller's feed follows the language they use the app in; the URL stays the same.
CREATE OR REPLACE FUNCTION duty_private.calendar_language(p_language text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
 if not duty_private.is_member() then raise exception 'calendar-member-required' using errcode='42501'; end if;
 if p_language is null or p_language not in ('en','he') then raise exception 'invalid-calendar-language'; end if;
 update public.duty_calendar_feeds set language=p_language where member_id=duty_private.current_member_id();
end $$;

-- Source: schemas/functions/duty_private/calendar_reset.sql
-- Create or reset the caller's own calendar feed (decision 2026-11-06). Returns the new raw
-- token exactly once; only its hash is stored, so the previous URL stops working at once.
-- Personal, not team data: no workspace revision. 64 hex characters from two random UUIDs
-- (244 random bits, pg_strong_random).
CREATE OR REPLACE FUNCTION duty_private.calendar_reset(p_language text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare token text:=replace(gen_random_uuid()::text||gen_random_uuid()::text,'-',''); saved public.duty_calendar_feeds;
begin
 if not duty_private.is_member() then raise exception 'calendar-member-required' using errcode='42501'; end if;
 if p_language is null or p_language not in ('en','he') then raise exception 'invalid-calendar-language'; end if;
 insert into public.duty_calendar_feeds(member_id,token_hash,language,created_at)
 values(duty_private.current_member_id(),sha256(convert_to(token,'UTF8')),p_language,now())
 on conflict (member_id) do update set token_hash=excluded.token_hash,language=excluded.language,created_at=excluded.created_at
 returning * into saved;
 return jsonb_build_object('token',token,'createdAt',saved.created_at,'language',saved.language);
end $$;

-- Source: schemas/functions/duty_private/calendar_status.sql
-- Whether the caller has a calendar feed, and its language. Never returns the token or hash.
CREATE OR REPLACE FUNCTION duty_private.calendar_status() RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
 select case when duty_private.is_member() then (select jsonb_build_object('createdAt',created_at,'language',language)
  from public.duty_calendar_feeds where member_id=duty_private.current_member_id()) end
$$;

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
 insert into public.duty_publications(month,version,published_by) values(m.month,next_version,duty_private.current_member_id()) returning id into publication;
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

-- Source: schemas/functions/duty_private/save_schedule.sql
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
  insert into public.duty_publications(month,version,published_by) values(p_publish,next_version,duty_private.current_member_id()) returning id into publication;
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

-- Source: schemas/functions/duty_private/push_events.sql
-- Records one notification for one member, once (the dedupe key), only when they
-- can receive it: a signed-in, approved, active member with a registered device who
-- has not switched that kind off. Returns whether a new row was recorded.
CREATE OR REPLACE FUNCTION duty_private.push_enqueue(p_member uuid, p_kind text, p_key text, p_params jsonb, p_url text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare s public.duty_notification_settings; wanted boolean;
begin
 if p_member is null or not exists(select 1 from public.duty_members where id=p_member and auth_user_id is not null and status='approved' and active)
  or not exists(select 1 from public.duty_push_subscriptions where member_id=p_member) then return false; end if;
 select * into s from public.duty_notification_settings where member_id=p_member;
 wanted:=case
  when p_kind in ('deadline_3','deadline_1') then coalesce(s.deadlines,true)
  when p_kind in ('published','republished') then coalesce(s.published,true)
  when p_kind like 'swap\_%' then coalesce(s.swaps,true)
  when p_kind='edit' then coalesce(s.edits,true)
  when p_kind='remind_evening' then coalesce(s.evening,true)
  when p_kind='remind_morning' then coalesce(s.morning,true)
  when p_kind='member_waiting' then coalesce(s.members,true)
  else false end;
 if not wanted then return false; end if;
 insert into public.duty_push_notifications(member_id,kind,dedupe_key,params,url) values(p_member,p_kind,p_key,coalesce(p_params,'{}'::jsonb),p_url)
 on conflict(dedupe_key) do nothing;
 return found;
end $$;

-- Publishing a month tells everyone; a later change to a published month that is
-- not an approved swap (an admin's published-duty edit, or deleting the live
-- version) tells each member whose duty, cover or points changed. The member who
-- made the change is not told. A notification problem never blocks the change.
CREATE OR REPLACE FUNCTION duty_private.push_month_events() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare actor uuid:=duty_private.current_member_id(); today date:=(now() at time zone 'Asia/Jerusalem')::date; r record; v integer;
begin
 begin
  if old.status='draft' and new.status='published' then
   select p.version into v from public.duty_publications p where p.id=new.current_publication_id;
   for r in select id from public.duty_members where status='approved' and active and auth_user_id is not null and id is distinct from actor loop
    perform duty_private.push_enqueue(r.id,case when old.current_publication_id is null then 'published' else 'republished' end,
     'published:'||new.current_publication_id||':'||r.id,jsonb_build_object('month',new.month,'version',v),'/?tab=schedule&month='||new.month);
   end loop;
  -- A swap approved in this same transaction has its own notices (resolved_at is the
  -- transaction time); any other change of the live version (an admin's edit, deleting
  -- the live version) tells whoever's duty changed.
  elsif old.status='published' and new.status='published'
   and not exists(select 1 from public.duty_swap_requests s where s.result_publication_id=new.current_publication_id and s.status='approved' and s.resolved_at=now()) then
   for r in
    with o as (select day,end_day,primary_id,secondary_id,points from public.duty_assignments where publication_id=old.current_publication_id),
     n as (select day,end_day,primary_id,secondary_id,points from public.duty_assignments where publication_id=new.current_publication_id),
     d as (select coalesce(n.day,o.day) as day,o.primary_id as op,o.secondary_id as os,n.primary_id as np,n.secondary_id as ns,
       (o.points is distinct from n.points or o.end_day is distinct from n.end_day) as reshaped
      from o full join n on n.day=o.day where coalesce(n.day,o.day)>=today),
     affected as (
      select d.day,x.member from d cross join lateral (values (d.op),(d.np)) x(member) where d.op is distinct from d.np
      union select d.day,x.member from d cross join lateral (values (d.os),(d.ns)) x(member) where d.os is distinct from d.ns
      union select d.day,x.member from d cross join lateral (values (d.np),(d.ns)) x(member) where d.reshaped)
    select a.member,min(a.day) as first_day,count(distinct a.day) as days from affected a
    where a.member is not null and a.member is distinct from actor group by a.member
   loop
    perform duty_private.push_enqueue(r.member,'edit','edit:'||old.current_publication_id||':'||new.current_publication_id||':'||r.member,
     jsonb_build_object('month',new.month,'day',r.first_day,'count',r.days),'/?tab=schedule&month='||new.month);
   end loop;
  end if;
 exception when others then
  raise warning 'duty push (month %): %',new.month,sqlerrm;
 end;
 return null;
end $$;

-- Swap requests tell only the people involved: who must answer a new request, the
-- other parties when someone accepts, everyone involved when it is declined,
-- rejected or approved, and the admins when it waits for their approval. The
-- explanation text is never sent; only the two dates.
CREATE OR REPLACE FUNCTION duty_private.push_swap_events() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare actor uuid:=duty_private.current_member_id(); params jsonb; url text; who uuid; side text; answered uuid; round text;
begin
 begin
  params:=jsonb_build_object('month',new.month,'fromDay',new.from_day,'toDay',new.to_day,'request',new.id);
  -- Each round of a request gets its own keys: a new counterpart (this transaction's
  -- time) or a new acceptance (its timestamp), so a request asked again is told again.
  round:=to_char(now() at time zone 'UTC','YYYYMMDDHH24MISSUS');
  url:='/?tab=schedule&month='||new.month;
  if tg_op='INSERT' then
   if new.status='awaiting_engineer' then
    foreach who in array array[new.other_id,case when new.proposed_by is not null then new.requester_id end] loop
     if who is not null and who is distinct from actor then perform duty_private.push_enqueue(who,'swap_new','swap:'||new.id||':new:'||who,params,url); end if;
    end loop;
   end if;
  else
   -- The published duty changed hands while waiting: its new holder is asked, and the
   -- requester of an admin's proposal, who must accept again.
   if new.status='awaiting_engineer' and new.other_id is distinct from old.other_id then
    foreach who in array array[new.other_id,case when new.proposed_by is not null and new.requester_accepted_at is null then new.requester_id end] loop
     if who is not null and who is distinct from actor then perform duty_private.push_enqueue(who,'swap_new','swap:'||new.id||':new:'||round||':'||who,params,url); end if;
    end loop;
   end if;
   side:=case when new.accepted_by is not null and old.accepted_by is null then 'other'
    when new.requester_accepted_at is not null and old.requester_accepted_at is null then 'requester' end;
   if side is not null then
    answered:=case side when 'other' then new.other_id else new.requester_id end;
    foreach who in array array[new.requester_id,new.other_id,new.proposed_by] loop
     -- An admin asked to approve in the same step hears that instead.
     if who is not null and who is distinct from actor and who is distinct from answered
      and not (new.status='awaiting_admin' and old.status<>'awaiting_admin' and exists(select 1 from public.duty_members m join public.duty_roles r on r.code=m.role
       where m.id=who and r.can_manage and m.status='approved' and m.active)) then
      perform duty_private.push_enqueue(who,'swap_accepted','swap:'||new.id||':accepted-'||side||':'
       ||to_char(case side when 'other' then new.accepted_at else new.requester_accepted_at end at time zone 'UTC','YYYYMMDDHH24MISSUS')||':'||who,params,url);
     end if;
    end loop;
   end if;
   if new.status is distinct from old.status then
    if new.status='awaiting_admin' then
     for who in select m.id from public.duty_members m join public.duty_roles r on r.code=m.role
      where r.can_manage and m.status='approved' and m.active and m.id is distinct from actor loop
      perform duty_private.push_enqueue(who,'swap_awaiting_admin','swap:'||new.id||':admin:'||to_char(new.accepted_at at time zone 'UTC','YYYYMMDDHH24MISSUS')||':'||who,params,url);
     end loop;
    elsif new.status in ('declined','rejected','approved') then
     foreach who in array array[new.requester_id,new.other_id,new.proposed_by] loop
      if who is not null and who is distinct from actor then
       perform duty_private.push_enqueue(who,'swap_'||new.status,'swap:'||new.id||':'||new.status||':'||who,params,url);
      end if;
     end loop;
    end if;
   end if;
  end if;
 exception when others then
  raise warning 'duty push (swap %): %',new.id,sqlerrm;
 end;
 return null;
end $$;

-- A new sign-up waits for approval: every admin who wants to know is told.
CREATE OR REPLACE FUNCTION duty_private.push_member_events() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare who uuid;
begin
 begin
  for who in select m.id from public.duty_members m join public.duty_roles r on r.code=m.role
   where r.can_manage and m.status='approved' and m.active loop
   perform duty_private.push_enqueue(who,'member_waiting','member:'||new.id||':'||who,jsonb_build_object('name',left(new.name,80)),'/?tab=team');
  end loop;
 exception when others then
  raise warning 'duty push (member %): %',new.id,sqlerrm;
 end;
 return null;
end $$;

-- Source: schemas/functions/duty_private/push_settings.sql
-- The caller's own app language (decision 2026-11-06). Saved in the background when
-- the language changes; no workspace revision, so it never conflicts with an edit.
CREATE OR REPLACE FUNCTION duty_private.set_language(p_language text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
 if auth.uid() is null then raise exception 'Sign in first' using errcode='42501'; end if;
 if p_language is null or p_language not in ('en','he') then raise exception 'Choose English or Hebrew'; end if;
 update public.duty_members set language=p_language where auth_user_id=auth.uid() and language is distinct from p_language;
 -- The personal calendar feed follows the same language; its URL stays the same.
 update public.duty_calendar_feeds f set language=p_language from public.duty_members m
  where m.auth_user_id=auth.uid() and f.member_id=m.id and f.language<>p_language;
end $$;

-- The caller's own notification switches (defaults when never saved) and how many
-- devices are registered. Never another member's.
CREATE OR REPLACE FUNCTION duty_private.notification_settings() RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare s public.duty_notification_settings;
begin
 if not duty_private.is_member() then raise exception 'Member access required' using errcode='42501'; end if;
 select * into s from public.duty_notification_settings where member_id=duty_private.current_member_id();
 return jsonb_build_object('deadlines',coalesce(s.deadlines,true),'published',coalesce(s.published,true),'swaps',coalesce(s.swaps,true),
  'edits',coalesce(s.edits,true),'evening',coalesce(s.evening,true),'eveningTime',to_char(coalesce(s.evening_time,time '18:00'),'HH24:MI'),
  'morning',coalesce(s.morning,true),'morningTime',to_char(coalesce(s.morning_time,time '08:30'),'HH24:MI'),'members',coalesce(s.members,true),
  'devices',(select count(*) from public.duty_push_subscriptions where member_id=duty_private.current_member_id()));
end $$;

-- Replaces the caller's own switches. Every key is required with its exact type;
-- times are quarter hours (HH:00/15/30/45, the clock runs every 15 minutes) in
-- Asia/Jerusalem. No workspace revision: it is personal.
CREATE OR REPLACE FUNCTION duty_private.set_notification_settings(p_settings jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare k text;
begin
 if not duty_private.is_member() then raise exception 'Member access required' using errcode='42501'; end if;
 if jsonb_typeof(p_settings) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_settings) given(name)
  where given.name not in ('deadlines','published','swaps','edits','evening','eveningTime','morning','morningTime','members')) then
  raise exception 'Invalid notification settings';
 end if;
 foreach k in array array['deadlines','published','swaps','edits','evening','morning','members'] loop
  if jsonb_typeof(p_settings->k) is distinct from 'boolean' then raise exception 'Invalid notification settings'; end if;
 end loop;
 if coalesce(p_settings->>'eveningTime','') !~ '^([01][0-9]|2[0-3]):(00|15|30|45)$' or coalesce(p_settings->>'morningTime','') !~ '^([01][0-9]|2[0-3]):(00|15|30|45)$' then
  raise exception 'Invalid notification time';
 end if;
 insert into public.duty_notification_settings(member_id,deadlines,published,swaps,edits,evening,evening_time,morning,morning_time,members,updated_at)
 values(duty_private.current_member_id(),(p_settings->>'deadlines')::boolean,(p_settings->>'published')::boolean,(p_settings->>'swaps')::boolean,(p_settings->>'edits')::boolean,
  (p_settings->>'evening')::boolean,(p_settings->>'eveningTime')::time,(p_settings->>'morning')::boolean,(p_settings->>'morningTime')::time,(p_settings->>'members')::boolean,now())
 on conflict(member_id) do update set deadlines=excluded.deadlines,published=excluded.published,swaps=excluded.swaps,edits=excluded.edits,
  evening=excluded.evening,evening_time=excluded.evening_time,morning=excluded.morning,morning_time=excluded.morning_time,members=excluded.members,updated_at=now();
 return duty_private.notification_settings();
end $$;

-- Registers this device for the caller. Only known browser push services are
-- accepted (the sender never contacts any other host); an endpoint moves to whoever
-- registered it last, and each member keeps their ten most recent devices.
CREATE OR REPLACE FUNCTION duty_private.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare host text:=lower(substring(coalesce(p_endpoint,'') from '^https://([^/?#@:]+)(?::443)?/'));
begin
 if not duty_private.is_member() then raise exception 'Member access required' using errcode='42501'; end if;
 if host is null or length(p_endpoint)>1000 or host !~ '^(fcm\.googleapis\.com|([a-z0-9-]+\.)*push\.apple\.com|([a-z0-9-]+\.)*push\.services\.mozilla\.com|[a-z0-9-]+\.notify\.windows\.com)$' then
  raise exception 'push-service-unsupported';
 end if;
 if coalesce(p_p256dh,'') !~ '^[A-Za-z0-9_-]{80,100}$' or coalesce(p_auth,'') !~ '^[A-Za-z0-9_-]{16,44}$' then raise exception 'push-keys-invalid'; end if;
 insert into public.duty_push_subscriptions(member_id,endpoint,p256dh,auth) values(duty_private.current_member_id(),p_endpoint,p_p256dh,p_auth)
 on conflict(endpoint) do update set member_id=excluded.member_id,p256dh=excluded.p256dh,auth=excluded.auth,last_seen_at=now();
 delete from public.duty_push_subscriptions where id in (select id from public.duty_push_subscriptions where member_id=duty_private.current_member_id() order by last_seen_at desc,id offset 10);
end $$;

-- Removes one of the caller's own devices (turning notifications off, or signing
-- out on this device). Any signed-in caller, so sign-out never fails here.
CREATE OR REPLACE FUNCTION duty_private.delete_push_subscription(p_endpoint text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
 if auth.uid() is null then raise exception 'Sign in first' using errcode='42501'; end if;
 delete from public.duty_push_subscriptions where endpoint=p_endpoint and member_id=duty_private.current_member_id();
end $$;

-- Source: schemas/functions/duty_private/rename_self.sql
CREATE OR REPLACE FUNCTION duty_private.rename_self(p_name text, p_revision bigint) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
 perform duty_private.check_revision(p_revision);
 if length(trim(coalesce(p_name,''))) not between 1 and 80 then raise exception 'Use a name between 1 and 80 characters'; end if;
 update public.duty_members set name=trim(p_name) where id=duty_private.current_member_id();
 update public.duty_workspace set revision=revision+1 where id;
end $$;

-- Source: schemas/functions/duty_private/set_color.sql
-- The caller's own calendar colour (decision 2026-11-06): any #rrggbb, chosen from the app's
-- palette in Settings. Everyone sees it, so it takes the workspace revision like a rename.
CREATE OR REPLACE FUNCTION duty_private.set_color(p_color text, p_revision bigint) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
 perform duty_private.check_revision(p_revision);
 if p_color is null or p_color !~ '^#[0-9a-fA-F]{6}$' then raise exception 'Choose a colour from the palette'; end if;
 update public.duty_members set color=lower(p_color) where id=duty_private.current_member_id();
 update public.duty_workspace set revision=revision+1 where id;
end $$;

-- Source: schemas/functions/duty_private/set_constraints.sql
CREATE OR REPLACE FUNCTION duty_private.set_constraints(p_member uuid, p_days date[], p_kind text, p_note text, p_revision bigint) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare d date; m text; manager boolean;
begin
 perform duty_private.check_revision(p_revision);
 manager:=duty_private.is_manager();
 if (not manager and p_member is distinct from duty_private.current_member_id()) or not exists(select 1 from public.duty_members where id=p_member and status='approved') then raise exception 'Not allowed' using errcode='42501'; end if;
 if p_kind not in ('no','prefer','clear') or p_kind is null or coalesce(cardinality(p_days),0) not between 1 and 62 or length(coalesce(p_note,''))>300 then raise exception 'Invalid constraints'; end if;
 foreach d in array p_days loop
  if d is null then raise exception 'Invalid date'; end if;
  m:=to_char(d,'YYYY-MM');
  insert into public.duty_months(month,deadline) values(m,date_trunc('month',d)::date-7) on conflict do nothing;
  if not manager and exists(select 1 from public.duty_months where month=m and (status='published' or deadline < (now() at time zone 'Asia/Jerusalem')::date)) then raise exception 'Constraints are closed for this month' using errcode='42501'; end if;
  if p_kind='clear' then delete from public.duty_constraints where member_id=p_member and day=d;
  else insert into public.duty_constraints(member_id,day,kind,note) values(p_member,d,p_kind,trim(coalesce(p_note,''))) on conflict(member_id,day) do update set kind=excluded.kind,note=excluded.note; end if;
  -- Availability is independent of the working schedule. In particular, an
  -- admin constraint edit must not create an empty draft of a published month.
 end loop;
 update public.duty_workspace set revision=revision+1 where id;
end $$;

-- Source: schemas/functions/duty_private/swap_availability.sql
CREATE OR REPLACE FUNCTION duty_private.swap_availability(p_from uuid, p_to uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare a public.duty_assignments; b public.duty_assignments; admin boolean:=duty_private.is_manager(); me uuid:=duty_private.current_member_id();
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
  if me is distinct from a.primary_id and me is distinct from b.primary_id then
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

-- Source: schemas/functions/duty_private/request_swap.sql
CREATE OR REPLACE FUNCTION duty_private.request_swap(p_from uuid, p_to uuid, p_explanation text, p_revision bigint) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare a public.duty_assignments; b public.duty_assignments; t public.duty_assignments; m text; me uuid:=duty_private.current_member_id();
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

-- Source: schemas/functions/duty_private/resolve_swap.sql
CREATE OR REPLACE FUNCTION duty_private.resolve_swap(p_request uuid, p_action text, p_revision bigint, p_override_reason text DEFAULT ''::text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare r public.duty_swap_requests; a public.duty_assignments; b public.duty_assignments;
 current_publication uuid; publication uuid; next_version integer; reason text:=trim(coalesce(p_override_reason,'')); side text; next_status text;
 party boolean:=false; me uuid:=duty_private.current_member_id();
begin
 perform duty_private.check_revision(p_revision);
 if not duty_private.is_member() then raise exception 'Your membership is not approved' using errcode='42501'; end if;
 select * into r from public.duty_swap_requests where id=p_request for update;
 if r.id is null then raise exception 'Request not found' using errcode='42501'; end if;
 if p_action='cancel' then
  if coalesce(r.proposed_by,r.requester_id) is distinct from me then raise exception 'Only the person who started the request can cancel' using errcode='42501'; end if;
 elsif p_action in ('accept','decline') then
  -- Each party answers only for their own side. A requester who asked for the
  -- swap consented by sending it; one an admin proposed it for must accept too.
  -- Temporary members have no account: an admin answers for them, and only for them.
  party:=coalesce(r.other_id=me or (r.requester_id=me and r.proposed_by is not null),false);
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
  if r.other_id=me and r.accepted_by is null then side:='other';
  elsif r.requester_id=me and r.proposed_by is not null and r.requester_accepted_at is null then side:='requester';
  elsif duty_private.is_manager() and r.proposed_by is not null and r.requester_accepted_at is null
   and exists(select 1 from public.duty_members where id=r.requester_id and is_temporary) then side:='requester';
  elsif duty_private.is_manager() and r.accepted_by is null
   and exists(select 1 from public.duty_members where id=r.other_id and is_temporary) then side:='other';
  elsif r.other_id=me or (r.requester_id=me and r.proposed_by is not null) then
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
  insert into public.duty_publications(month,version,published_by) values(r.month,next_version,me) returning id into publication;
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
  resolved_by=case when p_action='accept' then null else me end,
  result_publication_id=publication,override_reason=case when p_action='approve' then reason else '' end where id=r.id;
 if publication is not null then
  update public.duty_months set current_publication_id=publication where month=r.month;
 end if;
 update public.duty_workspace set revision=revision+1 where id;
 return (select status from public.duty_swap_requests where id=r.id);
end $$;

-- Source: schemas/functions/duty_private/link_temporary_member.sql
-- Link a pending sign-up to a temporary member (decision 2026-11-07). The two become one
-- person: the temporary member's row keeps its id, so every duty, publication, ledger lot,
-- allocation, availability note and swap stays as it is, and it gains the sign-in. It keeps
-- its name, colour, No-weekends setting, seniority and active state, and becomes a normal
-- engineer. The sign-up's email and language move to it, with any personal settings it
-- already saved, and the pending row is removed. Open swap sides waiting on the temporary
-- member now wait on that person (resolve_swap stops letting admins answer once the row
-- is no longer temporary). Admins only; cannot be undone.
CREATE OR REPLACE FUNCTION duty_private.link_temporary_member(p_pending uuid, p_temporary uuid, p_revision bigint) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare s public.duty_members; t public.duty_members;
begin
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 perform duty_private.check_revision(p_revision);
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 select * into s from public.duty_members where id=p_pending for update;
 select * into t from public.duty_members where id=p_temporary for update;
 if s.id is null or s.is_temporary or s.status<>'pending' or s.role<>'engineer' or s.linked_user_id is not null or s.auth_user_id is distinct from s.id then
  raise exception 'This request is no longer pending';
 end if;
 if t.id is null or not t.is_temporary then raise exception 'Temporary member required'; end if;
 -- The ledger has no foreign keys: a debt an admin recorded for the sign-up would stay on a
 -- deleted id. Refuse instead (it is normally empty for a pending sign-up).
 if exists(select 1 from jsonb_each(duty_private.compensation_state()->'lots') l where s.id::text in (l.value->>'debtorId',l.value->>'creditorId')) then
  raise exception 'link-has-balance';
 end if;
 -- A pending sign-up has no member access, so these are normally empty; carry them anyway.
 update public.duty_push_subscriptions set member_id=t.id where member_id=s.id;
 update public.duty_notification_settings set member_id=t.id where member_id=s.id
  and not exists(select 1 from public.duty_notification_settings where member_id=t.id);
 update public.duty_calendar_feeds set member_id=t.id where member_id=s.id
  and not exists(select 1 from public.duty_calendar_feeds where member_id=t.id);
 -- Fails closed (foreign keys) if the sign-up somehow owns duties, availability or swaps.
 delete from public.duty_members where id=s.id;
 update public.duty_members set is_temporary=false,linked_user_id=s.id,email=s.email,language=coalesce(s.language,t.language)
  where id=t.id;
 update public.duty_workspace set revision=revision+1 where id;
end $$;

-- Source: schemas/functions/public/duty_link_temporary_member.sql
CREATE OR REPLACE FUNCTION public.duty_link_temporary_member(p_pending uuid, p_temporary uuid, p_revision bigint) RETURNS void
    LANGUAGE sql
    SET search_path TO ''
    AS $$select duty_private.link_temporary_member(p_pending,p_temporary,p_revision)$$;

-- Source: schemas/policies/duty_members.sql
DROP POLICY members_read ON public.duty_members;
CREATE POLICY members_read ON public.duty_members FOR SELECT TO authenticated USING (((auth_user_id = ( SELECT auth.uid() AS uid)) OR ( SELECT duty_private.is_manager() AS is_manager) OR ((status = 'approved'::text) AND ( SELECT duty_private.is_member() AS is_member))));

-- Source: schemas/policies/duty_swap_requests.sql
DROP POLICY swaps_read ON public.duty_swap_requests;
CREATE POLICY swaps_read ON public.duty_swap_requests FOR SELECT TO authenticated USING ((( SELECT duty_private.is_member() AS is_member) AND ((requester_id = ( SELECT duty_private.current_member_id() AS current_member_id)) OR (proposed_by = ( SELECT duty_private.current_member_id() AS current_member_id)) OR ((other_id = ( SELECT duty_private.current_member_id() AS current_member_id)) AND (status = 'awaiting_engineer'::text)) OR (( SELECT duty_private.is_manager() AS is_manager) AND (status = 'awaiting_admin'::text)) OR (( SELECT duty_private.is_manager() AS is_manager) AND (status = 'awaiting_engineer'::text) AND (EXISTS ( SELECT 1 FROM public.duty_members m WHERE (m.is_temporary AND (((m.id = duty_swap_requests.other_id) AND (duty_swap_requests.accepted_by IS NULL)) OR ((m.id = duty_swap_requests.requester_id) AND (duty_swap_requests.proposed_by IS NOT NULL) AND (duty_swap_requests.requester_accepted_at IS NULL))))))))));

-- Source: schemas/policies/duty_constraints.sql
DROP POLICY constraints_read ON public.duty_constraints;
CREATE POLICY constraints_read ON public.duty_constraints FOR SELECT TO authenticated USING ((( SELECT duty_private.is_manager() AS is_manager) OR ((member_id = ( SELECT duty_private.current_member_id() AS current_member_id)) AND ( SELECT duty_private.is_member() AS is_member))));

-- Source: schemas/policies/duty_calendar_feeds.sql
DROP POLICY calendar_feeds_read ON public.duty_calendar_feeds;
-- A member reads only their own feed row (never anyone else's). The raw token is never stored.
CREATE POLICY calendar_feeds_read ON public.duty_calendar_feeds FOR SELECT TO authenticated USING ((member_id = ( SELECT duty_private.current_member_id() AS current_member_id)));

-- Source: schemas/policies/duty_notifications.sql
DROP POLICY notification_settings_read ON public.duty_notification_settings;
DROP POLICY push_subscriptions_read ON public.duty_push_subscriptions;
DROP POLICY push_notifications_read ON public.duty_push_notifications;
DROP POLICY push_deliveries_read ON public.duty_push_deliveries;
-- Own rows only, for every member including admins.
CREATE POLICY notification_settings_read ON public.duty_notification_settings FOR SELECT TO authenticated USING ((member_id = ( SELECT duty_private.current_member_id() AS current_member_id)));
CREATE POLICY push_subscriptions_read ON public.duty_push_subscriptions FOR SELECT TO authenticated USING ((member_id = ( SELECT duty_private.current_member_id() AS current_member_id)));
CREATE POLICY push_notifications_read ON public.duty_push_notifications FOR SELECT TO authenticated USING ((member_id = ( SELECT duty_private.current_member_id() AS current_member_id)));
CREATE POLICY push_deliveries_read ON public.duty_push_deliveries FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.duty_push_notifications n
  WHERE ((n.id = duty_push_deliveries.notification_id) AND (n.member_id = ( SELECT duty_private.current_member_id() AS current_member_id))))));

-- Source: schemas/grants/functions.sql
REVOKE ALL ON FUNCTION duty_private.current_member_id() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION duty_private.current_member_id() TO authenticated;
REVOKE ALL ON FUNCTION duty_private.link_temporary_member(uuid, uuid, bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION duty_private.link_temporary_member(uuid, uuid, bigint) TO authenticated;
REVOKE ALL ON FUNCTION public.duty_link_temporary_member(uuid, uuid, bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.duty_link_temporary_member(uuid, uuid, bigint) TO authenticated;

NOTIFY pgrst, 'reload schema';
