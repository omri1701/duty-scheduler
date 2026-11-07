-- A hand split never changes the stored fair shares (decision 2026-11-07). Splitting a weekend
-- by hand adds half-point duties, so a fairer baseline exists at that step and the checked
-- confirmation refused the plan's unchanged stored baseline ('invalid-ordinary-baseline'); the
-- browser then replaced the plan with a new proposal and the points the manager typed moved.
-- Now an unchanged stored baseline only has to still split exactly into the month's duties;
-- a new baseline is still the month's ordinary fit. No table, data or grant to a role changes.

-- Source: schemas/functions/duty_private/allocation_kept_baseline.sql
-- A stored ordinary baseline the manager keeps unchanged after the month's duties changed
-- shape (a weekend split by hand, decision 2026-11-07) only has to still split exactly into
-- the duties: fair shares are never re-fitted behind the manager's back, so a split's half
-- points never make the saved plan "unfair". Exact count-vector partition, as the first
-- half of allocation_fit; outside its domain the original per-duty search decides.
CREATE FUNCTION duty_private.allocation_kept_baseline(f jsonb, baseline jsonb) RETURNS void
 LANGUAGE plpgsql IMMUTABLE SET search_path TO '' AS $$
declare weights integer[]; capacities integer[]; vals bigint[]; counts bigint[]; radix bigint[]:='{1}'; k integer; j integer; cap integer;
 total bigint; q bigint:=0; codes bigint[]; loads bigint[];
begin
 select array_agg((d->>'units')::integer order by (d->>'units')::integer desc),sum((d->>'units')::integer) into weights,total from jsonb_array_elements(f->'duties') d;
 select array_agg(value::integer order by value::integer desc) into capacities from jsonb_each(baseline);
 if coalesce(cardinality(weights),0)=0 or coalesce(cardinality(capacities),0)=0 or array_position(capacities,null) is not null
  or exists(select 1 from unnest(weights) w where w is null or w<1) or exists(select 1 from unnest(capacities) c where c<0)
  or (select sum(c) from unnest(capacities) c)<>total then raise exception 'invalid-ordinary-baseline'; end if;
 select array_agg(v order by v desc),array_agg(c order by v desc) into vals,counts from (select w::bigint v,count(*) c from unnest(weights) w group by w) g;
 k:=cardinality(vals);
 for j in 1..k loop q:=gcd(q,vals[j]); radix[j+1]:=radix[j]*(counts[j]+1); end loop;
 -- A share the duties' common step can't make (half points in a whole-point month) never fits.
 if exists(select 1 from unnest(capacities) c where c%q<>0) then raise exception 'invalid-ordinary-baseline'; end if;
 if cardinality(weights)>64 or cardinality(capacities)*total>=2^25 then
  if not duty_private.allocation_partition(weights,capacities) then raise exception 'invalid-ordinary-baseline'; end if;
  return;
 end if;
 -- A state is the remaining counts in mixed radix; duty value j is digit j. Fill each
 -- share from the remaining counts, value by value.
 codes:=array[radix[k+1]-1];
 foreach cap in array capacities loop
  loads:=array_fill(0::bigint,array[cardinality(codes)]);
  for j in 1..k loop
   select array_agg(code-x*radix[j]),array_agg(load+x*vals[j]) into codes,loads
   from (select distinct code,load from unnest(codes,loads) s(code,load)) s,generate_series(0,least(code/radix[j]%(counts[j]+1),(cap-load)/vals[j])) x;
   if codes is null then raise exception 'invalid-ordinary-baseline'; end if;
  end loop;
  select array_agg(distinct code) into codes from unnest(codes,loads) s(code,load) where load=cap;
  if codes is null then raise exception 'invalid-ordinary-baseline'; end if;
 end loop;
 if not 0=any(codes) then raise exception 'invalid-ordinary-baseline'; end if;
end $$;

-- Source: schemas/grants/functions.sql
REVOKE ALL ON FUNCTION duty_private.allocation_kept_baseline(f jsonb, baseline jsonb) FROM PUBLIC, anon, authenticated, service_role;

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
  -- A hand split never changes the stored fair shares (decision 2026-11-07): the stored
  -- baseline, kept unchanged, only has to still split into the month's duties. A new
  -- baseline must be the month's ordinary fit.
  if old_meta.month is not null and old_meta.allocation->'baselineUnits'=p_allocation->'baselineUnits' then
   perform duty_private.allocation_kept_baseline(facts,p_allocation->'baselineUnits');
  else perform duty_private.allocation_baseline(facts,p_allocation->'baselineUnits'); end if;
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
