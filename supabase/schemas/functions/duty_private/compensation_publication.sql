-- edit: a server-built published duty edit, {intents, reason}. Its permanent
-- intents join the carried ones; the reason is the event's manager-only audit.
CREATE FUNCTION duty_private.compensation_publication(month text, publication uuid, metadata jsonb DEFAULT NULL, deleting boolean DEFAULT false, edit jsonb DEFAULT NULL) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
#variable_conflict use_column
declare s jsonb; before_pub jsonb; after_pub jsonb; op jsonb; atoms jsonb; old_atoms jsonb; reservations jsonb; instant bigint; known jsonb; allocation public.duty_allocations; facts jsonb; checked jsonb; assignments jsonb;
begin
 perform 1 from public.duty_workspace where id for update;
 s:=duty_private.compensation_state(); before_pub:=s->'publications'->month;
 instant:=greatest(duty_private.compensation_now(),coalesce((s->'events'->-1->>'at')::bigint,0));
 s:=duty_private.compensation_reconcile(s,instant);
 -- Ordinary copies retain accounting metadata and contribution identities.
 if before_pub->>'id'=publication::text then return; end if;
 if before_pub is null and publication is null then return; end if;
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
  select * into allocation from public.duty_allocations where publication_id=publication and duty_allocations.month=month;
  if allocation.month is not null then
   if metadata is not null then raise exception 'Allocation accounting is server-owned'; end if;
   if allocation.source_publication_id is null then
    if allocation.accounting_fingerprint<>md5((s->'events')::text) then raise exception 'Compensation changed. Refresh and review.' using errcode='40001'; end if;
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
  if edit is not null then
   if metadata is not null or deleting or before_pub is null then raise exception 'invalid-publication-edit'; end if;
   after_pub:=jsonb_set(after_pub,'{intents}',(after_pub->'intents')||coalesce(edit->'intents','[]'));
  end if;
 end if;
 op:=jsonb_build_object('kind','publication','month',month,'beforeId',before_pub->'id','after',after_pub);
 -- Unknown pre-cutover versions preserve completed facts below the ordinary
 -- transition rules. Known deletion uses the core's terminal handling.
 if deleting and (after_pub is null or known is not null) and before_pub is not null then op:=op||'{"mode":"delete"}'; end if;
 perform duty_private.compensation_append(s,op,'publication/'||coalesce(publication::text,'none')||'/'||(coalesce((s->'events'->-1->>'sequence')::bigint,0)+1),instant,coalesce(auth.uid()::text,'system'),nullif(edit->>'reason',''));
end $$;
