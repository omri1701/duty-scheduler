-- Bind independently compiled intent to exclusive real primary date capacity.
-- Returned metadata is server-produced; callers cannot supply lots or balances.
CREATE FUNCTION duty_private.allocation_bind(f jsonb, draft jsonb, s jsonb, allocation_id uuid, publication jsonb, instant bigint) RETURNS jsonb
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
