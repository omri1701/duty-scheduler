-- Deleting a month's only published version removes what it booked (decision 2026-11-07).
-- Before, its lots (uneven credit and Temporary transfers) stayed live with no version left,
-- so Team balances showed debts for a schedule that no longer exists. Now the deletion
-- reverses them with the same audited corrections as a re-plan (its own audit reason) and
-- cancels the version's pending repayments; the kept draft copy is a plan of its own, so
-- publishing it books it again. When worked or used points make that impossible (started,
-- repaid by a later month, settled by hand) the lots stay live as before.
-- No table, data or grant to a role changes.

-- Source: schemas/functions/duty_private/compensation_replan.sql
DROP FUNCTION duty_private.compensation_replan(jsonb, text, bigint, boolean);
-- The ledger a new plan for a month starts from (decision 2026-11-01): every live lot the
-- month's publication events booked is reversed by an audited correction, then a current
-- publication is deleted, which cancels its pending repayments. The plan, its checks and
-- its publication see the month as if it had never been booked; nothing is rewritten.
-- A month whose only version was deleted still has live lots: a new plan reverses them
-- too, so they are never counted twice. Keys carry the ledger position, so the month can
-- be re-planned again later. Refused when a repayment of another month already uses one
-- of those lots, or would be held because a debt it repays nets differently afterwards
-- (review-replan-later:<month>), when part of one was settled by hand
-- (review-replan-settled), or once the published month has started (review-replan-started), its
-- last version counting when the only one was deleted: worked days keep their debts.
-- `commit` appends the events for real, inside the publishing transaction. Deleting a month's
-- only version reverses the same lots, with its own audit reason (decision 2026-11-07).
-- lib/compensation/replan.ts builds the same events.
CREATE FUNCTION duty_private.compensation_replan(s jsonb, p_month text, instant bigint, commit boolean DEFAULT false, p_reason text DEFAULT NULL) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
#variable_conflict use_column
declare original jsonb:=s; pub jsonb:=s->'publications'->p_month; keys text[]; lots text[]; lot jsonb; c jsonb; other text; op jsonb; key text;
 actor text:=coalesce(auth.uid()::text,'system'); reason text:=coalesce(p_reason,'Re-planned '||p_month);
 last jsonb:=coalesce(s->'publications'->p_month,(select x->'operation'->'after' from jsonb_array_elements(s->'events') with ordinality e(x,i)
  where x->'operation'->>'kind'='publication' and x->'operation'->>'month'=p_month and x->'operation'->'after'<>'null' order by i desc limit 1));
 prefix text:='replan/'||coalesce(s->'publications'->p_month->>'id','none')||'/'||coalesce((s->'events'->-1->>'sequence')::bigint,0)||'/';
begin
 if last is not null and exists(select 1 from jsonb_each(duty_private.compensation_atoms(last)) a where (a.value->>'endInstantMs')::bigint<=instant) then raise exception 'review-replan-started'; end if;
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

-- Source: schemas/grants/functions.sql
REVOKE ALL ON FUNCTION duty_private.compensation_replan(jsonb, text, bigint, boolean, text) FROM PUBLIC, anon, authenticated, service_role;

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
 -- whose only version was deleted while its lots couldn't be reversed keeps them live until
 -- then; they are reversed too.
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
 -- Deleting a month's only version removes what it booked (decision 2026-11-07): the same
 -- audited corrections as a re-plan reverse every live lot the month's publications booked and
 -- the deletion cancels its pending repayments, so with no version left every net is zero. The
 -- kept draft copy is then a plan of its own: publishing it books it again. When worked or used
 -- points make that impossible (review-replan-*: started, repaid by a later month, settled by
 -- hand), the lots stay live as before and a new plan reverses them.
 if deleting and publication is null and before_pub is not null then
  begin
   s:=duty_private.compensation_replan(s,month,instant,true,'Deleted the published '||month||' version');
   -- A new allocation identity: its intents are booked again, never matched to the reversed ones.
   update public.duty_allocations a set source_publication_id=null,allocation_id=gen_random_uuid()
    where a.month=compensation_publication.month and a.publication_id is null and a.source_publication_id::text=before_pub->>'id';
   return;
  exception when raise_exception then
   if SQLERRM not like 'review-replan-%' then raise; end if;
  end;
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
