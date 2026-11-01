CREATE FUNCTION duty_private.confirm_allocation(p_month text, p_allocation jsonb, p_locks jsonb, p_approvals jsonb, p_revision bigint, p_fingerprint text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare ctx jsonb; facts jsonb; assignments jsonb; checked jsonb; projected jsonb; old_meta public.duty_allocations; instant bigint;
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
