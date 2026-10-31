-- Uneven months earn credit (decision 2026-10-30): when indivisible duty weights
-- force the fitted ordinary baseline above the plain equal split, the extra is
-- temporary compensation. allocation_uneven derives the exact system transfers
-- (debtors: fewest points, most senior first; creditors: most points, most
-- senior first); duty_confirm_allocation refuses any other set, allocation_compile
-- carries the credit at confirm and publication, allocation_bind records it with
-- the ordinary counterpart shape, duty_balance names it as kind 'uneven', and
-- compensation_publication refuses client metadata that borrows the reserved
-- allocation/ and uneven/ identities.
-- The credit follows the real permanent load (decision 2026-10-31): a creditor is
-- credited only for the extra it still carries after its net permanent loss, a
-- debtor owes only while still below the split after its net permanent gain, and
-- the server derives the pairing under the current seniority, so a reorder after
-- confirmation never traps the month. Snapshots saved before this migration have
-- no credit and stay valid.

-- System credit for an indivisible month (decision 2026-10-30): the fitted
-- ordinary baseline's excess over the plain equal split, owed as temporary
-- transfers. The baseline is compared rank by rank with the sorted plain split,
-- so the remainder choice itself never creates debt; only the fit's deviation
-- does. Among equal points the newest member takes the kinder plain share, so the
-- more senior one carries the difference. A creditor is credited only for the
-- extra it still carries after its net permanent loss, and a debtor owes only
-- while it still sits below the split after its net permanent gain (decision
-- 2026-10-31). Debtors: fewest points, most senior first. Creditors: most
-- points, most senior first. Pure and deterministic; the browser's
-- unevenTransfers derives the same list and confirm refuses any other.
CREATE FUNCTION duty_private.allocation_uneven(f jsonb, baseline jsonb, changes jsonb) RETURNS jsonb
 LANGUAGE plpgsql IMMUTABLE SET search_path TO '' AS $$
declare ids text[]; n integer; total bigint:=0; q bigint:=0; w bigint; share bigint; remainder integer; plain bigint[]:='{}'; points bigint[]:='{}'; perm bigint[]:='{}';
 excess bigint[]; deficit bigint[]; creditors integer[]; debtors integer[]; c integer; d integer; k integer; amount bigint; result jsonb:='[]';
begin
 select array_agg(x order by i) into ids from jsonb_array_elements_text(f->'seniority') with ordinality a(x,i);
 n:=coalesce(cardinality(ids),0);
 if n=0 then return result; end if;
 for w in select (x->>'units')::bigint from jsonb_array_elements(f->'duties') x loop total:=total+w; q:=gcd(q,w); end loop;
 if q=0 then q:=1; end if;
 share:=total/(n*q)*q; remainder:=((total-share*n)/q)::integer;
 for k in 1..n loop
  plain[k]:=share+case when k>n-remainder then q else 0 end;
  points[k]:=duty_private.compensation_units(baseline->ids[k]);
  perm[k]:=coalesce((changes->ids[k]->>'permanent')::numeric::bigint,0);
 end loop;
 select array_agg(greatest(0,points[i]-plain[n+1-rank]-greatest(0,-perm[i])) order by i) into excess
  from (select i,row_number() over (order by points[i] desc,i desc) rank from generate_series(1,n) i) r;
 select array_agg(greatest(0,plain[rank]-points[i]-greatest(0,perm[i])) order by i) into deficit
  from (select i,row_number() over (order by points[i],i desc) rank from generate_series(1,n) i) r;
 select array_agg(i order by points[i] desc,i) into creditors from generate_series(1,n) i where excess[i]>0;
 select array_agg(i order by points[i],i) into debtors from generate_series(1,n) i where deficit[i]>0;
 if creditors is null or debtors is null then return result; end if;
 foreach c in array creditors loop
  foreach d in array debtors loop
   exit when excess[c]=0;
   amount:=least(excess[c],deficit[d]);
   if amount=0 then continue; end if;
   result:=result||jsonb_build_array(jsonb_build_object('id','uneven/'||ids[d]||'/'||ids[c],'fromId',ids[d],'toId',ids[c],'units',amount));
   excess[c]:=excess[c]-amount; deficit[d]:=deficit[d]-amount;
  end loop;
 end loop;
 return result;
end $$;

REVOKE ALL ON FUNCTION duty_private.allocation_uneven(f jsonb, baseline jsonb, changes jsonb) FROM PUBLIC, anon, authenticated, service_role;

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
 if jsonb_typeof(draft) IS DISTINCT FROM 'object' or draft-array['baselineUnits','offeredUnits','targetsUnits','repayments','changes','pairs','transfers','uneven','sourceKey']<>'{}'
  or jsonb_typeof(draft->'sourceKey') IS DISTINCT FROM 'string' or coalesce(draft->>'sourceKey','')=''
  or (draft ? 'uneven' and jsonb_typeof(draft->'uneven') IS DISTINCT FROM 'array')
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

-- Bind independently compiled intent to exclusive real primary date capacity.
-- Returned metadata is server-produced; callers cannot supply lots or balances.
CREATE OR REPLACE FUNCTION duty_private.allocation_bind(f jsonb, draft jsonb, s jsonb, allocation_id uuid, publication jsonb, instant bigint) RETURNS jsonb
 LANGUAGE plpgsql STABLE SET search_path TO '' AS $$
#variable_conflict use_column
declare assignments jsonb; checked jsonb; plan jsonb; atoms jsonb; taken jsonb; funding jsonb; route jsonb; leg jsonb;
 intents jsonb:='[]'; reservations jsonb:='[]'; before_state jsonb:=s; next_state jsonb; e jsonb; c jsonb; r jsonb; candidate jsonb; intent jsonb;
 pool jsonb:='[]'; entry jsonb; original jsonb; ref jsonb; capacity jsonb; idx integer:=0; pos integer; n bigint; remaining bigint; off bigint; lo bigint; hi bigint;
 leg_index integer; path_index integer; routed_units bigint; new_lot text;
begin
 select jsonb_object_agg(d->>'id',jsonb_build_object('primary',d->'primary','secondary',d->'secondary')) into assignments from jsonb_array_elements(f->'duties') d;
 checked:=duty_private.generation_validate(f,draft->'targetsUnits',assignments);
 plan:=duty_private.allocation_compile(f,draft,checked->'actualUnits',s);
 atoms:=duty_private.compensation_atoms(publication);
 for funding in select value from jsonb_array_elements(plan->'funding') loop
  taken:=duty_private.allocation_take(atoms,funding->>'carrierId',(funding->>'units')::bigint); atoms:=taken->'atoms';
  -- Uneven-month credit is recorded with the same counterpart shape as a temporary transfer.
  select jsonb_agg((l-array['units','normalizedDeferredClaims'])||jsonb_build_object('counterparts',
   (select jsonb_agg(cp.t order by j) from jsonb_array_elements_text(l->'transferIds') with ordinality ids(id,j)
     join (select value t from jsonb_array_elements(draft->'transfers') union all
      select value||'{"kind":"temporary"}'::jsonb from jsonb_array_elements(coalesce(draft->'uneven','[]'))) cp on cp.t->>'id'=id)) order by i) into route
   from jsonb_array_elements(funding->'route') with ordinality legs(l,i);
  intents:=intents||jsonb_build_array(jsonb_build_object('id','allocation/'||allocation_id||'/intent/'||idx,
   'kind',route->0->'kind','fromId',route->0->'fromId','toId',funding->'carrierId','route',route,'capacity',taken->'capacity')); idx:=idx+1;
 end loop;
 publication:=publication||jsonb_build_object('intents',intents,'reservations','[]'::jsonb);
 e:=jsonb_build_object('sequence',coalesce((s->'events'->-1->>'sequence')::bigint,0)+1,'sourceKey','publication/'||(publication->>'id')||'/'||(coalesce((s->'events'->-1->>'sequence')::bigint,0)+1),
  'at',instant,'actor',coalesce(auth.uid()::text,'system'),'operation',jsonb_build_object('kind','publication','month',publication->'month',
  'beforeId',s->'publications'->(publication->>'month')->'id','after',publication));
 next_state:=duty_private.compensation_apply(s,e);
 -- A deferral may normalize through the original source's oldest prefix, but
 -- cannot quietly route through another obligation or disappear by netting.
 for intent in select value from jsonb_array_elements(intents) loop
  for leg,leg_index in select value,ordinality::int-1 from jsonb_array_elements(intent->'route') with ordinality where value ? 'deferredClaim' loop
   new_lot:=(e->>'sourceKey')||'/intent/'||(intent->>'id')||'/route/'||leg_index; routed_units:=0;
   for c in select value from jsonb_array_elements(next_state->'claims') loop
    select i::int-1 into path_index from jsonb_array_elements(c->'path') with ordinality a(p,i) where p->>'lotId'=new_lot;
    if path_index is null or path_index<=0 then continue; end if;
    if exists(select 1 from jsonb_array_elements(s->'claims') old where old->>'debtorId'=leg->'deferredClaim'->>'debtorId'
     and old->>'creditorId'=leg->>'fromId' and jsonb_array_length(old->'path')=path_index and not exists(
      select 1 from jsonb_array_elements(old->'path') with ordinality a(p,i) where p->>'lotId'<>c->'path'->(i::int-1)->>'lotId'
       or (c->'path'->(i::int-1)->>'offset')::bigint<(p->>'offset')::bigint
       or (c->'path'->(i::int-1)->>'offset')::bigint+(c->>'units')::bigint>(p->>'offset')::bigint+(p->>'units')::bigint)) then routed_units:=routed_units+(c->>'units')::bigint; end if;
   end loop;
   if routed_units<>(select sum((p->>'units')::bigint) from jsonb_array_elements(intent->'capacity') p) then raise exception 'review-normalized-deferral-route'; end if;
  end loop;
 end loop;
 if exists(select 1 from jsonb_each(s->'contributions') c where c.value->>'status'='pending'
  and next_state->'contributions'->c.key->>'holdReason'='claim-changed') then raise exception 'review-existing-reservation-normalization'; end if;
 -- Preserve each approved source's budget, but permit its still-unreserved
 -- suffix after new transfer normalization consumes the oldest prefix.
 for original in select value from jsonb_array_elements(duty_private.compensation_candidates(s)) loop
  for candidate in select value from jsonb_array_elements(duty_private.compensation_candidates(next_state)) where value->>'debtorId'=original->>'debtorId'
   and value->>'creditorId'=original->>'creditorId' and jsonb_array_length(value->'path')=jsonb_array_length(original->'path') loop
   if exists(select 1 from jsonb_array_elements(candidate->'path') with ordinality a(p,i) where p->>'lotId'<>original->'path'->(i::int-1)->>'lotId') then continue; end if;
   select greatest(0,max((original->'path'->(i::int-1)->>'offset')::bigint-(p->>'offset')::bigint)),
    least((candidate->>'units')::bigint,min((original->'path'->(i::int-1)->>'offset')::bigint+(original->>'units')::bigint-(p->>'offset')::bigint)) into lo,hi
    from jsonb_array_elements(candidate->'path') with ordinality a(p,i);
   if hi>lo then pool:=pool||jsonb_build_array(jsonb_build_object('source',original,'claim',duty_private.compensation_slice(candidate,hi-lo,lo),'units',hi-lo)); end if;
  end loop;
 end loop;
 idx:=0;
 for r in select value from jsonb_array_elements(plan->'repayments') loop
  remaining:=(r->>'units')::bigint;
  for entry,pos in select value,ordinality::int-1 from jsonb_array_elements(pool) with ordinality where (value->>'units')::bigint>0 loop
   if remaining=0 then exit; end if;
   original:=entry->'source';
   if duty_private.compensation_locate(jsonb_build_object('claims',jsonb_build_array(original)),r->'claim') is null then continue; end if;
   n:=least(remaining,(entry->>'units')::bigint); remaining:=remaining-n; ref:=duty_private.compensation_slice(entry->'claim',n);
   taken:=duty_private.allocation_take(atoms,ref->>'debtorId',n); atoms:=taken->'atoms'; off:=0;
   for capacity in select value from jsonb_array_elements(taken->'capacity') loop
    reservations:=reservations||jsonb_build_array(jsonb_build_object('id','allocation/'||allocation_id||'/repayment/'||idx,
     'capacity',capacity,'claim',duty_private.compensation_slice(ref,(capacity->>'units')::bigint,off)));
    off:=off+(capacity->>'units')::bigint; idx:=idx+1;
   end loop;
   pool:=jsonb_set(pool,array[pos::text,'units'],to_jsonb((entry->>'units')::bigint-n));
   if (entry->>'units')::bigint>n then pool:=jsonb_set(pool,array[pos::text,'claim'],duty_private.compensation_slice(entry->'claim',(entry->>'units')::bigint-n,n)); end if;
  end loop;
 end loop;
 publication:=publication||jsonb_build_object('reservations',reservations);
 -- The final replay independently verifies routes, normalization and exclusivity.
 perform duty_private.compensation_apply(before_state,jsonb_set(e,'{operation,after}',publication));
 return jsonb_build_object('intents',intents,'reservations',reservations,'fingerprint',md5((before_state->'events')::text));
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
  -- Uneven-month credit is derived too: exactly the fitted baseline's excess over the
  -- plain split that each creditor still carries after permanent changes, owed by the
  -- members still below it, paired under the current seniority. A manager can neither
  -- add, enlarge, redirect nor drop it.
  if coalesce(p_allocation->'uneven','[]'::jsonb) IS DISTINCT FROM duty_private.allocation_uneven(facts,p_allocation->'baselineUnits',p_allocation->'changes') then raise exception 'invalid-uneven-credit'; end if;
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

-- Read-only display projection. Due and future published work is simulated on
-- a private copy; nothing is appended and the workspace revision never changes.
-- Members receive only their own relationships; audit events/reasons never leave.
CREATE OR REPLACE FUNCTION duty_private.balance() RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
#variable_conflict use_column
declare me text; manager boolean; actual jsonb; projected jsonb; instant bigint; lines jsonb; net jsonb;
begin
 if not duty_private.is_member() then raise exception 'Member access required' using errcode='42501'; end if;
 me:=auth.uid()::text; manager:=duty_private.is_manager();
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

CREATE OR REPLACE FUNCTION duty_private.compensation_publication(month text, publication uuid, metadata jsonb DEFAULT NULL, deleting boolean DEFAULT false) RETURNS void
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
 end if;
 op:=jsonb_build_object('kind','publication','month',month,'beforeId',before_pub->'id','after',after_pub);
 -- Unknown pre-cutover versions preserve completed facts below the ordinary
 -- transition rules. Known deletion uses the core's terminal handling.
 if deleting and (after_pub is null or known is not null) and before_pub is not null then op:=op||'{"mode":"delete"}'; end if;
 perform duty_private.compensation_append(s,op,'publication/'||coalesce(publication::text,'none')||'/'||(coalesce((s->'events'->-1->>'sequence')::bigint,0)+1),instant,coalesce(auth.uid()::text,'system'));
end $$;
