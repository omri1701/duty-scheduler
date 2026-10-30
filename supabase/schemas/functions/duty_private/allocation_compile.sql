-- Reconstruct allocation tokens from reviewed counterpart operations. All claim
-- capacity comes from the server's projected ledger, excluding other reservations.
CREATE FUNCTION duty_private.allocation_compile(f jsonb, draft jsonb, actual jsonb, s jsonb) RETURNS jsonb
 LANGUAGE plpgsql STABLE SET search_path TO '' AS $$
#variable_conflict use_column
declare ids jsonb:=f->'seniority'; candidates jsonb:=duty_private.compensation_candidates(s); expected jsonb; table_value jsonb;
 tokens jsonb:='[]'; reserved jsonb:='[]'; funding jsonb:='[]'; used jsonb:='[]'; seen text[]:='{}';
 r jsonb; c jsonb; t jsonb; u jsonb; moved jsonb; transfer jsonb; route jsonb; leg jsonb; ref jsonb; ranges int8multirange; part int8range;
 id text; name text; n bigint; take bigint; remaining bigint; capacity bigint; idx integer; position integer; amount bigint; total bigint;
begin
 if jsonb_typeof(draft) IS DISTINCT FROM 'object' or draft-array['baselineUnits','offeredUnits','targetsUnits','repayments','transfers','pending','sourceKey','uneven']<>'{}'
  or jsonb_typeof(draft->'sourceKey') IS DISTINCT FROM 'string' or coalesce(draft->>'sourceKey','')=''
  or jsonb_typeof(draft->'repayments') IS DISTINCT FROM 'array' or jsonb_typeof(draft->'transfers') IS DISTINCT FROM 'array'
  or jsonb_typeof(coalesce(draft->'uneven','[]')) IS DISTINCT FROM 'array'
  or draft->'pending' IS DISTINCT FROM '[]'::jsonb then raise exception 'invalid-confirmed-allocation'; end if;
 foreach name in array array['baselineUnits','offeredUnits','targetsUnits'] loop
  table_value:=draft->name;
  if jsonb_typeof(table_value) IS DISTINCT FROM 'object' or (select count(*) from jsonb_each(table_value))<>jsonb_array_length(ids)
   or exists(select 1 from jsonb_each(table_value) where not ids ? key) then raise exception 'invalid-allocation-members'; end if;
  total:=0; for id in select jsonb_array_elements_text(ids) loop total:=total+duty_private.compensation_units(table_value->id); end loop;
  if total<>(select sum((x->>'units')::bigint) from jsonb_array_elements(f->'duties') x) then raise exception 'invalid-allocation-total'; end if;
 end loop;
 expected:=draft->'baselineUnits';
 for id in select x from jsonb_array_elements_text(ids) x order by x COLLATE "C" loop
  tokens:=tokens||jsonb_build_array(jsonb_build_object('carrier',id,'origin',id,'units',expected->id,'claim',null,'trail','[]'::jsonb,'prior','[]'::jsonb));
 end loop;
 -- Uneven-month credit (verified by confirm_allocation against the baseline):
 -- part of the creditor's own fitted share is carried for the debtor, exactly as
 -- if the equal split had been transferred temporarily. Targets are unchanged.
 for u in select value from jsonb_array_elements(coalesce(draft->'uneven','[]')) loop
  if jsonb_typeof(u) IS DISTINCT FROM 'object' or u-array['id','fromId','toId','units']<>'{}' or jsonb_typeof(u->'id') IS DISTINCT FROM 'string'
   or u->>'id' IS DISTINCT FROM 'uneven/'||(u->>'fromId')||'/'||(u->>'toId') or u->>'id'=any(seen) or not ids ? (u->>'fromId') or not ids ? (u->>'toId') or u->>'fromId'=u->>'toId' then raise exception 'invalid-uneven-credit'; end if;
  seen:=array_append(seen,u->>'id'); n:=duty_private.compensation_units(u->'units',true);
  select ordinality::integer-1 into position from jsonb_array_elements(tokens) with ordinality
   where value->>'carrier'=u->>'toId' and value->>'origin'=u->>'toId' and value->'claim'='null' and value->'trail'='[]'::jsonb and (value->>'units')::bigint>=n limit 1;
  if position is null then raise exception 'uneven-credit-exceeds-share'; end if;
  tokens:=jsonb_set(tokens,array[position::text,'units'],to_jsonb((tokens->position->>'units')::bigint-n));
  tokens:=tokens||jsonb_build_array(jsonb_build_object('carrier',u->'toId','origin',u->'fromId','units',n,'claim',null,'trail',jsonb_build_array(u->'id'),'prior','[]'::jsonb));
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
  -- Deferral consumes newest repayment tokens first, then ordinary responsibility.
  for t,position in select value,ordinality::integer-1 from jsonb_array_elements(tokens) with ordinality
   where value->>'carrier'=transfer->>'fromId' and (value->>'units')::bigint>0
   order by (value->'claim'<>'null') desc,(value->'claim'->'priority'->>'at')::bigint desc,
    (value->'claim'->'priority'->>'sequence')::bigint desc,value->'claim'->'priority'->>'lotId' COLLATE "C" desc,value->'claim'->>'id' COLLATE "C" desc,ordinality loop
   if remaining=0 then exit; end if;
   take:=least(remaining,(t->>'units')::bigint); remaining:=remaining-take;
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
