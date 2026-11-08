-- Per-person allocation changes: one net Temporary and one net Permanent change
-- per member replace the recorded history of clicks. The transfer list is derived
-- (pairs first, then netted) and the checked confirm requires it exactly; the
-- floors (fair + Permanent >= 0, Permanent never below planned relief, points
-- never below locked) are enforced server-side. The same decision as before for
-- everything else: baseline, repayment sources, counterpart conservation, locks.

-- The canonical transfer list of a per-person allocation state, kind by kind
-- (permanent first): explicit pairs in order, clipped to the net changes they
-- can still route, then the remainder netted largest first, then seniority
-- order, each side advancing only when exhausted. One transfer per direction;
-- round trips cancel in the nets. lib/allocation/derive.ts deriveTransfers is
-- the same derivation; duty_confirm_allocation requires the client's list to
-- equal this one, so no transfer list can manufacture relief the nets do not show.
CREATE FUNCTION duty_private.allocation_transfers(seniority jsonb, changes jsonb, pairs jsonb) RETURNS jsonb
 LANGUAGE plpgsql IMMUTABLE SET search_path TO '' AS $$
#variable_conflict use_column
declare kind text; remaining jsonb; flows jsonb; result jsonb:='[]'; p jsonb; u bigint; idx integer; id text;
 debtors text[]; creditors text[]; d_units bigint[]; c_units bigint[]; d integer; c integer; from_id text; to_id text;
begin
 foreach kind in array array['permanent','temporary'] loop
  remaining:='{}'; flows:='[]';
  for id in select jsonb_array_elements_text(seniority) loop remaining:=remaining||jsonb_build_object(id,coalesce((changes->id->>kind)::numeric::bigint,0)); end loop;
  for p in select value from jsonb_array_elements(pairs) where value->>'kind'=kind loop
   from_id:=p->>'fromId'; to_id:=p->>'toId';
   if from_id is null or to_id is null or not remaining ? from_id or not remaining ? to_id or from_id=to_id then continue; end if;
   u:=least((p->>'units')::numeric::bigint,greatest(0,-(remaining->>from_id)::bigint),greatest(0,(remaining->>to_id)::bigint));
   if u<=0 then continue; end if;
   select i::integer-1 into idx from jsonb_array_elements(flows) with ordinality a(v,i) where v->>'fromId'=from_id and v->>'toId'=to_id;
   if idx is null then flows:=flows||jsonb_build_array(jsonb_build_object('id',kind||'/'||from_id||'/'||to_id,'fromId',from_id,'toId',to_id,'units',u,'kind',kind));
   else flows:=jsonb_set(flows,array[idx::text,'units'],to_jsonb((flows->idx->>'units')::bigint+u)); end if;
   remaining:=remaining||jsonb_build_object(from_id,(remaining->>from_id)::bigint+u,to_id,(remaining->>to_id)::bigint-u);
  end loop;
  select array_agg(key order by -(value::bigint) desc,i),array_agg(-(value::bigint) order by -(value::bigint) desc,i) into debtors,d_units
   from jsonb_each_text(remaining) r join jsonb_array_elements_text(seniority) with ordinality s(member,i) on s.member=r.key where value::bigint<0;
  select array_agg(key order by value::bigint desc,i),array_agg(value::bigint order by value::bigint desc,i) into creditors,c_units
   from jsonb_each_text(remaining) r join jsonb_array_elements_text(seniority) with ordinality s(member,i) on s.member=r.key where value::bigint>0;
  d:=1; c:=1;
  while d<=coalesce(cardinality(debtors),0) and c<=coalesce(cardinality(creditors),0) loop
   from_id:=debtors[d]; to_id:=creditors[c]; u:=least(d_units[d],c_units[c]);
   select i::integer-1 into idx from jsonb_array_elements(flows) with ordinality a(v,i) where v->>'fromId'=from_id and v->>'toId'=to_id;
   if idx is null then flows:=flows||jsonb_build_array(jsonb_build_object('id',kind||'/'||from_id||'/'||to_id,'fromId',from_id,'toId',to_id,'units',u,'kind',kind));
   else flows:=jsonb_set(flows,array[idx::text,'units'],to_jsonb((flows->idx->>'units')::bigint+u)); end if;
   d_units[d]:=d_units[d]-u; c_units[c]:=c_units[c]-u;
   if d_units[d]=0 then d:=d+1; end if;
   if c_units[c]=0 then c:=c+1; end if;
  end loop;
  result:=result||flows;
 end loop;
 return result;
end $$;

REVOKE ALL ON FUNCTION duty_private.allocation_transfers(seniority jsonb, changes jsonb, pairs jsonb) FROM PUBLIC, anon, authenticated, service_role;

-- Reconstruct allocation tokens from reviewed counterpart operations. All claim
-- capacity comes from the server's projected ledger, excluding other reservations.
-- One net temporary and one net permanent change per member must explain the
-- targets exactly, balance to zero and respect the floors (a permanent change
-- never takes away the fair share or work already given as planned relief).
-- duty_confirm_allocation additionally requires the transfers to be the exact
-- derivation of those changes and the recorded pairs.
CREATE OR REPLACE FUNCTION duty_private.allocation_compile(f jsonb, draft jsonb, actual jsonb, s jsonb) RETURNS jsonb
 LANGUAGE plpgsql STABLE SET search_path TO '' AS $$
#variable_conflict use_column
declare ids jsonb:=f->'seniority'; candidates jsonb:=duty_private.compensation_candidates(s); expected jsonb; table_value jsonb; change jsonb;
 tokens jsonb:='[]'; reserved jsonb:='[]'; funding jsonb:='[]'; used jsonb:='[]'; seen text[]:='{}'; lowered jsonb:='{}';
 r jsonb; c jsonb; t jsonb; moved jsonb; transfer jsonb; route jsonb; leg jsonb; ref jsonb; ranges int8multirange; part int8range; v numeric;
 id text; name text; n bigint; take bigint; remaining bigint; capacity bigint; idx integer; position integer; amount bigint; total bigint;
 pass integer; temporary_total bigint:=0; permanent_total bigint:=0;
begin
 if jsonb_typeof(draft) IS DISTINCT FROM 'object' or draft-array['baselineUnits','offeredUnits','targetsUnits','repayments','changes','pairs','transfers','sourceKey']<>'{}'
  or jsonb_typeof(draft->'sourceKey') IS DISTINCT FROM 'string' or coalesce(draft->>'sourceKey','')=''
  or jsonb_typeof(draft->'repayments') IS DISTINCT FROM 'array' or jsonb_typeof(draft->'transfers') IS DISTINCT FROM 'array'
  or jsonb_typeof(draft->'pairs') IS DISTINCT FROM 'array' or jsonb_typeof(draft->'changes') IS DISTINCT FROM 'object' then raise exception 'invalid-confirmed-allocation'; end if;
 foreach name in array array['baselineUnits','offeredUnits','targetsUnits'] loop
  table_value:=draft->name;
  if jsonb_typeof(table_value) IS DISTINCT FROM 'object' or (select count(*) from jsonb_each(table_value))<>jsonb_array_length(ids)
   or exists(select 1 from jsonb_each(table_value) where not ids ? key) then raise exception 'invalid-allocation-members'; end if;
  total:=0; for id in select jsonb_array_elements_text(ids) loop total:=total+duty_private.compensation_units(table_value->id); end loop;
  if total<>(select sum((x->>'units')::bigint) from jsonb_array_elements(f->'duties') x) then raise exception 'invalid-allocation-total'; end if;
 end loop;
 if (select count(*) from jsonb_each(draft->'changes'))<>jsonb_array_length(ids) or exists(select 1 from jsonb_each(draft->'changes') where not ids ? key) then raise exception 'invalid-allocation-changes'; end if;
 for id in select jsonb_array_elements_text(ids) loop
  change:=draft->'changes'->id;
  if jsonb_typeof(change) IS DISTINCT FROM 'object' or change-array['temporary','permanent']<>'{}' then raise exception 'invalid-allocation-changes'; end if;
  foreach name in array array['temporary','permanent'] loop
   if jsonb_typeof(change->name) IS DISTINCT FROM 'number' then raise exception 'invalid-allocation-changes'; end if;
   v:=(change->>name)::numeric;
   if v<>trunc(v) or abs(v)>1000000000 then raise exception 'invalid-allocation-changes'; end if;
  end loop;
  temporary_total:=temporary_total+(change->>'temporary')::numeric::bigint; permanent_total:=permanent_total+(change->>'permanent')::numeric::bigint;
  if (change->>'permanent')::numeric::bigint< -least((draft->'baselineUnits'->>id)::numeric::bigint,(draft->'offeredUnits'->>id)::numeric::bigint) then raise exception 'permanent-below-fair-share'; end if;
  if (draft->'offeredUnits'->>id)::numeric::bigint+(change->>'temporary')::numeric::bigint+(change->>'permanent')::numeric::bigint<>(draft->'targetsUnits'->>id)::numeric::bigint then raise exception 'unexplained-target-edit'; end if;
  lowered:=lowered||jsonb_build_object(id,greatest(0,(draft->'offeredUnits'->>id)::numeric::bigint-(draft->'targetsUnits'->>id)::numeric::bigint));
 end loop;
 if temporary_total<>0 or permanent_total<>0 then raise exception 'unbalanced-allocation-changes'; end if;
 for r in select value from jsonb_array_elements(draft->'pairs') loop
  if jsonb_typeof(r) IS DISTINCT FROM 'object' or r-array['id','fromId','toId','units','kind']<>'{}' or jsonb_typeof(r->'id') IS DISTINCT FROM 'string'
   or coalesce(btrim(r->>'id'),'')='' or r->>'id'=any(seen) or coalesce(r->>'kind','') not in ('temporary','permanent')
   or not ids ? (r->>'fromId') or not ids ? (r->>'toId') or r->>'fromId'=r->>'toId' then raise exception 'invalid-allocation-pair'; end if;
  perform duty_private.compensation_units(r->'units',true); seen:=array_append(seen,r->>'id');
 end loop;
 seen:='{}';
 expected:=draft->'baselineUnits';
 for id in select x from jsonb_array_elements_text(ids) x order by x COLLATE "C" loop
  tokens:=tokens||jsonb_build_array(jsonb_build_object('carrier',id,'origin',id,'units',expected->id,'claim',null,'trail','[]'::jsonb,'prior','[]'::jsonb));
 end loop;
 for r in select value from jsonb_array_elements(draft->'repayments') loop
  if jsonb_typeof(r) IS DISTINCT FROM 'object' or r-array['claim','units']<>'{}' then raise exception 'invalid-repayment-source'; end if;
  n:=duty_private.compensation_units(r->'units',true);
  c:=duty_private.compensation_locate(jsonb_build_object('claims',candidates),r->'claim');
  if c is null or r->'claim'->'priority' IS DISTINCT FROM c->'priority' or r->'claim'->'units' IS DISTINCT FROM r->'units'
   or r->'claim'->'frozen' IS DISTINCT FROM 'false'::jsonb or r->'claim'->'path'->0->'units' IS DISTINCT FROM r->'units'
   or not ids ? (c->>'debtorId') or not ids ? (c->>'creditorId') then raise exception 'invalid-repayment-source'; end if;
  if exists(select 1 from jsonb_array_elements(used) a,jsonb_array_elements(a->'path') p,jsonb_array_elements(r->'claim'->'path') q
    where p->>'lotId'=q->>'lotId' and (p->>'offset')::bigint<(q->>'offset')::bigint+n and (q->>'offset')::bigint<(p->>'offset')::bigint+(p->>'units')::bigint) then raise exception 'duplicate-repayment-source'; end if;
  used:=used||jsonb_build_array(r->'claim');
  expected:=jsonb_set(expected,array[c->>'debtorId'],to_jsonb((expected->>(c->>'debtorId'))::bigint+n));
  expected:=jsonb_set(expected,array[c->>'creditorId'],to_jsonb((expected->>(c->>'creditorId'))::bigint-n));
  remaining:=n;
  for t,position in select value,ordinality::integer-1 from jsonb_array_elements(tokens) with ordinality where value->>'carrier'=c->>'creditorId' and value->'claim'='null' loop
   take:=least(remaining,(t->>'units')::bigint); remaining:=remaining-take;
   tokens:=jsonb_set(tokens,array[position::text,'units'],to_jsonb((t->>'units')::bigint-take));
  end loop;
  if remaining<>0 then raise exception 'repayment-exceeds-creditor-relief'; end if;
  tokens:=tokens||jsonb_build_array(jsonb_build_object('carrier',c->'debtorId','origin',c->'creditorId','units',n,'claim',r->'claim','trail','[]'::jsonb,'prior','[]'::jsonb));
 end loop;
 if expected<>draft->'offeredUnits' then raise exception 'invalid-offered-allocation'; end if;
 for transfer in select value from jsonb_array_elements(draft->'transfers') loop
  if jsonb_typeof(transfer) IS DISTINCT FROM 'object' or transfer-array['id','fromId','toId','units','kind']<>'{}'
   or coalesce(btrim(transfer->>'id'),'')='' or transfer->>'id'=any(seen) or coalesce(transfer->>'kind','') not in ('temporary','permanent')
   or not ids ? (transfer->>'fromId') or not ids ? (transfer->>'toId') or transfer->>'fromId'=transfer->>'toId' then raise exception 'invalid-counterpart'; end if;
  seen:=array_append(seen,transfer->>'id'); remaining:=duty_private.compensation_units(transfer->'units',true);
  expected:=jsonb_set(expected,array[transfer->>'fromId'],to_jsonb((expected->>(transfer->>'fromId'))::bigint-remaining));
  expected:=jsonb_set(expected,array[transfer->>'toId'],to_jsonb((expected->>(transfer->>'toId'))::bigint+remaining));
  -- A lowered target defers newest repayment first, and only as far as it was
  -- lowered (pass 1); then ordinary responsibility moves (pass 2). Planned
  -- repayment work never moves for a change that keeps the target (pass 3 is a
  -- safety net for snapshots outside the floors).
  for pass in 1..3 loop
   for position in select ordinality::integer-1 from jsonb_array_elements(tokens) with ordinality tok(value,ordinality)
    where value->>'carrier'=transfer->>'fromId' and (value->>'units')::bigint>0 and ((pass in (1,3) and value->'claim'<>'null') or (pass=2 and value->'claim'='null'))
    order by (value->'claim'->'priority'->>'at')::bigint desc,(value->'claim'->'priority'->>'sequence')::bigint desc,
     value->'claim'->'priority'->>'lotId' COLLATE "C" desc,value->'claim'->>'id' COLLATE "C" desc,ordinality loop
    if remaining=0 then exit; end if;
    t:=tokens->position;
    take:=least(remaining,(t->>'units')::bigint);
    if pass=1 then take:=least(take,(lowered->>(transfer->>'fromId'))::bigint); end if;
    if take<=0 then continue; end if;
    if pass=1 then lowered:=jsonb_set(lowered,array[transfer->>'fromId'],to_jsonb((lowered->>(transfer->>'fromId'))::bigint-take)); end if;
    remaining:=remaining-take;
    moved:=duty_private.allocation_part(t,take,(t->>'units')::bigint-take);
    if (t->>'units')::bigint>take then tokens:=jsonb_set(tokens,array[position::text],duty_private.allocation_part(t,(t->>'units')::bigint-take));
    else tokens:=jsonb_set(tokens,array[position::text,'units'],'0'); end if;
    moved:=jsonb_set(moved,'{carrier}',transfer->'toId');
    if transfer->>'kind'='permanent' then
     if jsonb_array_length(moved->'trail')>0 and moved->>'origin'<>transfer->>'fromId' then
      leg:=jsonb_build_object('fromId',moved->'origin','toId',transfer->'fromId','units',take,'kind','temporary','transferIds',moved->'trail');
      if moved->'claim'<>'null' then leg:=leg||jsonb_build_object('deferredClaim',duty_private.compensation_slice(moved->'claim',take)); end if;
      moved:=jsonb_set(moved,'{prior}',(moved->'prior')||jsonb_build_array(leg));
     end if;
     moved:=moved||jsonb_build_object('origin',transfer->'toId','claim',null,'trail','[]'::jsonb,'prior',(moved->'prior')||jsonb_build_array(
      jsonb_build_object('fromId',transfer->'fromId','toId',transfer->'toId','kind','permanent','units',take,'transferIds',jsonb_build_array(transfer->'id'))));
    else moved:=jsonb_set(moved,'{trail}',(moved->'trail')||jsonb_build_array(transfer->'id')); end if;
    tokens:=tokens||jsonb_build_array(moved);
   end loop;
   if remaining=0 then exit; end if;
  end loop;
  if remaining<>0 then raise exception 'transfer-exceeds-source-target'; end if;
 end loop;
 if expected<>draft->'targetsUnits' then raise exception 'unexplained-target-edit'; end if;
 for id in select x from jsonb_array_elements_text(ids) x order by x COLLATE "C" loop
  capacity:=(actual->>id)::bigint;
  for t in select value from jsonb_array_elements(tokens) tok(value) where value->>'carrier'=id and (value->>'units')::bigint>0
   order by case when value->'claim'<>'null' and value->>'carrier'=value->'claim'->>'debtorId' or
     (value->'claim'='null' and jsonb_array_length(value->'trail')>0 and exists(select 1 from jsonb_array_elements(candidates) c where c->>'debtorId'=id and c->>'creditorId'=tok.value->>'origin')) then 1
    when jsonb_array_length(value->'trail')>0 and value->>'origin'<>id then 2 else 0 end,
    (value->'claim'->'priority'->>'at')::bigint,(value->'claim'->'priority'->>'sequence')::bigint,
    value->'claim'->'priority'->>'lotId' COLLATE "C",value->'claim'->>'id' COLLATE "C" loop
   take:=least(capacity,(t->>'units')::bigint); capacity:=capacity-take; if take=0 then continue; end if;
   moved:=duty_private.allocation_part(t,take); route:=moved->'prior';
   if moved->'claim'<>'null' and moved->>'carrier'=moved->'claim'->>'debtorId' then reserved:=reserved||jsonb_build_array(jsonb_build_object('claim',duty_private.compensation_slice(moved->'claim',take),'units',take));
   elsif jsonb_array_length(moved->'trail')>0 and moved->>'origin'<>id then
    leg:=jsonb_build_object('fromId',moved->'origin','toId',id,'units',take,'kind','temporary','transferIds',moved->'trail');
    if moved->'claim'<>'null' then leg:=leg||jsonb_build_object('deferredClaim',duty_private.compensation_slice(moved->'claim',take)); end if;
    route:=route||jsonb_build_array(leg);
   end if;
   if jsonb_array_length(route)>0 then funding:=funding||jsonb_build_array(jsonb_build_object('carrierId',id,'units',take,'route',route)); end if;
  end loop;
 end loop;
 -- Reverse ordinary burdens repay existing debt; publication must not forgive
 -- it by immediately creating an opposing origin before any work completes.
 for t,position in select value,ordinality::integer-1 from jsonb_array_elements(funding) with ordinality loop
  for leg in select value from jsonb_array_elements(t->'route') where value->>'kind'='temporary' and not value ? 'deferredClaim' loop
   if not exists(select 1 from jsonb_array_elements(s->'claims') c where c->>'debtorId'=leg->>'toId' and c->>'creditorId'=leg->>'fromId') then continue; end if;
   if jsonb_array_length(t->'route')<>1 or leg->>'toId'<>t->>'carrierId' then raise exception 'review-compound-reverse-obligation'; end if;
   remaining:=(t->>'units')::bigint;
   for c in select value from jsonb_array_elements(candidates) where value->>'debtorId'=leg->>'toId' and value->>'creditorId'=leg->>'fromId' loop
    ranges:=int8multirange(int8range(0,(c->>'units')::bigint,'[)'));
    for r in select value from jsonb_array_elements(reserved) where value->'claim'->>'debtorId'=c->>'debtorId' and value->'claim'->>'creditorId'=c->>'creditorId' and value->'claim'->'path'->0->>'lotId'=c->'path'->0->>'lotId' loop
     amount:=(r->'claim'->'path'->0->>'offset')::bigint-(c->'path'->0->>'offset')::bigint;
     ranges:=ranges-int8multirange(int8range(amount,amount+(r->>'units')::bigint,'[)'));
    end loop;
    for part in select unnest(ranges) loop
     take:=least(remaining,upper(part)-lower(part)); if take=0 then continue; end if;
     reserved:=reserved||jsonb_build_array(jsonb_build_object('claim',duty_private.compensation_slice(c,take,lower(part)),'units',take)); remaining:=remaining-take;
    end loop;
   end loop;
   if remaining<>0 then raise exception 'review-unavailable-reverse-obligation'; end if;
   funding:=jsonb_set(funding,array[position::text,'units'],'0');
  end loop;
 end loop;
 return jsonb_build_object('repayments',reserved,'funding',coalesce((select jsonb_agg(x) from jsonb_array_elements(funding) x where (x->>'units')::bigint>0),'[]'));
end $$;

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
  perform duty_private.allocation_compile(facts,p_allocation,checked->'actualUnits',projected);
  perform duty_private.allocation_baseline(facts,p_allocation->'baselineUnits');
  -- The transfer list is derived, never chosen: the per-person changes and the
  -- recorded pairs must give exactly this list under the current seniority.
  if p_allocation->'transfers' IS DISTINCT FROM duty_private.allocation_transfers(facts->'seniority',p_allocation->'changes',p_allocation->'pairs') then raise exception 'invalid-derived-transfers'; end if;
  if old_meta.month is not null and old_meta.calendar_fingerprint=md5((select jsonb_agg(d-array['primary','secondary'] order by d->>'id')::text from jsonb_array_elements(facts->'duties') d))
   and (select array_agg(key order by key) from jsonb_each(old_meta.allocation->'baselineUnits'))=(select array_agg(key order by key) from jsonb_each(p_allocation->'baselineUnits'))
   and old_meta.allocation->'baselineUnits'<>p_allocation->'baselineUnits' then raise exception 'Ordinary baseline is immutable. Classify target changes as transfers.'; end if;
  if old_meta.source_publication_id is not null and p_allocation->'transfers'<>'[]' then raise exception 'Review published transfer lineage before changing allocation'; end if;
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

-- Working drafts confirmed before per-person changes: express their recorded
-- counterpart transfers as net changes, keeping every recorded transfer as a
-- routing pair, so the saved month still publishes and reviews. A snapshot the
-- new rules cannot express (pending edits, a permanent change below the floors,
-- or targets the transfers do not explain) stays as it is; the dialog then asks
-- for a new proposal. Copies of publications and published snapshots are
-- immutable and are not touched.
-- conversion-start
DO $$
declare rec record; ranking text[]; order_ids jsonb; changes jsonb; member_id text; t jsonb; kind text; n bigint; ok boolean;
begin
 select array_agg(m.id::text order by m.seniority,m.joined_at,m.id) into ranking from public.duty_members m where m.status='approved' and m.active;
 for rec in select month,allocation from public.duty_allocations where publication_id is null and source_publication_id is null and allocation ? 'pending' and not allocation ? 'changes' loop
  begin
  if rec.allocation->'pending' IS DISTINCT FROM '[]'::jsonb or jsonb_typeof(rec.allocation->'transfers') IS DISTINCT FROM 'array'
   or jsonb_typeof(rec.allocation->'baselineUnits') IS DISTINCT FROM 'object' or jsonb_typeof(rec.allocation->'offeredUnits') IS DISTINCT FROM 'object' or jsonb_typeof(rec.allocation->'targetsUnits') IS DISTINCT FROM 'object' then continue; end if;
  changes:='{}'; ok:=true;
  for member_id in select key from jsonb_each(rec.allocation->'baselineUnits') loop changes:=changes||jsonb_build_object(member_id,jsonb_build_object('temporary',0,'permanent',0)); end loop;
  for t in select value from jsonb_array_elements(rec.allocation->'transfers') loop
   kind:=t->>'kind';
   if kind not in ('temporary','permanent') or not changes ? (t->>'fromId') or not changes ? (t->>'toId') or jsonb_typeof(t->'units') IS DISTINCT FROM 'number' then ok:=false; exit; end if;
   n:=(t->>'units')::numeric::bigint;
   changes:=jsonb_set(changes,array[t->>'fromId',kind],to_jsonb((changes->(t->>'fromId')->>kind)::bigint-n));
   changes:=jsonb_set(changes,array[t->>'toId',kind],to_jsonb((changes->(t->>'toId')->>kind)::bigint+n));
  end loop;
  if not ok then continue; end if;
  for member_id in select key from jsonb_each(changes) loop
   if not (rec.allocation->'offeredUnits') ? member_id or not (rec.allocation->'targetsUnits') ? member_id
    or (changes->member_id->>'permanent')::bigint< -least((rec.allocation->'baselineUnits'->>member_id)::numeric::bigint,(rec.allocation->'offeredUnits'->>member_id)::numeric::bigint)
    or (rec.allocation->'offeredUnits'->>member_id)::numeric::bigint+(changes->member_id->>'temporary')::bigint+(changes->member_id->>'permanent')::bigint<>(rec.allocation->'targetsUnits'->>member_id)::numeric::bigint then ok:=false; end if;
  end loop;
  if not ok then continue; end if;
  select jsonb_agg(key order by coalesce(array_position(ranking,key),2147483647),key COLLATE "C") into order_ids from jsonb_each(changes);
  update public.duty_allocations set allocation=(rec.allocation-'pending')||jsonb_build_object('changes',changes,'pairs',rec.allocation->'transfers',
   'transfers',duty_private.allocation_transfers(order_ids,changes,rec.allocation->'transfers')) where month=rec.month and publication_id is null;
  -- A snapshot outside the old shape is left for a new proposal rather than failing the release.
  exception when others then raise notice 'Allocation draft for % kept in its earlier format: %',rec.month,sqlerrm;
  end;
 end loop;
end $$;
-- conversion-end
