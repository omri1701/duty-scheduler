CREATE FUNCTION duty_private.compensation_transition(s jsonb, e jsonb) RETURNS jsonb
 LANGUAGE plpgsql STABLE SET search_path TO '' AS $$
#variable_conflict use_column
declare op jsonb:=e->'operation'; before_pub jsonb:=s->'publications'->(op->>'month'); after_pub jsonb:=nullif(op->'after','null');
 old_atoms jsonb; new_atoms jsonb; a jsonb; b jsonb; known jsonb; proposed jsonb:='{}'::jsonb; excluded jsonb:='{}'::jsonb;
 r jsonb; c jsonb; intent jsonb; cap jsonb; previous jsonb; temporary jsonb:='[]'::jsonb; applied jsonb:='[]'::jsonb; effects jsonb:='[]'::jsonb;
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
  if jsonb_typeof(intent) IS DISTINCT FROM 'object' or intent-array['id','kind','fromId','toId','capacity']<>'{}'
   or jsonb_typeof(intent->'id') IS DISTINCT FROM 'string' or key !~ '^[A-Za-z0-9][A-Za-z0-9_./:-]{0,159}$'
   or jsonb_typeof(intent->'fromId') IS DISTINCT FROM 'string' or jsonb_typeof(intent->'toId') IS DISTINCT FROM 'string'
   or jsonb_typeof(intent->'capacity') IS DISTINCT FROM 'array' then raise exception 'invalid-intent'; end if;
  if coalesce(key,'')='' or intent->>'kind' not in ('temporary','permanent') or intent->>'kind' is null
   or (select count(*) from jsonb_array_elements(after_pub->'intents') i where i->>'id'=key)>1 then raise exception 'invalid-intent'; end if;
  previous:=s->'intents'->key;
  if previous is not null then if previous<>intent then raise exception 'intent-lineage-changed'; end if; continue; end if;
  if not coalesce(s->'members' ? (intent->>'fromId'),false) or not coalesce(s->'members' ? (intent->>'toId'),false) or intent->>'fromId'=intent->>'toId' then raise exception 'invalid-endpoints'; end if;
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
  if intent->>'kind'='temporary' then applied:=applied||jsonb_build_array(intent||jsonb_build_object('units',amount)); end if;
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
