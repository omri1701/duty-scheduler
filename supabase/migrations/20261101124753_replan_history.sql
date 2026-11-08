-- Re-planning across a month's history (decision 2026-11-01, follow-up to
-- 20261101121634_replan_published_month), found by the lifecycle audit:
-- * Deleting a month's only version left its own debts live; publishing a new plan then
--   booked on top of them. A new plan now reverses the month's live lots even when the
--   month has no current publication, so they are never counted twice.
-- * Re-plan event keys carry the ledger position, so a month can be re-planned again
--   from the same version without a source-key retry silently skipping corrections.
-- * A version from before a re-plan can't become current again (restore, deleting the
--   current version, or publishing a copy of it): its ledger entries were reversed. The
--   month is re-planned instead, which reaches any plan. duty_private.compensation_replanned
--   decides it; the refusal names the month.
-- * A re-plan is refused, naming the month, when reversing the lots would change a debt
--   another month's pending repayment is reserved on (it would be held and never settle).
-- Owners, search_path and grants of the replaced functions are kept.

-- Source: schemas/functions/duty_private/compensation_replanned.sql
-- Whether a month was re-planned after a version of it was last published (decision
-- 2026-11-01): that version's ledger entries were reversed, so it can't become current
-- again by restoring or deleting versions; the month is re-planned instead.
CREATE FUNCTION duty_private.compensation_replanned(s jsonb, p_month text, version uuid) RETURNS boolean
 LANGUAGE sql STABLE SET search_path TO '' AS $$
 select exists(select 1 from jsonb_array_elements(s->'events') r
  where starts_with(r->>'sourceKey','replan/')
   and (r->>'sequence')::bigint>coalesce((select max((x->>'sequence')::bigint) from jsonb_array_elements(s->'events') x
    where x->'operation'->>'kind'='publication' and x->'operation'->'after'->>'id'=version::text),0)
   and ((r->'operation'->>'kind'='publication' and r->'operation'->>'month'=p_month)
    or (r->'operation'->>'kind'='correct' and s->'lots'->(r->'operation'->>'lotId')->>'sourceKey' in (select x->>'sourceKey'
     from jsonb_array_elements(s->'events') x where x->'operation'->>'kind'='publication' and x->'operation'->>'month'=p_month))))
$$;

REVOKE ALL ON FUNCTION duty_private.compensation_replanned(jsonb, text, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- Source: schemas/functions/duty_private/compensation_replan.sql
-- The ledger a new plan for a month starts from (decision 2026-11-01): every live lot the
-- month's publication events booked is reversed by an audited correction, then a current
-- publication is deleted, which cancels its pending repayments. The plan, its checks and
-- its publication see the month as if it had never been booked; nothing is rewritten.
-- A month whose only version was deleted still has live lots: a new plan reverses them
-- too, so they are never counted twice. Keys carry the ledger position, so the month can
-- be re-planned again later. Refused when a repayment of another month already uses one
-- of those lots, or would be held because a debt it repays nets differently afterwards
-- (review-replan-later:<month>), when part of one was settled by hand
-- (review-replan-settled), or once the published month has started (review-replan-started).
-- `commit` appends the events for real, inside the publishing transaction.
-- lib/compensation/replan.ts builds the same events.
CREATE OR REPLACE FUNCTION duty_private.compensation_replan(s jsonb, p_month text, instant bigint, commit boolean DEFAULT false) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
#variable_conflict use_column
declare original jsonb:=s; pub jsonb:=s->'publications'->p_month; keys text[]; lots text[]; lot jsonb; c jsonb; other text; op jsonb; key text;
 actor text:=coalesce(auth.uid()::text,'system'); reason text:='Re-planned '||p_month;
 prefix text:='replan/'||coalesce(s->'publications'->p_month->>'id','none')||'/'||coalesce((s->'events'->-1->>'sequence')::bigint,0)||'/';
begin
 if pub is not null and exists(select 1 from jsonb_each(duty_private.compensation_atoms(pub)) a where (a.value->>'endInstantMs')::bigint<=instant) then raise exception 'review-replan-started'; end if;
 select coalesce(array_agg(x->>'sourceKey'),'{}') into keys from jsonb_array_elements(s->'events') x
  where x->'operation'->>'kind'='publication' and x->'operation'->>'month'=p_month;
 select coalesce(array_agg(l.key order by l.key COLLATE "C"),'{}') into lots from jsonb_each(s->'lots') l
  where l.value->>'sourceKey'=any(keys) and (l.value->>'correctedUnits')::bigint>0;
 for c in select value from jsonb_each(s->'contributions') where value->>'status'<>'cancelled'
  and exists(select 1 from jsonb_array_elements(value->'claim'->'path') p where p->>'lotId'=any(lots)) loop
  if pub is not null and exists(select 1 from jsonb_array_elements(pub->'reservations') r where r->>'id'=c->>'id') then
   if c->>'status'='settled' then raise exception 'review-replan-started'; end if;
   continue;
  end if;
  -- The earliest other month whose repayment uses this month's points.
  other:=least(other,coalesce((select min(m.key COLLATE "C") from jsonb_each(s->'publications') m
   where exists(select 1 from jsonb_array_elements(m.value->'reservations') r where r->>'id'=c->>'id')),'unknown'));
 end loop;
 if other is not null then raise exception 'review-replan-later:%',other; end if;
 foreach key in array lots loop
  lot:=s->'lots'->key;
  if (lot->>'remaining')::bigint<(lot->>'units')::bigint then raise exception 'review-replan-settled'; end if;
  op:=jsonb_build_object('kind','correct','lotId',key,'deltaUnits',-(lot->>'correctedUnits')::bigint);
  s:=duty_private.compensation_replan_step(s,op,prefix||key,instant,actor,reason,commit);
 end loop;
 if pub is not null then
  op:=jsonb_build_object('kind','publication','month',p_month,'beforeId',pub->'id','after',null,'mode','delete');
  s:=duty_private.compensation_replan_step(s,op,prefix||'delete',instant,actor,null,commit);
 end if;
 -- Reversing the lots changes how debts net: another month's pending repayment on a debt
 -- that changed would be held and never settle. That month is changed first.
 select min(coalesce((select min(m.key COLLATE "C") from jsonb_each(original->'publications') m where m.key<>p_month
   and exists(select 1 from jsonb_array_elements(m.value->'reservations') r where r->>'id'=held.key)),'unknown') COLLATE "C") into other
  from jsonb_each(original->'contributions') held where held.value->>'status'='pending'
   and s->'contributions'->held.key->>'status'='held' and s->'contributions'->held.key->>'holdReason'='claim-changed';
 if other is not null then raise exception 'review-replan-later:%',other; end if;
 return s;
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
 -- A version from before a re-plan can't come back: its ledger entries were reversed (decision 2026-11-01).
 if duty_private.compensation_replanned(duty_private.compensation_state(),v.month,v.id) then raise exception '% was re-planned after this version, so its points can''t come back. Reopen the month and change its plan instead.',to_char(to_date(v.month||'-01','YYYY-MM-DD'),'FMMonth YYYY'); end if;
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
 -- Deleting the current version can't bring back one from before a re-plan (decision 2026-11-01).
 if replacement is not null and exists(select 1 from public.duty_months where current_publication_id=v.id)
  and duty_private.compensation_replanned(duty_private.compensation_state(),v.month,replacement) then raise exception '% was re-planned after this version, so its points can''t come back. Reopen the month and change its plan instead.',to_char(to_date(v.month||'-01','YYYY-MM-DD'),'FMMonth YYYY'); end if;
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

-- Source: schemas/functions/duty_private/compensation_publication.sql
CREATE OR REPLACE FUNCTION duty_private.compensation_publication(month text, publication uuid, metadata jsonb DEFAULT NULL, deleting boolean DEFAULT false) RETURNS void
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
  if allocation.accounting_fingerprint<>ledger then raise exception 'Compensation changed. Refresh and review.' using errcode='40001'; end if;
  s:=duty_private.compensation_replan(s,month,instant,true); before_pub:=null;
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
    if allocation.accounting_fingerprint<>ledger then raise exception 'Compensation changed. Refresh and review.' using errcode='40001'; end if;
    if before_pub is not null and allocation.allocation->'transfers'<>'[]' then raise exception 'Review published transfer lineage before changing allocation'; end if;
    facts:=duty_private.generation_facts(month);
    metadata:=duty_private.allocation_bind(facts,allocation.allocation,s,allocation.allocation_id,after_pub,instant);
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
 end if;
 op:=jsonb_build_object('kind','publication','month',month,'beforeId',before_pub->'id','after',after_pub);
 -- Unknown pre-cutover versions preserve completed facts below the ordinary
 -- transition rules. Known deletion uses the core's terminal handling.
 if deleting and (after_pub is null or known is not null) and before_pub is not null then op:=op||'{"mode":"delete"}'; end if;
 perform duty_private.compensation_append(s,op,'publication/'||coalesce(publication::text,'none')||'/'||(coalesce((s->'events'->-1->>'sequence')::bigint,0)+1),instant,coalesce(auth.uid()::text,'system'));
end $$;

-- Source: schemas/functions/duty_private/generation_context.sql
-- Also used inside checked writes, after taking the shared revision lock.
CREATE OR REPLACE FUNCTION duty_private.generation_context(p_month text, p_revision bigint) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare s jsonb; before_count integer; instant bigint; opening bigint; facts jsonb; projected jsonb; planned jsonb; blocked text;
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
 -- A published month is planned from the ledger without its own entries (decision
 -- 2026-11-01): its booked lots reversed and its publication deleted, as publishing a new
 -- plan will do. `replanBlocked` names why that is impossible; the plan then shows the ledger.
 planned:=s;
 if exists(select 1 from jsonb_array_elements(s->'events') x where x->'operation'->>'kind'='publication' and x->'operation'->>'month'=p_month) then
  begin planned:=duty_private.compensation_replan(s,p_month,greatest(instant,coalesce((s->'events'->-1->>'at')::bigint,0)));
  exception when raise_exception then if SQLERRM not like 'review-replan-%' then raise; end if; blocked:=SQLERRM;
  end;
 end if;
 projected:=duty_private.compensation_reconcile(planned,greatest(instant,opening,coalesce((planned->'events'->-1->>'at')::bigint,0)),false);
 return jsonb_build_object('revision',(select revision from public.duty_workspace where id),'actualAtMs',instant,'coverageStartMs',opening,
  'generationAllowed',instant<opening,'facts',facts,'actual',duty_private.compensation_view(planned),'projected',duty_private.compensation_view(projected),
  'accountingFingerprint',md5((s->'events')::text),'fingerprint',md5(facts::text||(s->'events')::text))
  ||case when planned is distinct from s or blocked is not null then jsonb_build_object('replanBlocked',blocked) else '{}'::jsonb end;
end $$;
