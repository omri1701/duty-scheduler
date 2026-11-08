-- A deleted or re-planned month counts as nothing (decision 2026-11-07), replacing
-- 20261107101500_later_repaid_debts_stay. Deleting a month's only version, or re-planning it,
-- reverses every lot it booked, including those a later published month's pending repayment
-- relies on. That repayment is released and the work it planned becomes an ordinary debt the
-- other way (the repaid creditor owes the debtor), booked once with the same audited reason
-- and reversed in turn when that later month is deleted or re-planned, so Team nets show only
-- what is published. The kept-debt plan field (repaidLater), its checks and
-- duty_private.allocation_repaid_later are removed. Worked days keep their debts as before.
-- No table, data or grant to a role changes.

DROP FUNCTION duty_private.allocation_repaid_later(jsonb, text);

-- Source: schemas/functions/duty_private/compensation_replan.sql
-- The ledger a new plan for a month starts from (decision 2026-11-01): every live lot the
-- month's publication events booked is reversed by an audited correction, then a current
-- publication is deleted, which cancels its pending repayments. The plan, its checks and
-- its publication see the month as if it had never been booked; nothing is rewritten.
-- A month whose only version was deleted still has live lots: a new plan reverses them
-- too, so they are never counted twice. Keys carry the ledger position, so the month can
-- be re-planned again later. A deleted or re-planned month counts as nothing (decision
-- 2026-11-07): a later month's pending repayment of its lots is released, and the work it
-- planned becomes an ordinary debt the other way (the repaid creditor owes the debtor),
-- booked once with the same audited reason, and reversed in turn when the later month is
-- deleted or re-planned. Refused when a settled repayment of another
-- month used one of those lots, or a reversal would change a debt another month's pending
-- repayment relies on (review-replan-later:<month>), when part of one was settled by hand
-- (review-replan-settled), or once the published month has started (review-replan-started), its
-- last version counting when the only one was deleted: worked days keep their debts.
-- `commit` appends the events for real, inside the publishing transaction. Deleting a month's
-- only version reverses the same lots, with its own audit reason (decision 2026-11-07).
-- lib/compensation/replan.ts builds the same events.
CREATE OR REPLACE FUNCTION duty_private.compensation_replan(s jsonb, p_month text, instant bigint, commit boolean DEFAULT false, p_reason text DEFAULT NULL) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
#variable_conflict use_column
declare original jsonb:=s; pub jsonb:=s->'publications'->p_month; keys text[]; lots text[]; owned text[]; released jsonb:='[]'; lot jsonb; c jsonb; other text; op jsonb; key text;
 actor text:=coalesce(auth.uid()::text,'system'); reason text:=coalesce(p_reason,'Re-planned '||p_month);
 last jsonb:=coalesce(s->'publications'->p_month,(select x->'operation'->'after' from jsonb_array_elements(s->'events') with ordinality e(x,i)
  where x->'operation'->>'kind'='publication' and x->'operation'->>'month'=p_month and x->'operation'->'after'<>'null' order by i desc limit 1));
 prefix text:='replan/'||coalesce(s->'publications'->p_month->>'id','none')||'/'||coalesce((s->'events'->-1->>'sequence')::bigint,0)||'/';
begin
 if last is not null and exists(select 1 from jsonb_each(duty_private.compensation_atoms(last)) a where (a.value->>'endInstantMs')::bigint<=instant) then raise exception 'review-replan-started'; end if;
 select coalesce(array_agg(x->>'sourceKey'),'{}') into keys from jsonb_array_elements(s->'events') x
  where x->'operation'->>'kind'='publication' and x->'operation'->>'month'=p_month;
 -- A debt booked for the month's own released repayment is the month's too.
 select coalesce(array_agg(r->>'id'),'{}') into owned from jsonb_array_elements(s->'events') x,
  jsonb_array_elements(case when jsonb_typeof(x->'operation'->'after')='object' then x->'operation'->'after'->'reservations' else '[]'::jsonb end) r
  where x->'operation'->>'kind'='publication' and x->'operation'->>'month'=p_month;
 select coalesce(array_agg(l.key order by l.key COLLATE "C"),'{}') into lots from jsonb_each(s->'lots') l
  where (l.value->>'sourceKey'=any(keys) or substring(l.value->>'sourceKey' from '^replan/[^/]+/[0-9]+/reverse/(.+)$')=any(owned)) and (l.value->>'correctedUnits')::bigint>0;
 for c in select value from jsonb_each(s->'contributions') where value->>'status'<>'cancelled'
  and exists(select 1 from jsonb_array_elements(value->'claim'->'path') p where p->>'lotId'=any(lots)) order by key COLLATE "C" loop
  if pub is not null and exists(select 1 from jsonb_array_elements(pub->'reservations') r where r->>'id'=c->>'id') then
   if c->>'status'='settled' then raise exception 'review-replan-started'; end if;
   continue;
  end if;
  -- Another month's pending repayment is released; a held one never counts and stays as it is.
  if c->>'status'='pending' then released:=released||jsonb_build_array(c); continue; end if;
  if c->>'status'='held' then continue; end if;
  -- The earliest other month whose repayment uses this month's points.
  other:=least(other,coalesce((select min(m.key COLLATE "C") from jsonb_each(s->'publications') m
   where exists(select 1 from jsonb_array_elements(m.value->'reservations') r where r->>'id'=c->>'id')),'unknown'));
 end loop;
 if other is not null then raise exception 'review-replan-later:%',other; end if;
 for c in select value from jsonb_array_elements(released) loop
  s:=duty_private.compensation_replan_step(s,jsonb_build_object('kind','release','contributionId',c->'id'),prefix||'release/'||(c->>'id'),instant,actor,reason,commit);
 end loop;
 foreach key in array lots loop
  lot:=s->'lots'->key;
  if (lot->>'remaining')::bigint<(lot->>'units')::bigint then raise exception 'review-replan-settled'; end if;
  op:=jsonb_build_object('kind','correct','lotId',key,'deltaUnits',-(lot->>'correctedUnits')::bigint);
  s:=duty_private.compensation_replan_step(s,op,prefix||key,instant,actor,reason,commit);
 end loop;
 -- The released work stays planned: its creditor now owes the debtor who does it.
 for c in select value from jsonb_array_elements(released) loop
  op:=jsonb_build_object('kind','claim','debtorId',c->'claim'->'creditorId','creditorId',c->'claim'->'debtorId','units',c->'capacity'->'units');
  s:=duty_private.compensation_replan_step(s,op,prefix||'reverse/'||(c->>'id'),instant,actor,reason,commit);
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
   -- A route back to its own carrier: permanent legs out of it owe nothing and are
   -- dropped (decision 2026-11-01); its own debt can't be funded by its own work.
   while jsonb_array_length(route)>0 and route->0->>'fromId'=id loop
    if route->0->>'kind'<>'permanent' then raise exception 'review-circular-route'; end if;
    route:=route-0;
   end loop;
   if jsonb_array_length(route)>0 then funding:=funding||jsonb_build_array(jsonb_build_object('carrierId',id,'units',take,'route',route)); end if;
  end loop;
 end loop;
 -- Reverse burdens repay existing debt; publication must not forgive
 -- it by immediately creating an opposing origin before any work completes.
 -- A deferred repayment counts too (decision 2026-10-31): B's repayment to C
 -- handed to D, who owes C, is D's own repayment to C; B's debt stays open.
 -- Permanent legs before it owe nothing (decision 2026-11-01): a point C received
 -- permanently and hands to D is C's own work, which D repays C with.
 for t,position in select value,ordinality::integer-1 from jsonb_array_elements(funding) with ordinality loop
  for leg,idx in select value,ordinality::integer from jsonb_array_elements(t->'route') with ordinality where value->>'kind'='temporary' loop
   if not exists(select 1 from jsonb_array_elements(s->'claims') c where c->>'debtorId'=leg->>'toId' and c->>'creditorId'=leg->>'fromId') then continue; end if;
   if idx<>jsonb_array_length(t->'route') or leg->>'toId'<>t->>'carrierId'
    or exists(select 1 from jsonb_array_elements(t->'route') with ordinality x(v,i) where i<idx and v->>'kind'<>'permanent')
   then raise exception 'review-compound-reverse-obligation'; end if;
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
 -- points make that impossible (review-replan-*: started, a later month's repayment settled,
 -- settled by hand), the lots stay live as before and a new plan reverses them. A later month's
 -- pending repayment of those lots is released and becomes a debt the other way: a deleted
 -- month counts as nothing (decision 2026-11-07).
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
