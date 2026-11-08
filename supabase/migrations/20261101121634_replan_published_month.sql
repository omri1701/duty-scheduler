-- Re-planning a published month (decision 2026-11-01). Reopening a published month to
-- change its plan looped on "Team data changed": the plan was checked against a ledger
-- that already held that month's own entries, and publishing a changed plan over a
-- published month was refused ("Review published transfer lineage").
--
-- Now a new plan for a published month starts from the ledger without that month's own
-- entries: duty_private.compensation_replan reverses every lot the month's publications
-- booked with audited corrections and deletes the publication, cancelling its pending
-- repayments. generation_context, confirm_allocation and save_generation plan and check
-- against that state; compensation_publication books it for real, in the same
-- transaction, before publishing the new plan as the month's first version. Refused
-- while another month's repayment uses those lots (review-replan-later:<month>), once
-- the month has started (review-replan-started) or after a hand settlement
-- (review-replan-settled). Unchanged copies keep their published provenance.
-- lib/compensation/replan.ts builds the same events. Owners, search_path and grants of
-- the replaced functions are kept.

-- Source: schemas/functions/duty_private/compensation_replan_step.sql
-- One re-plan event: appended for real, or applied to the state only.
CREATE FUNCTION duty_private.compensation_replan_step(s jsonb, op jsonb, key text, instant bigint, actor text, reason text, commit boolean) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
begin
 if commit then return duty_private.compensation_append(s,op,key,instant,actor,reason); end if;
 return duty_private.compensation_apply(s,jsonb_build_object('sequence',coalesce((s->'events'->-1->>'sequence')::bigint,0)+1,'sourceKey',key,'at',instant,'actor',actor,'operation',op)
  ||case when reason is null then '{}'::jsonb else jsonb_build_object('reason',reason) end);
end $$;

-- Source: schemas/functions/duty_private/compensation_replan.sql
-- The ledger a new plan for a published month starts from (decision 2026-11-01): every
-- lot the month's publications booked is reversed by an audited correction, then the
-- publication is deleted, which cancels its pending repayments. The plan, its checks and
-- its publication see the month as if it had never been booked; nothing is rewritten.
-- Refused when a repayment of another month already uses one of those lots
-- (review-replan-later:<month>), when part of one was settled by hand
-- (review-replan-settled), or once the month has started (review-replan-started).
-- `commit` appends the events for real, inside the publishing transaction.
-- lib/compensation/replan.ts builds the same events.
CREATE FUNCTION duty_private.compensation_replan(s jsonb, p_month text, instant bigint, commit boolean DEFAULT false) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
#variable_conflict use_column
declare pub jsonb:=s->'publications'->p_month; keys text[]; lots text[]; lot jsonb; c jsonb; other text; op jsonb; key text;
 actor text:=coalesce(auth.uid()::text,'system'); reason text:='Re-planned '||p_month;
begin
 if pub is null then return s; end if;
 if exists(select 1 from jsonb_each(duty_private.compensation_atoms(pub)) a where (a.value->>'endInstantMs')::bigint<=instant) then raise exception 'review-replan-started'; end if;
 select coalesce(array_agg(x->>'sourceKey'),'{}') into keys from jsonb_array_elements(s->'events') x
  where x->'operation'->>'kind'='publication' and x->'operation'->>'month'=p_month;
 select coalesce(array_agg(l.key order by l.key COLLATE "C"),'{}') into lots from jsonb_each(s->'lots') l where l.value->>'sourceKey'=any(keys);
 for c in select value from jsonb_each(s->'contributions') where value->>'status'<>'cancelled'
  and exists(select 1 from jsonb_array_elements(value->'claim'->'path') p where p->>'lotId'=any(lots)) loop
  if exists(select 1 from jsonb_array_elements(pub->'reservations') r where r->>'id'=c->>'id') then
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
  if (lot->>'correctedUnits')::bigint=0 then continue; end if;
  op:=jsonb_build_object('kind','correct','lotId',key,'deltaUnits',-(lot->>'correctedUnits')::bigint);
  s:=duty_private.compensation_replan_step(s,op,'replan/'||(pub->>'id')||'/'||key,instant,actor,reason,commit);
 end loop;
 op:=jsonb_build_object('kind','publication','month',p_month,'beforeId',pub->'id','after',null,'mode','delete');
 return duty_private.compensation_replan_step(s,op,'replan/'||(pub->>'id')||'/delete',instant,actor,null,commit);
end $$;


REVOKE ALL ON FUNCTION duty_private.compensation_replan(jsonb, text, bigint, boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION duty_private.compensation_replan_step(jsonb, jsonb, text, bigint, text, text, boolean) FROM PUBLIC, anon, authenticated, service_role;

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
 if s->'publications' ? p_month then
  begin planned:=duty_private.compensation_replan(s,p_month,greatest(instant,coalesce((s->'events'->-1->>'at')::bigint,0)));
  exception when raise_exception then if SQLERRM not like 'review-replan-%' then raise; end if; blocked:=SQLERRM;
  end;
 end if;
 projected:=duty_private.compensation_reconcile(planned,greatest(instant,opening,coalesce((planned->'events'->-1->>'at')::bigint,0)),false);
 return jsonb_build_object('revision',(select revision from public.duty_workspace where id),'actualAtMs',instant,'coverageStartMs',opening,
  'generationAllowed',instant<opening,'facts',facts,'actual',duty_private.compensation_view(planned),'projected',duty_private.compensation_view(projected),
  'accountingFingerprint',md5((s->'events')::text),'fingerprint',md5(facts::text||(s->'events')::text))
  ||case when s->'publications' ? p_month then jsonb_build_object('replanBlocked',blocked) else '{}'::jsonb end;
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
  -- A new plan for a published month is checked against the ledger without that month's
  -- own entries, as its publication will book it (decision 2026-11-01).
  projected:=duty_private.compensation_replan(projected,p_month,greatest((ctx->>'actualAtMs')::bigint,(ctx->>'coverageStartMs')::bigint));
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
  if old_meta.month is not null and old_meta.calendar_fingerprint=md5((select jsonb_agg(d-array['primary','secondary'] order by d->>'id')::text from jsonb_array_elements(facts->'duties') d))
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
  s:=duty_private.compensation_replan(s,p_month,(ctx->>'coverageStartMs')::bigint);
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
 -- month's repayment uses those lots (review-replan-later:<month>) or once it started.
 if not deleting and publication is not null and before_pub is not null and allocation.month is not null and allocation.source_publication_id is null then
  if allocation.accounting_fingerprint<>ledger then raise exception 'Compensation changed. Refresh and review.' using errcode='40001'; end if;
  s:=duty_private.compensation_replan(s,month,instant,true); before_pub:=null;
 end if;
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
  if allocation.month is not null then
   if metadata is not null then raise exception 'Allocation accounting is server-owned'; end if;
   if allocation.source_publication_id is null then
    if allocation.accounting_fingerprint<>ledger then raise exception 'Compensation changed. Refresh and review.' using errcode='40001'; end if;
    if before_pub is not null and allocation.allocation->'transfers'<>'[]' then raise exception 'Review published transfer lineage before changing allocation'; end if;
    facts:=duty_private.generation_facts(month);
    metadata:=duty_private.allocation_bind(facts,allocation.allocation,s,allocation.allocation_id,after_pub,instant);
   elsif allocation.origin<>'swap' then
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
