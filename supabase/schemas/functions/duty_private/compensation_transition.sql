CREATE FUNCTION duty_private.compensation_transition(s jsonb, e jsonb) RETURNS jsonb
 LANGUAGE plpgsql STABLE SET search_path TO '' AS $$
#variable_conflict use_column
declare op jsonb:=e->'operation'; before_pub jsonb:=s->'publications'->(op->>'month'); after_pub jsonb:=nullif(op->'after','null');
 old_atoms jsonb; new_atoms jsonb; a jsonb; b jsonb; known jsonb; proposed jsonb:='{}'::jsonb; excluded jsonb:='{}'::jsonb;
 r jsonb; c jsonb; intent jsonb; cap jsonb; previous jsonb; temporary jsonb:='[]'::jsonb; applied jsonb:='[]'::jsonb; effects jsonb:='[]'::jsonb;
 route jsonb; leg jsonb; trail jsonb; t jsonb; route_index integer; leg_index integer; budget jsonb; route_budgets jsonb:='{}';
 key text; day text; amount bigint; shared bigint; off bigint; cell bigint; idx integer:=0; unchanged boolean; exempt boolean;
begin
 if (before_pub->>'id') is distinct from (op->>'beforeId') or (after_pub is not null and after_pub->>'month'<>op->>'month') then raise exception 'stale-publication'; end if;
 select x->'operation'->'after' into known from jsonb_array_elements(s->'events') x where x->'operation'->>'kind'='publication' and x->'operation'->'after'->>'id'=after_pub->>'id' limit 1;
 if known is not null and known<>after_pub then raise exception 'immutable-publication'; end if;
 if op ? 'mode' and (op->>'mode'<>'delete' or before_pub is null or (after_pub is not null and (known is null or after_pub->>'id'=before_pub->>'id'))) then raise exception 'invalid-publication-deletion'; end if;
 old_atoms:=duty_private.compensation_atoms(before_pub); new_atoms:=duty_private.compensation_atoms(after_pub);
 if after_pub is not null and (jsonb_typeof(after_pub->'reservations') IS DISTINCT FROM 'array' or jsonb_typeof(after_pub->'intents') IS DISTINCT FROM 'array') then raise exception 'invalid-publication-metadata'; end if;
 if exists(select 1 from jsonb_each(new_atoms) x where not (s->'members' ? (value->>'primaryId'))) then raise exception 'invalid-published-duty'; end if;
 if after_pub is not null and coalesce(op->>'mode','')<>'delete' and exists(select 1 from jsonb_each(old_atoms) x where (value->>'endInstantMs')::bigint<=(e->>'at')::bigint and value is distinct from new_atoms->key) then raise exception 'historical-publication-change'; end if;
 for r in select value from jsonb_array_elements(coalesce(after_pub->'reservations','[]')) order by value->>'id' COLLATE "C" loop
  key:=r->>'id'; cap:=r->'capacity'; b:=new_atoms->(cap->>'date');
  if jsonb_typeof(r) IS DISTINCT FROM 'object' or r-array['id','capacity','claim']<>'{}'
   or jsonb_typeof(r->'id') IS DISTINCT FROM 'string' or key !~ '^[A-Za-z0-9][A-Za-z0-9_./:-]{0,159}$'
   or jsonb_typeof(cap) IS DISTINCT FROM 'object' or cap-array['date','offset','units']<>'{}'
   or jsonb_typeof(cap->'date') IS DISTINCT FROM 'string' then raise exception 'invalid-reservation'; end if;
  if coalesce(key,'')='' or proposed ? key then raise exception 'duplicate-contribution'; end if;
  if b is null or duty_private.compensation_units(cap->'offset')+duty_private.compensation_units(cap->'units',true)>(b->>'units')::bigint then raise exception 'invalid-capacity-slice'; end if;
  if b->>'primaryId'<>r->'claim'->>'debtorId' then raise exception 'reservation-primary-mismatch'; end if;
  proposed:=proposed||jsonb_build_object(key,r);
 end loop;
 for r in select value from jsonb_array_elements(coalesce(before_pub->'reservations','[]')) order by value->>'id' COLLATE "C" loop
  key:=r->>'id'; c:=s->'contributions'->key; cap:=c->'capacity'; day:=cap->>'date'; a:=old_atoms->day; b:=new_atoms->day;
  if proposed ? key and proposed->key<>r then raise exception 'contribution-lineage-changed'; end if;
  unchanged:=proposed ? key and b is not null and a->>'primaryId'=b->>'primaryId' and (cap->>'offset')::bigint+(cap->>'units')::bigint<=(b->>'units')::bigint;
  if unchanged then
   if c->>'status' in ('pending','held') then
    if (b->>'endInstantMs')::bigint<=(e->>'at')::bigint and b->'endInstantMs'<>c->'endInstantMs' then raise exception 'historical-repayment-rebind'; end if;
    s:=jsonb_set(s,array['contributions',key,'endInstantMs'],b->'endInstantMs');
   end if;
   continue;
  end if;
  if proposed ? key then raise exception 'changed-duty-reuses-contribution'; end if;
  if c->>'status' not in ('pending','held') then continue; end if;
  s:=jsonb_set(s,array['contributions',key,'status'],'"cancelled"');
  if b is not null and a->>'primaryId'<>b->>'primaryId' then
   off:=(cap->>'offset')::bigint; shared:=greatest(0,least((a->>'units')::bigint,(b->>'units')::bigint,off+(cap->>'units')::bigint)-off); amount:=0;
   for cell in select generate_series(off,off+shared-1) loop
    select exists(select 1 from jsonb_array_elements(coalesce(after_pub->'intents','[]')) i,jsonb_array_elements(i->'capacity') p where i->>'kind'='permanent' and not (s->'intents' ? (i->>'id')) and p->>'date'=day and cell>=(p->>'offset')::bigint and cell<(p->>'offset')::bigint+(p->>'units')::bigint) into exempt;
    if not exempt then excluded:=duty_private.compensation_exclude(excluded,jsonb_build_object('date',day,'offset',cell,'units',1)); amount:=amount+1; end if;
   end loop;
   if amount>0 and c->'claim'->>'creditorId'<>b->>'primaryId' then effects:=effects||jsonb_build_array(jsonb_build_object('debtorId',c->'claim'->'creditorId','creditorId',b->'primaryId','units',amount)); end if;
  end if;
 end loop;
 for intent in select value from jsonb_array_elements(coalesce(after_pub->'intents','[]')) order by value->>'id' COLLATE "C" loop
  key:=intent->>'id';
  if jsonb_typeof(intent) IS DISTINCT FROM 'object' or intent-array['id','kind','fromId','toId','capacity','route']<>'{}'
   or jsonb_typeof(intent->'id') IS DISTINCT FROM 'string' or key !~ '^[A-Za-z0-9][A-Za-z0-9_./:-]{0,159}$'
   or jsonb_typeof(intent->'fromId') IS DISTINCT FROM 'string' or jsonb_typeof(intent->'toId') IS DISTINCT FROM 'string'
   or jsonb_typeof(intent->'capacity') IS DISTINCT FROM 'array' then raise exception 'invalid-intent'; end if;
  if coalesce(key,'')='' or intent->>'kind' not in ('temporary','permanent') or intent->>'kind' is null
   or (select count(*) from jsonb_array_elements(after_pub->'intents') i where i->>'id'=key)>1 then raise exception 'invalid-intent'; end if;
  previous:=s->'intents'->key;
  if previous is not null then if previous<>intent then raise exception 'intent-lineage-changed'; end if; continue; end if;
  if not coalesce(s->'members' ? (intent->>'fromId'),false) or not coalesce(s->'members' ? (intent->>'toId'),false) or intent->>'fromId'=intent->>'toId' then raise exception 'invalid-endpoints'; end if;
  route:=intent->'route';
  if route is not null then
   if jsonb_typeof(route) IS DISTINCT FROM 'array' or jsonb_array_length(route)=0 or route->0->>'fromId'<>intent->>'fromId'
    or route->-1->>'toId'<>intent->>'toId' or route->0->>'kind'<>intent->>'kind' then raise exception 'invalid-intent-route'; end if;
   for leg,route_index in select value,ordinality::int-1 from jsonb_array_elements(route) with ordinality loop
    trail:=leg->'counterparts';
    if jsonb_typeof(leg) IS DISTINCT FROM 'object' or leg-array['fromId','toId','kind','transferIds','deferredClaim','counterparts']<>'{}'
     or jsonb_typeof(leg->'fromId') IS DISTINCT FROM 'string' or jsonb_typeof(leg->'toId') IS DISTINCT FROM 'string'
     or coalesce(leg->>'kind','') not in ('temporary','permanent') or not coalesce(s->'members' ? (leg->>'fromId'),false)
     or not coalesce(s->'members' ? (leg->>'toId'),false) or leg->>'fromId'=leg->>'toId'
     or (route_index>0 and route->(route_index-1)->>'toId'<>leg->>'fromId')
     or jsonb_typeof(leg->'transferIds') IS DISTINCT FROM 'array' or jsonb_array_length(leg->'transferIds')=0
     or jsonb_typeof(trail) IS DISTINCT FROM 'array' or jsonb_array_length(trail)<>jsonb_array_length(leg->'transferIds')
     or (trail->0->>'fromId') IS DISTINCT FROM coalesce(leg->'deferredClaim'->>'debtorId',leg->>'fromId')
     or (trail->-1->>'toId') IS DISTINCT FROM (leg->>'toId') or (leg ? 'deferredClaim' and (leg->'deferredClaim'->>'creditorId') IS DISTINCT FROM (leg->>'fromId')) then raise exception 'invalid-intent-route'; end if;
    if leg ? 'deferredClaim' then
     if jsonb_typeof(leg->'deferredClaim') IS DISTINCT FROM 'object' or (leg->'deferredClaim')-array['debtorId','creditorId','path']<>'{}'
      or jsonb_typeof(leg->'deferredClaim'->'debtorId') IS DISTINCT FROM 'string' or jsonb_typeof(leg->'deferredClaim'->'creditorId') IS DISTINCT FROM 'string' then raise exception 'invalid-intent-route'; end if;
     perform duty_private.compensation_segment(leg->'deferredClaim','{"at":0,"sequence":0,"lotId":"reference"}');
     if duty_private.compensation_locate(s,leg->'deferredClaim') is null then raise exception 'invalid-deferred-source'; end if;
    end if;
    for t,leg_index in select value,ordinality::int-1 from jsonb_array_elements(trail) with ordinality loop
     if jsonb_typeof(t) IS DISTINCT FROM 'object' or t-array['id','fromId','toId','units','kind']<>'{}'
      or jsonb_typeof(t->'id') IS DISTINCT FROM 'string' or jsonb_typeof(leg->'transferIds'->leg_index) IS DISTINCT FROM 'string'
      or jsonb_typeof(t->'fromId') IS DISTINCT FROM 'string' or jsonb_typeof(t->'toId') IS DISTINCT FROM 'string'
      or coalesce(btrim(t->>'id'),'')='' or (t->>'id') IS DISTINCT FROM (leg->'transferIds'->>leg_index) or (t->>'kind') IS DISTINCT FROM (leg->>'kind')
      or (leg_index>0 and trail->(leg_index-1)->>'toId'<>t->>'fromId')
      or not coalesce(s->'members' ? (t->>'fromId'),false) or not coalesce(s->'members' ? (t->>'toId'),false) or t->>'fromId'=t->>'toId' then raise exception 'invalid-intent-route'; end if;
     perform duty_private.compensation_units(t->'units',true);
    end loop;
   end loop;
  end if;
  if jsonb_array_length(intent->'capacity')=0 then raise exception 'unfunded-intent'; end if;
  amount:=0;
  for cap in select value from jsonb_array_elements(intent->'capacity') loop
   if jsonb_typeof(cap) IS DISTINCT FROM 'object' or cap-array['date','offset','units']<>'{}' or jsonb_typeof(cap->'date') IS DISTINCT FROM 'string' then raise exception 'invalid-capacity-slice'; end if;
   day:=cap->>'date'; a:=old_atoms->day; b:=new_atoms->day;
   if b is null or duty_private.compensation_units(cap->'offset')+duty_private.compensation_units(cap->'units',true)>(b->>'units')::bigint then raise exception 'invalid-capacity-slice'; end if;
   if b->>'primaryId'<>intent->>'toId' then raise exception 'intent-primary-mismatch'; end if;
   if a is not null and a->>'primaryId'<>intent->>'toId' and a->>'primaryId'<>intent->>'fromId' then raise exception 'intent-counterpart-mismatch'; end if;
   if a->>'primaryId'=intent->>'toId' and (cap->>'offset')::bigint<least((a->>'units')::bigint,(b->>'units')::bigint) then raise exception 'unchanged-capacity-intent'; end if;
   excluded:=duty_private.compensation_exclude(excluded,cap); amount:=amount+(cap->>'units')::bigint;
  end loop;
  s:=jsonb_set(s,array['intents',key],intent);
  if route is not null then
   for leg,route_index in select value,ordinality::int-1 from jsonb_array_elements(route) with ordinality loop
    for t in select value from jsonb_array_elements(leg->'counterparts') loop
     if (t->>'units')::bigint<amount then raise exception 'unfunded-intent-route'; end if;
     budget:=route_budgets->(t->>'id');
     if budget is not null and budget->'transfer'<>t then raise exception 'intent-counterpart-lineage-changed'; end if;
     if coalesce((budget->>'used')::bigint,0)+amount>(t->>'units')::bigint then raise exception 'unfunded-intent-route'; end if;
     route_budgets:=jsonb_set(route_budgets,array[t->>'id'],jsonb_build_object('transfer',t,'used',coalesce((budget->>'used')::bigint,0)+amount));
    end loop;
    if leg->>'kind'='temporary' then applied:=applied||jsonb_build_array(jsonb_build_object('id',key||'/route/'||route_index,
     'fromId',leg->'fromId','toId',leg->'toId','units',amount)); end if;
   end loop;
  elsif intent->>'kind'='temporary' then applied:=applied||jsonb_build_array(intent||jsonb_build_object('units',amount)); end if;
 end loop;
 for day,a in select * from jsonb_each(old_atoms) order by key loop
  b:=new_atoms->day;
  if (a->>'endInstantMs')::bigint<=(e->>'at')::bigint or b is null or a->>'primaryId'=b->>'primaryId' then continue; end if;
  shared:=least((a->>'units')::bigint,(b->>'units')::bigint); amount:=0;
  for cell in select generate_series(0,shared-1) loop
   if not coalesce(excluded->day,'[]') @> jsonb_build_array(cell) then
    excluded:=duty_private.compensation_exclude(excluded,jsonb_build_object('date',day,'offset',cell,'units',1)); amount:=amount+1;
   end if;
  end loop;
  if amount>0 then effects:=effects||jsonb_build_array(jsonb_build_object('debtorId',a->'primaryId','creditorId',b->'primaryId','units',amount)); end if;
 end loop;
 for c in select value from jsonb_array_elements(effects) loop
  temporary:=temporary||jsonb_build_array(duty_private.compensation_segment(c||jsonb_build_object('path',jsonb_build_array(jsonb_build_object('lotId',idx::text,'offset',0,'units',c->'units'))),jsonb_build_object('at',e->'at','sequence',e->'sequence','lotId',idx::text))); idx:=idx+1;
 end loop;
 idx:=0;
 for c in select value from jsonb_array_elements(duty_private.compensation_normalize(temporary,s->'members')->'claims') loop
  s:=duty_private.compensation_lot(s,e,(e->>'sourceKey')||'/transfer/'||idx,c->>'debtorId',c->>'creditorId',(c->>'units')::bigint); idx:=idx+1;
 end loop;
 for intent in select value from jsonb_array_elements(applied) loop
  s:=duty_private.compensation_lot(s,e,(e->>'sourceKey')||'/intent/'||(intent->>'id'),intent->>'fromId',intent->>'toId',(intent->>'units')::bigint);
 end loop;
 if after_pub is null then s:=jsonb_set(s,'{publications}',(s->'publications')-(op->>'month'));
 else s:=jsonb_set(s,array['publications',op->>'month'],after_pub); end if;
 return jsonb_build_object('state',s,'proposed',proposed,'excluded',excluded,'before',before_pub,'atoms',new_atoms);
end $$;
