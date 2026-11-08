-- A deferred repayment handed to someone who owes the same creditor books as that
-- person's own repayment (decision 2026-10-31). When B's lowered target hands B's
-- planned repayment to C over to D, and D owes C too, the point repays D's oldest
-- open debt to C; B's debt stays open and nothing new is owed to D. Before, the
-- deferral reached publication as a C -> D origin that normalization netted against
-- D's debt, and allocation_bind refused it (review-normalized-deferral-route).
-- This is the existing reverse-obligation rule for ordinary relief, now also applied
-- to deferred repayment legs. lib/allocation/compile.ts applies the same rule.
-- Only the function body changes; owner, search_path and grants are kept.

-- Source: schemas/functions/duty_private/allocation_compile.sql
-- Reconstruct allocation tokens from reviewed counterpart operations. All claim
-- capacity comes from the server's projected ledger, excluding other reservations.
-- One net temporary and one net permanent change per member must explain the
-- targets exactly, balance to zero and respect the floors (a permanent change
-- never takes away the fair share or work already given as planned relief) and
-- the ceilings (fair share + permanent change never exceeds the month's total
-- points, and no one owes or is owed more temporary work than the month holds).
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
 if jsonb_typeof(draft) IS DISTINCT FROM 'object' or draft-array['baselineUnits','offeredUnits','targetsUnits','repayments','changes','pairs','transfers','uneven','hand','sourceKey']<>'{}'
  or jsonb_typeof(draft->'sourceKey') IS DISTINCT FROM 'string' or coalesce(draft->>'sourceKey','')=''
  or (draft ? 'uneven' and jsonb_typeof(draft->'uneven') IS DISTINCT FROM 'array')
  or jsonb_typeof(draft->'repayments') IS DISTINCT FROM 'array' or jsonb_typeof(draft->'transfers') IS DISTINCT FROM 'array'
  or jsonb_typeof(draft->'pairs') IS DISTINCT FROM 'array' or jsonb_typeof(draft->'changes') IS DISTINCT FROM 'object' then raise exception 'invalid-confirmed-allocation'; end if;
 -- Members the manager edited by hand: editing state the browser reopens with, so
 -- automatic points keep flowing the same way. Absent in plans saved before it existed.
 if draft ? 'hand' and (jsonb_typeof(draft->'hand') IS DISTINCT FROM 'array'
  or exists(select 1 from jsonb_array_elements(draft->'hand') h where jsonb_typeof(h) IS DISTINCT FROM 'string' or not ids ? (h#>>'{}'))
  or (select count(*) from jsonb_array_elements(draft->'hand'))<>(select count(distinct h) from jsonb_array_elements(draft->'hand') h)) then raise exception 'invalid-hand-edits'; end if;
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
  -- total holds the month's units: every table above was checked against them.
  if (draft->'baselineUnits'->>id)::numeric::bigint+(change->>'permanent')::numeric::bigint>total then raise exception 'permanent-above-month-total'; end if;
  if abs((change->>'temporary')::numeric::bigint)>total then raise exception 'temporary-above-month-total'; end if;
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
 -- Uneven-month credit (decision 2026-10-30): part of the creditor's own fitted
 -- share is carried for the debtor, exactly as if the equal split had been
 -- transferred temporarily. Targets are unchanged. duty_confirm_allocation
 -- requires the stored list to be exactly duty_private.allocation_uneven; a
 -- snapshot saved before the credit existed carries none.
 for r in select value from jsonb_array_elements(coalesce(draft->'uneven','[]'::jsonb)) loop
  if jsonb_typeof(r) IS DISTINCT FROM 'object' or r-array['id','fromId','toId','units']<>'{}' or r->>'id' IS DISTINCT FROM 'uneven/'||(r->>'fromId')||'/'||(r->>'toId')
   or r->>'id'=any(seen) or not ids ? (r->>'fromId') or not ids ? (r->>'toId') or r->>'fromId'=r->>'toId' then raise exception 'invalid-uneven-credit'; end if;
  seen:=array_append(seen,r->>'id'); n:=duty_private.compensation_units(r->'units',true);
  select ordinality::integer-1 into position from jsonb_array_elements(tokens) with ordinality tok(value,ordinality)
   where value->>'carrier'=r->>'toId' and value->>'origin'=r->>'toId' and value->'claim'='null' and value->'trail'='[]'::jsonb and (value->>'units')::bigint>=n limit 1;
  if position is null then raise exception 'uneven-credit-exceeds-share'; end if;
  tokens:=jsonb_set(tokens,array[position::text,'units'],to_jsonb((tokens->position->>'units')::bigint-n));
  tokens:=tokens||jsonb_build_array(jsonb_build_object('carrier',r->'toId','origin',r->'fromId','units',n,'claim',null,'trail',jsonb_build_array(r->'id'),'prior','[]'::jsonb));
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
  -- Relief consumes the creditor's own ordinary work, never work carried for others.
  for t,position in select value,ordinality::integer-1 from jsonb_array_elements(tokens) with ordinality where value->>'carrier'=c->>'creditorId' and value->'claim'='null' and value->'trail'='[]'::jsonb loop
   take:=least(remaining,(t->>'units')::bigint); remaining:=remaining-take;
   tokens:=jsonb_set(tokens,array[position::text,'units'],to_jsonb((t->>'units')::bigint-take));
  end loop;
  if remaining<>0 then raise exception 'repayment-exceeds-creditor-relief'; end if;
  tokens:=tokens||jsonb_build_array(jsonb_build_object('carrier',c->'debtorId','origin',c->'creditorId','units',n,'claim',r->'claim','trail','[]'::jsonb,'prior','[]'::jsonb));
 end loop;
 if expected<>draft->'offeredUnits' then raise exception 'invalid-offered-allocation'; end if;
 for transfer in select value from jsonb_array_elements(draft->'transfers') loop
  if jsonb_typeof(transfer) IS DISTINCT FROM 'object' or transfer-array['id','fromId','toId','units','kind']<>'{}'
   or coalesce(btrim(transfer->>'id'),'')='' or transfer->>'id'=any(seen) or starts_with(transfer->>'id','uneven/') or coalesce(transfer->>'kind','') not in ('temporary','permanent')
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
 -- Reverse burdens repay existing debt; publication must not forgive
 -- it by immediately creating an opposing origin before any work completes.
 -- A deferred repayment counts too (decision 2026-10-31): B's repayment to C
 -- handed to D, who owes C, is D's own repayment to C; B's debt stays open.
 for t,position in select value,ordinality::integer-1 from jsonb_array_elements(funding) with ordinality loop
  for leg in select value from jsonb_array_elements(t->'route') where value->>'kind'='temporary' loop
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
