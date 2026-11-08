-- Compensation persistence. Canonical definitions are in schemas/.
SET check_function_bodies = false;

-- Source: schemas/tables/duty_compensation_events.sql
-- The ledger is the only persisted compensation state. No balances/caches/FKs to
-- deletable publication rows: every operation contains its immutable provenance.
CREATE TABLE public.duty_compensation_events (
 sequence bigint PRIMARY KEY CHECK (sequence > 0),
 source_key text NOT NULL UNIQUE CHECK (length(source_key) BETWEEN 1 AND 240),
 at bigint NOT NULL CHECK (at BETWEEN 0 AND 9007199254740991),
 actor text NOT NULL CHECK (length(actor) BETWEEN 1 AND 80),
 reason text,
 operation jsonb NOT NULL CHECK (jsonb_typeof(operation) = 'object'),
 CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 2000)
);
ALTER TABLE public.duty_compensation_events ENABLE ROW LEVEL SECURITY;


-- Source: schemas/functions/duty_private/compensation.sql
CREATE OR REPLACE FUNCTION duty_private.compensation(p_operation jsonb, p_source_key text, p_reason text, p_revision bigint, p_fingerprint text DEFAULT NULL, p_cutoff bigint DEFAULT NULL) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
#variable_conflict use_column
declare s jsonb; projected jsonb; instant bigint; first_count bigint; key text; previous public.duty_compensation_events; allowed text[]; kind text:=p_operation->>'kind';
begin
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 perform 1 from public.duty_workspace where id for update;
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 if jsonb_typeof(p_operation) IS DISTINCT FROM 'object' or length(p_operation::text)>100000 or kind is null then raise exception 'Invalid compensation operation'; end if;
 case kind
 when 'claim' then allowed:=array['kind','debtorId','creditorId','units'];
 when 'adjust' then allowed:=array['kind','claim','units','mode'];
 when 'correct' then allowed:=array['kind','lotId','deltaUnits'];
 when 'reverse-settlement' then allowed:=array['kind','settlementId'];
 when 'release' then allowed:=array['kind','contributionId'];
 when 'reconcile' then allowed:=array['kind'];
 else raise exception 'Invalid compensation operation';
 end case;
 if p_operation-allowed<>'{}' then raise exception 'Invalid compensation fields'; end if;
 if kind<>'reconcile' then
  if p_source_key is null or p_source_key !~ '^[A-Za-z0-9][A-Za-z0-9_./:-]{0,159}$' or coalesce(btrim(p_reason,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'),'')='' or length(p_reason)>2000 then raise exception 'Source key and reason required'; end if;
  key:='manual/'||auth.uid()::text||'/'||p_source_key;
  select * into previous from public.duty_compensation_events where source_key=key;
  if found and (previous.operation<>p_operation or previous.reason is distinct from p_reason or previous.actor<>auth.uid()::text) then raise exception 'source-key-conflict'; end if;
 end if;
 -- An identical authorized retry may carry its original revision. It cannot
 -- write a second discretionary event or apply changed content under that key.
 if previous.sequence is null then perform duty_private.check_revision(p_revision); end if;
 s:=duty_private.compensation_state(); first_count:=jsonb_array_length(s->'events');
 instant:=greatest(duty_private.compensation_now(),coalesce((s->'events'->-1->>'at')::bigint,0));
 s:=duty_private.compensation_reconcile(s,instant);
 if previous.sequence is null and p_fingerprint is not null and p_fingerprint<>md5((s->'events')::text) then raise exception 'Compensation changed. Refresh and review.' using errcode='40001'; end if;
 if kind<>'reconcile' then s:=duty_private.compensation_append(s,p_operation,key,instant,auth.uid()::text,p_reason); end if;
 if jsonb_array_length(s->'events')<>first_count then update public.duty_workspace set revision=revision+1 where id; end if;
 if p_cutoff is not null then
  if p_cutoff<instant or p_cutoff>9007199254740991 then raise exception 'projection-before-now'; end if;
  projected:=duty_private.compensation_view(duty_private.compensation_reconcile(s,p_cutoff,false));
 end if;
 return jsonb_build_object('revision',(select revision from public.duty_workspace where id),'actualAtMs',instant,'cutoffMs',p_cutoff,
  'fingerprint',md5((s->'events')::text),'actual',duty_private.compensation_view(s),
  'projected',case when projected is not null then jsonb_build_object('claims',projected->'claims','net',projected->'net') end);
end $$;


-- Source: schemas/functions/duty_private/compensation_append.sql
CREATE OR REPLACE FUNCTION duty_private.compensation_append(s jsonb, op jsonb, key text, instant bigint, actor text, reason text DEFAULT NULL) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
#variable_conflict use_column
declare e jsonb; previous public.duty_compensation_events; seq bigint:=coalesce((s->'events'->-1->>'sequence')::bigint,0)+1;
begin
 select * into previous from public.duty_compensation_events where source_key=key;
 if found then
  if previous.operation<>op or previous.actor<>actor or previous.reason is distinct from reason then raise exception 'source-key-conflict'; end if;
  return s;
 end if;
 -- Omit only the optional envelope reason. Recursive null stripping would erase
 -- publication beforeId/after null sentinels and corrupt the PR #33 contract.
 e:=jsonb_build_object('sequence',seq,'sourceKey',key,'at',instant,'actor',actor,'operation',op)
  ||case when reason is null then '{}'::jsonb else jsonb_build_object('reason',reason) end;
 s:=duty_private.compensation_apply(s,e);
 insert into public.duty_compensation_events(sequence,source_key,at,actor,reason,operation) values(seq,key,instant,actor,reason,op);
 return s;
end $$;


-- Source: schemas/functions/duty_private/compensation_apply.sql
-- Pure replay primitive. Never granted to API roles; commands enter through the
-- checked adapter, which derives actor, time, membership and publication facts.
CREATE OR REPLACE FUNCTION duty_private.compensation_apply(s jsonb, e jsonb) RETURNS jsonb
 LANGUAGE plpgsql STABLE SET search_path TO '' AS $$
#variable_conflict use_column
declare op jsonb:=e->'operation'; kind text:=op->>'kind'; p jsonb; c jsonb; lot jsonb; previous jsonb; result jsonb;
 amount bigint; priority jsonb; finish jsonb; key text;
begin
 if kind not in ('earned','hold') and exists(select 1 from jsonb_each(s->'contributions') a where value->>'status'='pending' and (value->>'endInstantMs')::bigint<=(e->>'at')::bigint) then raise exception 'reconciliation-required'; end if;
 if kind in ('claim','adjust','correct','reverse-settlement','release') and coalesce(btrim(e->>'reason',U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'),'')='' then raise exception 'manual-reason-required'; end if;
 case kind
 when 'members' then
  for p in select value from jsonb_array_elements(op->'members') loop
   s:=jsonb_set(s,array['members',p->>'id'],p);
  end loop;
 when 'claim' then s:=duty_private.compensation_lot(s,e,e->>'sourceKey',op->>'debtorId',op->>'creditorId',duty_private.compensation_units(op->'units',true));
 when 'adjust' then
  amount:=duty_private.compensation_units(op->'units',true);
  if op->>'mode' not in ('reduce','settle') or op->>'mode' is null then raise exception 'invalid-adjustment'; end if;
  s:=duty_private.compensation_consume(s,op->'claim',amount,case when op->>'mode'='settle' then e->>'sourceKey' end);
 when 'correct' then
  if jsonb_typeof(op->'deltaUnits') IS DISTINCT FROM 'number' then raise exception 'invalid-correction'; end if;
  amount:=duty_private.compensation_units(to_jsonb(abs((op->>'deltaUnits')::numeric)),true);
  if (op->>'deltaUnits')::numeric<0 then amount:=-amount; end if;
  lot:=s->'lots'->(op->>'lotId');
  if lot is null then raise exception 'unknown-correction-source'; end if;
  perform duty_private.compensation_units(to_jsonb((lot->>'correctedUnits')::bigint+amount));
  s:=jsonb_set(s,array['lots',op->>'lotId','correctedUnits'],to_jsonb((lot->>'correctedUnits')::bigint+amount));
  s:=duty_private.compensation_lot(s,e,e->>'sourceKey',case when amount>0 then lot->>'debtorId' else lot->>'creditorId' end,
   case when amount>0 then lot->>'creditorId' else lot->>'debtorId' end,abs(amount),lot->'priority',lot->>'id');
 when 'reverse-settlement' then
  previous:=s->'settlements'->(op->>'settlementId');
  if previous is null or (previous->>'reversed')::boolean then raise exception 'invalid-settlement-reversal'; end if;
  s:=jsonb_set(s,array['settlements',op->>'settlementId','reversed'],'true');
  select s->'lots'->(x->>'lotId')->'priority' into priority from jsonb_array_elements(previous->'claim'->'path') x
   order by (s->'lots'->(x->>'lotId')->'priority'->>'at')::bigint,(s->'lots'->(x->>'lotId')->'priority'->>'sequence')::bigint,s->'lots'->(x->>'lotId')->'priority'->>'lotId' COLLATE "C" limit 1;
  s:=duty_private.compensation_lot(s,e,e->>'sourceKey',previous->'claim'->>'debtorId',previous->'claim'->>'creditorId',(previous->>'units')::bigint,priority,previous->>'id');
 when 'release' then
  c:=s->'contributions'->(op->>'contributionId');
  if c is null or c->>'status' not in ('pending','held') then raise exception 'invalid-release'; end if;
  s:=jsonb_set(s,array['contributions',op->>'contributionId','status'],'"cancelled"');
 when 'publication' then
  result:=duty_private.compensation_transition(s,e); s:=result->'state'; finish:=result;
 when 'earned','hold' then
  key:=op->>'contributionId'; c:=s->'contributions'->key;
  if c is null or c->>'status'<>'pending' or (c->>'endInstantMs')::bigint>(e->>'at')::bigint then raise exception 'unearned-settlement'; end if;
  if not coalesce((s->'members'->(c->'claim'->>'debtorId')->>'active')::boolean,false) or not coalesce((s->'members'->(c->'claim'->>'creditorId')->>'active')::boolean,false) then p:='"inactive"';
  elsif duty_private.compensation_locate(s,c->'claim') is null then p:='"claim-changed"'; else p:=null; end if;
  if kind='earned' then
   if p is not null then raise exception 'unearned-settlement'; end if;
   s:=jsonb_set(s,array['contributions',key],c||jsonb_build_object('status','settled','settlementId',e->'sourceKey'));
   s:=duty_private.compensation_consume(s,c->'claim',(c->'capacity'->>'units')::bigint,e->>'sourceKey',key);
  else
   if p is distinct from op->'reason' then raise exception 'invalid-hold'; end if;
   s:=jsonb_set(s,array['contributions',key],c||jsonb_build_object('status','held','holdReason',p));
  end if;
 else raise exception 'unknown-operation';
 end case;
 result:=duty_private.compensation_normalize(s->'claims',s->'members');
 s:=jsonb_set(jsonb_set(s,'{claims}',result->'claims'),'{normalizations}',(s->'normalizations')||(result->'steps'));
 for key,c in select * from jsonb_each(s->'contributions') loop
  if c->>'status'='pending' and duty_private.compensation_locate(s,c->'claim') is null then
   s:=jsonb_set(s,array['contributions',key],c||'{"status":"held","holdReason":"claim-changed"}');
  end if;
 end loop;
 if finish is not null then s:=duty_private.compensation_reserve(s,e,finish); end if;
 return jsonb_set(s,'{events}',(s->'events')||jsonb_build_array(e));
end $$;


-- Source: schemas/functions/duty_private/compensation_atoms.sql
CREATE OR REPLACE FUNCTION duty_private.compensation_atoms(p jsonb) RETURNS jsonb
 LANGUAGE plpgsql STABLE SET search_path TO '' AS $$
#variable_conflict use_column
declare result jsonb:='{}'::jsonb; d jsonb; first_day date; end_day date; day date; amount bigint; combined boolean; finish bigint;
begin
 if p is null or p='null'::jsonb then return result; end if;
 for d in select value from jsonb_array_elements(p->'duties') order by value->>'startDate' loop
  first_day:=(d->>'startDate')::date; end_day:=(d->>'endDate')::date; amount:=duty_private.compensation_units(d->'units',true);
  combined:=extract(dow from first_day)=5 and end_day=first_day+2;
  if duty_private.duty_owner(first_day)<>p->>'month' or (not combined and end_day<>first_day+1) or (combined and amount<>2)
   or (not combined and (amount<(case when extract(dow from first_day) in (5,6) then 1 else 2 end) or amount>(case when extract(dow from first_day) in (5,6) then 41 else 42 end))) then raise exception 'invalid-published-duty'; end if;
  finish:=(extract(epoch from ((end_day+time '09:00') at time zone 'Asia/Jerusalem'))*1000)::bigint;
  for day in select generate_series(first_day,end_day-1,interval '1 day')::date loop
   if result ? day::text then raise exception 'overlapping-published-duty'; end if;
   result:=result||jsonb_build_object(day::text,jsonb_build_object('date',day,'units',case when combined then 1 else amount end,'primaryId',d->'primaryId','endInstantMs',finish));
  end loop;
 end loop;
 return result;
end $$;


-- Source: schemas/functions/duty_private/compensation_consume.sql
CREATE OR REPLACE FUNCTION duty_private.compensation_consume(s jsonb, ref jsonb, amount bigint, settlement text DEFAULT NULL, contribution text DEFAULT NULL) RETURNS jsonb
 LANGUAGE plpgsql STABLE SET search_path TO '' AS $$
#variable_conflict use_column
declare part jsonb; edge jsonb; claims jsonb; off bigint; tail bigint; p jsonb; remaining bigint; entry jsonb;
begin
 part:=duty_private.compensation_slice(ref,amount); edge:=duty_private.compensation_locate(s,part);
 if edge is null then raise exception 'claim-no-longer-outstanding'; end if;
 off:=(part->'path'->0->>'offset')::bigint-(edge->'path'->0->>'offset')::bigint;
 select coalesce(jsonb_agg(c),'[]') into claims from jsonb_array_elements(s->'claims') c where c<>edge;
 if off>0 then claims:=claims||jsonb_build_array(duty_private.compensation_segment(duty_private.compensation_slice(edge,off),edge->'priority',(edge->>'frozen')::boolean)); end if;
 tail:=(edge->>'units')::bigint-off-amount;
 if tail>0 then claims:=claims||jsonb_build_array(duty_private.compensation_segment(duty_private.compensation_slice(edge,tail,off+amount),edge->'priority',(edge->>'frozen')::boolean)); end if;
 s:=jsonb_set(s,'{claims}',claims);
 for p in select value from jsonb_array_elements(part->'path') loop
  remaining:=(s->'lots'->(p->>'lotId')->>'remaining')::bigint;
  if remaining is null or remaining<amount then raise exception 'source-over-settlement'; end if;
  s:=jsonb_set(s,array['lots',p->>'lotId','remaining'],to_jsonb(remaining-amount));
 end loop;
 if settlement is not null then
  if s->'settlements' ? settlement then raise exception 'duplicate-settlement'; end if;
  entry:=jsonb_build_object('id',settlement,'claim',part,'units',amount,'reversed',false);
  if contribution is not null then entry:=entry||jsonb_build_object('contributionId',contribution); end if;
  s:=jsonb_set(s,array['settlements',settlement],entry);
 end if;
 return s;
end $$;


-- Source: schemas/functions/duty_private/compensation_exclude.sql
CREATE OR REPLACE FUNCTION duty_private.compensation_exclude(excluded jsonb, cap jsonb) RETURNS jsonb
 LANGUAGE plpgsql STABLE SET search_path TO '' AS $$
#variable_conflict use_column
declare off bigint:=duty_private.compensation_units(cap->'offset'); n bigint:=duty_private.compensation_units(cap->'units',true); k text:=cap->>'date'; cells jsonb;
begin
 select jsonb_agg(i) into cells from generate_series(off,off+n-1) i;
 if exists(select 1 from jsonb_array_elements(coalesce(excluded->k,'[]')) a join jsonb_array_elements(cells) b on a=b) then raise exception 'overlapping-accounting-capacity'; end if;
 return excluded||jsonb_build_object(k,coalesce(excluded->k,'[]')||cells);
end $$;


-- Source: schemas/functions/duty_private/compensation_immutable.sql
CREATE OR REPLACE FUNCTION duty_private.compensation_immutable() RETURNS trigger
 LANGUAGE plpgsql SET search_path TO '' AS $$
#variable_conflict use_column
begin
 raise exception 'Compensation audit history is append-only' using errcode='42501';
end $$;


-- Source: schemas/functions/duty_private/compensation_locate.sql
CREATE OR REPLACE FUNCTION duty_private.compensation_locate(s jsonb, ref jsonb) RETURNS jsonb
 LANGUAGE plpgsql STABLE SET search_path TO '' AS $$
#variable_conflict use_column
declare checked jsonb;
begin
 checked:=duty_private.compensation_segment(ref,'{"at":0,"sequence":0,"lotId":"reference"}');
 return (select c from jsonb_array_elements(s->'claims') c where c->>'debtorId'=checked->>'debtorId' and c->>'creditorId'=checked->>'creditorId'
  and jsonb_array_length(c->'path')=jsonb_array_length(checked->'path') and not exists(
   select 1 from jsonb_array_elements(checked->'path') with ordinality a(p,i) where p->>'lotId'<>c->'path'->(i::int-1)->>'lotId'
    or (p->>'offset')::bigint<(c->'path'->(i::int-1)->>'offset')::bigint
    or (p->>'offset')::bigint+(p->>'units')::bigint>(c->'path'->(i::int-1)->>'offset')::bigint+(c->>'units')::bigint
    or (p->>'offset')::bigint-(c->'path'->(i::int-1)->>'offset')::bigint<>(checked->'path'->0->>'offset')::bigint-(c->'path'->0->>'offset')::bigint) limit 1);
end $$;


-- Source: schemas/functions/duty_private/compensation_lot.sql
CREATE OR REPLACE FUNCTION duty_private.compensation_lot(s jsonb, e jsonb, id text, debtor text, creditor text, amount bigint, priority jsonb DEFAULT NULL, correction text DEFAULT NULL) RETURNS jsonb
 LANGUAGE plpgsql STABLE SET search_path TO '' AS $$
#variable_conflict use_column
declare ref jsonb; lot jsonb;
begin
 perform duty_private.compensation_units(to_jsonb(amount),true);
 if debtor is null or creditor is null or not (s->'members' ? debtor) or not (s->'members' ? creditor) or debtor=creditor then raise exception 'invalid-endpoints'; end if;
 if s->'lots' ? id then raise exception 'duplicate-lot'; end if;
 priority:=coalesce(priority,jsonb_build_object('at',e->'at','sequence',e->'sequence','lotId',id));
 lot:=jsonb_build_object('id',id,'debtorId',debtor,'creditorId',creditor,'units',amount,'remaining',amount,'correctedUnits',amount,'priority',priority,'sourceKey',e->'sourceKey');
 if correction is not null then lot:=lot||jsonb_build_object('correctionOf',correction); end if;
 ref:=jsonb_build_object('debtorId',debtor,'creditorId',creditor,'path',jsonb_build_array(jsonb_build_object('lotId',id,'offset',0,'units',amount)));
 return jsonb_set(jsonb_set(s,array['lots',id],lot),'{claims}',(s->'claims')||jsonb_build_array(duty_private.compensation_segment(ref,priority)));
end $$;


-- Source: schemas/functions/duty_private/compensation_members.sql
CREATE OR REPLACE FUNCTION duty_private.compensation_members() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
#variable_conflict use_column
begin
 if TG_OP='UPDATE' and (old.active and old.status='approved')=(new.active and new.status='approved') then return new; end if;
 -- Updates run BEFORE the row changes: due work earns under the old state.
 -- The pending member created by onboarding has zero balance and no authority.
 perform duty_private.compensation_record(jsonb_build_object('kind','members','members',jsonb_build_array(
  jsonb_build_object('id',new.id,'active',new.active and new.status='approved'))),'members/'||gen_random_uuid());
 return new;
end $$;


-- Source: schemas/functions/duty_private/compensation_normalize.sql
-- Incremental graph normalization, in the same priority/DFS/Kahn order as PR #33.
CREATE OR REPLACE FUNCTION duty_private.compensation_normalize(claims jsonb, members jsonb) RETURNS jsonb
 LANGUAGE plpgsql STABLE SET search_path TO '' AS $$
#variable_conflict use_column
declare edges jsonb:='[]'::jsonb; steps jsonb:='[]'::jsonb; e jsonb; a jsonb; b jsonb; part jsonb; paths jsonb;
 ids integer[]; i integer; j integer; amount bigint; vertices text[]; ordered text[]:=ARRAY[]::text[]; v text;
begin
 for e in select value from jsonb_array_elements(claims) loop
  edges:=edges||jsonb_build_array(duty_private.compensation_segment(e,e->'priority',
   not coalesce((members->(e->>'debtorId')->>'active')::boolean,false) or not coalesce((members->(e->>'creditorId')->>'active')::boolean,false)));
 end loop;
 if exists(select 1 from jsonb_array_elements(edges) with ordinality a(x,i),jsonb_array_elements(edges) with ordinality b(y,j),
  jsonb_array_elements(x->'path') p,jsonb_array_elements(y->'path') q where i<j and p->>'lotId'=q->>'lotId'
  and (p->>'offset')::bigint<(q->>'offset')::bigint+(q->>'units')::bigint and (q->>'offset')::bigint<(p->>'offset')::bigint+(p->>'units')::bigint) then raise exception 'overlapping-source-slices'; end if;
 -- Keep the live array sorted. Array ordinality is stable between selection/take.
 select coalesce(jsonb_agg(x order by (x->'priority'->>'at')::bigint,(x->'priority'->>'sequence')::bigint,
  x->'priority'->>'lotId' COLLATE "C",x->>'id' COLLATE "C"),'[]') into edges from jsonb_array_elements(edges) x;
 loop
  ids:=null;
  select array[aa.i::int-1,bb.i::int-1] into ids from jsonb_array_elements(edges) with ordinality aa(x,i)
   cross join jsonb_array_elements(edges) with ordinality bb(y,i)
   where not (x->>'frozen')::boolean and not (y->>'frozen')::boolean and (x->>'units')::bigint>0 and (y->>'units')::bigint>0
   and x->>'debtorId'=y->>'creditorId' and x->>'creditorId'=y->>'debtorId' order by aa.i,bb.i limit 1;
  exit when ids is null;
  amount:=least((edges->ids[1]->>'units')::bigint,(edges->ids[2]->>'units')::bigint); paths:='[]';
  foreach i in array ids loop
   e:=edges->i; paths:=paths||jsonb_build_array(duty_private.compensation_slice(e,amount)->'path');
   if (e->>'units')::bigint=amount then edges:=jsonb_set(edges,array[i::text,'units'],'0');
   else edges:=jsonb_set(edges,array[i::text],duty_private.compensation_segment(duty_private.compensation_slice(e,(e->>'units')::bigint-amount,amount),e->'priority')); end if;
  end loop;
  steps:=steps||jsonb_build_array(jsonb_build_object('kind','opposing','units',amount,'paths',paths));
 end loop;
 loop
  -- Enumerate sorted DFS walks. The first closed path has exactly the core DFS
  -- cycle order; prefix edges before its repeated vertex are not consumed.
  with recursive live as (select x,i::int-1 idx from jsonb_array_elements(edges) with ordinality a(x,i) where (x->>'units')::bigint>0 and not (x->>'frozen')::boolean),
  walks(vertex,visited,route,sortkey,cycle) as (
   select v,array[v],array[]::integer[],array[v]::text[],false from (select x->>'debtorId' v from live union select x->>'creditorId' from live) vs
   union all
   select l.x->>'creditorId',w.visited||(l.x->>'creditorId'),w.route||l.idx,
    w.sortkey||array[l.x->>'creditorId',lpad(l.idx::text,12,'0')],(l.x->>'creditorId')=any(w.visited)
   from walks w join live l on l.x->>'debtorId'=w.vertex where not w.cycle
  ) select route[array_position(visited,vertex):array_length(route,1)] into ids from walks where cycle order by sortkey COLLATE "C" limit 1;
  exit when ids is null;
  select min((edges->n->>'units')::bigint) into amount from unnest(ids) n; paths:='[]';
  foreach i in array ids loop
   e:=edges->i; paths:=paths||jsonb_build_array(duty_private.compensation_slice(e,amount)->'path');
   if (e->>'units')::bigint=amount then edges:=jsonb_set(edges,array[i::text,'units'],'0');
   else edges:=jsonb_set(edges,array[i::text],duty_private.compensation_segment(duty_private.compensation_slice(e,(e->>'units')::bigint-amount,amount),e->'priority')); end if;
  end loop;
  steps:=steps||jsonb_build_array(jsonb_build_object('kind','cycle','units',amount,'paths',paths));
 end loop;
 select array_agg(v order by v COLLATE "C") into vertices from (
  select x->>'debtorId' v from jsonb_array_elements(edges) x where (x->>'units')::bigint>0 and not (x->>'frozen')::boolean union
  select x->>'creditorId' from jsonb_array_elements(edges) x where (x->>'units')::bigint>0 and not (x->>'frozen')::boolean) a;
 while cardinality(ordered)<coalesce(cardinality(vertices),0) loop
  select node into v from unnest(vertices) node where not node=any(ordered) and not exists(
   select 1 from jsonb_array_elements(edges) x where (x->>'units')::bigint>0 and not (x->>'frozen')::boolean and x->>'creditorId'=node and not (x->>'debtorId')=any(ordered)) order by node COLLATE "C" limit 1;
  if v is null then raise exception 'normalization-cycle'; end if;
  ordered:=ordered||v;
 end loop;
 foreach v in array ordered loop
  loop
   select x,i::int-1 into a,i from jsonb_array_elements(edges) with ordinality q(x,i) where (x->>'units')::bigint>0 and not (x->>'frozen')::boolean and x->>'creditorId'=v
    order by (x->'priority'->>'at')::bigint,(x->'priority'->>'sequence')::bigint,x->'priority'->>'lotId' COLLATE "C",x->>'id' COLLATE "C" limit 1;
   select x,i::int-1 into b,j from jsonb_array_elements(edges) with ordinality q(x,i) where (x->>'units')::bigint>0 and not (x->>'frozen')::boolean and x->>'debtorId'=v
    order by (x->'priority'->>'at')::bigint,(x->'priority'->>'sequence')::bigint,x->'priority'->>'lotId' COLLATE "C",x->>'id' COLLATE "C" limit 1;
   exit when a is null or b is null;
   amount:=least((a->>'units')::bigint,(b->>'units')::bigint);
   paths:=jsonb_build_array(duty_private.compensation_slice(a,amount)->'path',duty_private.compensation_slice(b,amount)->'path');
   foreach i in array array[i,j] loop
    e:=edges->i;
    if (e->>'units')::bigint=amount then edges:=jsonb_set(edges,array[i::text,'units'],'0');
    else edges:=jsonb_set(edges,array[i::text],duty_private.compensation_segment(duty_private.compensation_slice(e,(e->>'units')::bigint-amount,amount),e->'priority')); end if;
   end loop;
   select x->'priority' into part from jsonb_array_elements(jsonb_build_array(a,b)) x order by (x->'priority'->>'at')::bigint,(x->'priority'->>'sequence')::bigint,x->'priority'->>'lotId' COLLATE "C" limit 1;
   edges:=edges||jsonb_build_array(duty_private.compensation_segment(jsonb_build_object('debtorId',a->'debtorId','creditorId',b->'creditorId','path',(paths->0)||(paths->1)),part));
   steps:=steps||jsonb_build_array(jsonb_build_object('kind','chain','units',amount,'paths',paths));
  end loop;
 end loop;
 select coalesce(jsonb_agg(x order by (x->'priority'->>'at')::bigint,(x->'priority'->>'sequence')::bigint,x->'priority'->>'lotId' COLLATE "C",x->>'id' COLLATE "C"),'[]') into edges from jsonb_array_elements(edges) x where (x->>'units')::bigint>0;
 return jsonb_build_object('claims',edges,'steps',steps);
end $$;


-- Source: schemas/functions/duty_private/compensation_now.sql
CREATE OR REPLACE FUNCTION duty_private.compensation_now() RETURNS bigint
 LANGUAGE sql VOLATILE SET search_path TO '' AS $$
 select floor(extract(epoch from clock_timestamp())*1000)::bigint;
$$;


-- Source: schemas/functions/duty_private/compensation_publication.sql
CREATE OR REPLACE FUNCTION duty_private.compensation_publication(month text, publication uuid, metadata jsonb DEFAULT NULL, deleting boolean DEFAULT false) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
#variable_conflict use_column
declare s jsonb; before_pub jsonb; after_pub jsonb; op jsonb; atoms jsonb; old_atoms jsonb; reservations jsonb; instant bigint; known jsonb;
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
 perform duty_private.compensation_append(s,op,'publication/'||gen_random_uuid(),instant,coalesce(auth.uid()::text,'system'));
end $$;


-- Source: schemas/functions/duty_private/compensation_reconcile.sql
CREATE OR REPLACE FUNCTION duty_private.compensation_reconcile(s jsonb, instant bigint, persist boolean DEFAULT true) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
#variable_conflict use_column
declare c jsonb; reason text; kind text; op jsonb; key text; e jsonb;
begin
 for c in select value from jsonb_each(s->'contributions') where value->>'status'='pending' and (value->>'endInstantMs')::bigint<=instant
  order by (value->>'endInstantMs')::bigint,value->>'id' COLLATE "C" loop
  if s->'contributions'->(c->>'id')->>'status'<>'pending' then continue; end if;
  reason:=null;
  if not coalesce((s->'members'->(c->'claim'->>'debtorId')->>'active')::boolean,false) or not coalesce((s->'members'->(c->'claim'->>'creditorId')->>'active')::boolean,false) then reason:='inactive';
  elsif duty_private.compensation_locate(s,c->'claim') is null then reason:='claim-changed'; end if;
  kind:=case when reason is null then 'earned' else 'hold' end; key:='@'||kind||'/'||(c->>'id');
  op:=jsonb_build_object('kind',kind,'contributionId',c->'id');
  if reason is not null then op:=op||jsonb_build_object('reason',reason); end if;
  if persist then s:=duty_private.compensation_append(s,op,key,instant,'system');
  else
   e:=jsonb_build_object('sequence',coalesce((s->'events'->-1->>'sequence')::bigint,0)+1,'sourceKey',key,'at',instant,'actor','system','operation',op);
   s:=duty_private.compensation_apply(s,e);
  end if;
 end loop;
 return s;
end $$;


-- Source: schemas/functions/duty_private/compensation_record.sql
-- Internal fact writer. All call sites already hold the workspace lock; take it
-- here too so migrations/triggers have the same ordering and post-lock clock.
CREATE OR REPLACE FUNCTION duty_private.compensation_record(op jsonb, key text, reason text DEFAULT NULL) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
#variable_conflict use_column
declare s jsonb; instant bigint;
begin
 perform 1 from public.duty_workspace where id for update;
 s:=duty_private.compensation_state();
 instant:=greatest(duty_private.compensation_now(),coalesce((s->'events'->-1->>'at')::bigint,0));
 s:=duty_private.compensation_reconcile(s,instant);
 return duty_private.compensation_append(s,op,key,instant,coalesce(auth.uid()::text,'system'),reason);
end $$;


-- Source: schemas/functions/duty_private/compensation_reserve.sql
CREATE OR REPLACE FUNCTION duty_private.compensation_reserve(s jsonb, e jsonb, finish jsonb) RETURNS jsonb
 LANGUAGE plpgsql STABLE SET search_path TO '' AS $$
#variable_conflict use_column
declare key text; r jsonb; existing jsonb; atom jsonb; excluded jsonb:=finish->'excluded'; claim jsonb; historical boolean; carried boolean;
begin
 for key,r in select * from jsonb_each(finish->'proposed') order by key COLLATE "C" loop
  existing:=s->'contributions'->key; atom:=finish->'atoms'->(r->'capacity'->>'date');
  select exists(select 1 from jsonb_array_elements(coalesce(finish->'before'->'reservations','[]')) p where p->>'id'=key) into carried;
  if existing is not null then
   historical:=e->'operation'->>'mode'='delete' and existing->>'status' in ('cancelled','settled');
   if (not carried and not coalesce(historical,false)) or jsonb_build_object('id',existing->'id','capacity',existing->'capacity','claim',existing->'claim')<>r then raise exception 'reused-contribution'; end if;
  else
   if (atom->>'endInstantMs')::bigint<=(e->>'at')::bigint then raise exception 'reservation-already-completed'; end if;
   excluded:=duty_private.compensation_exclude(excluded,r->'capacity');
   claim:=duty_private.compensation_locate(s,r->'claim');
   if claim is null or (claim->>'frozen')::boolean or r->'capacity'->'units'<>r->'claim'->'path'->0->'units' then raise exception 'invalid-reservation-claim'; end if;
   if exists(select 1 from jsonb_each(s->'contributions') c,jsonb_array_elements(c.value->'claim'->'path') a,jsonb_array_elements(r->'claim'->'path') b
    where c.value->>'status' in ('pending','held') and a->>'lotId'=b->>'lotId' and (a->>'offset')::bigint<(b->>'offset')::bigint+(b->>'units')::bigint and (b->>'offset')::bigint<(a->>'offset')::bigint+(a->>'units')::bigint) then raise exception 'claim-already-reserved'; end if;
   s:=jsonb_set(s,array['contributions',key],r||jsonb_build_object('endInstantMs',atom->'endInstantMs','status','pending'));
  end if;
  if carried and s->'contributions'->key->>'status' in ('pending','held') then excluded:=duty_private.compensation_exclude(excluded,r->'capacity'); end if;
 end loop;
 return s;
end $$;


-- Source: schemas/functions/duty_private/compensation_segment.sql
CREATE OR REPLACE FUNCTION duty_private.compensation_segment(c jsonb, priority jsonb, frozen boolean DEFAULT false) RETURNS jsonb
 LANGUAGE plpgsql STABLE SET search_path TO '' AS $$
#variable_conflict use_column
declare p jsonb; n bigint;
begin
 if jsonb_typeof(c->'path') IS DISTINCT FROM 'array' or jsonb_array_length(c->'path')=0
  or coalesce(c->>'debtorId','')='' or coalesce(c->>'creditorId','')='' or c->>'debtorId'=c->>'creditorId' then raise exception 'invalid-path'; end if;
 n:=duty_private.compensation_units(c->'path'->0->'units',true);
 for p in select value from jsonb_array_elements(c->'path') loop
  if coalesce(p->>'lotId','')='' or duty_private.compensation_units(p->'offset')+duty_private.compensation_units(p->'units',true)>1000000000
   or (p->>'units')::bigint<>n then raise exception 'invalid-path'; end if;
 end loop;
 if exists(select 1 from jsonb_array_elements(c->'path') with ordinality a(x,i),jsonb_array_elements(c->'path') with ordinality b(y,j)
  where i<j and x->>'lotId'=y->>'lotId' and (x->>'offset')::bigint<(y->>'offset')::bigint+n and (y->>'offset')::bigint<(x->>'offset')::bigint+n) then raise exception 'invalid-path'; end if;
 c:=duty_private.compensation_slice(c,n);
 -- Compact JSON matches the core's claim identifier (JSON.stringify of arrays).
 return c||jsonb_build_object('units',n,'priority',priority,'frozen',frozen,'id',
  '['||to_jsonb(c->>'debtorId')::text||','||to_jsonb(c->>'creditorId')::text||',['||
  (select string_agg('['||to_jsonb(p->>'lotId')::text||','||(p->>'offset')||','||(p->>'units')||']',',' order by i)
   from jsonb_array_elements(c->'path') with ordinality a(p,i))||']]');
end $$;


-- Source: schemas/functions/duty_private/compensation_slice.sql
CREATE OR REPLACE FUNCTION duty_private.compensation_slice(c jsonb, amount bigint, off bigint DEFAULT 0) RETURNS jsonb
 LANGUAGE plpgsql STABLE SET search_path TO '' AS $$
#variable_conflict use_column
begin
 if amount<=0 or off<0 or off+amount>(c->'path'->0->>'units')::bigint then raise exception 'claim-slice-out-of-range'; end if;
 return jsonb_build_object('debtorId',c->'debtorId','creditorId',c->'creditorId','path',
  (select jsonb_agg(jsonb_build_object('lotId',p->'lotId','offset',(p->>'offset')::bigint+off,'units',amount) order by i)
   from jsonb_array_elements(c->'path') with ordinality a(p,i)));
end $$;


-- Source: schemas/functions/duty_private/compensation_snapshot.sql
-- Accounting snapshots exclude secondary cover, titles and private notes.
CREATE OR REPLACE FUNCTION duty_private.compensation_snapshot(publication uuid) RETURNS jsonb
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $$
 select jsonb_build_object('id',p.id,'month',p.month,'intents','[]'::jsonb,'reservations','[]'::jsonb,'duties',coalesce(
  (select jsonb_agg(jsonb_build_object('startDate',a.day,'endDate',a.end_day,'primaryId',a.primary_id,'units',a.points*2) order by a.day)
   from public.duty_assignments a where a.publication_id=p.id and duty_private.duty_owner(a.day)=p.month),'[]'::jsonb))
 from public.duty_publications p where p.id=publication;
$$;


-- Source: schemas/functions/duty_private/compensation_state.sql
CREATE OR REPLACE FUNCTION duty_private.compensation_state() RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
#variable_conflict use_column
declare s jsonb:='{"events":[],"members":{},"lots":{},"claims":[],"contributions":{},"settlements":{},"publications":{},"intents":{},"normalizations":[]}'::jsonb; e record;
begin
 for e in select * from public.duty_compensation_events order by sequence loop
  s:=duty_private.compensation_apply(s,jsonb_build_object('sequence',e.sequence,'sourceKey',e.source_key,'at',e.at,'actor',e.actor,'operation',e.operation)
   ||case when e.reason is null then '{}'::jsonb else jsonb_build_object('reason',e.reason) end);
 end loop;
 return s;
end $$;


-- Source: schemas/functions/duty_private/compensation_transition.sql
CREATE OR REPLACE FUNCTION duty_private.compensation_transition(s jsonb, e jsonb) RETURNS jsonb
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


-- Source: schemas/functions/duty_private/compensation_units.sql
CREATE OR REPLACE FUNCTION duty_private.compensation_units(v jsonb, positive boolean DEFAULT false) RETURNS bigint
 LANGUAGE plpgsql IMMUTABLE SET search_path TO '' AS $$
#variable_conflict use_column
declare n numeric;
begin
 if jsonb_typeof(v) IS DISTINCT FROM 'number' then raise exception 'invalid-units'; end if;
 n:=v::numeric;
 if n<>trunc(n) or n<(case when positive then 1 else 0 end) or n>1000000000 then raise exception 'invalid-units'; end if;
 return n::bigint;
end $$;


-- Source: schemas/functions/duty_private/compensation_view.sql
CREATE OR REPLACE FUNCTION duty_private.compensation_view(s jsonb) RETURNS jsonb
 LANGUAGE sql STABLE SET search_path TO '' AS $$
 select jsonb_build_object('events',s->'events','claims',s->'claims','normalizations',s->'normalizations',
  'members',coalesce((select jsonb_agg(value order by key COLLATE "C") from jsonb_each(s->'members')),'[]'),
  'lots',coalesce((select jsonb_agg(value order by (value->'priority'->>'sequence')::bigint,key COLLATE "C") from jsonb_each(s->'lots')),'[]'),
  'contributions',coalesce((select jsonb_agg(value order by key COLLATE "C") from jsonb_each(s->'contributions')),'[]'),
  'settlements',coalesce((select jsonb_agg(value order by key COLLATE "C") from jsonb_each(s->'settlements')),'[]'),
  'publications',coalesce((select jsonb_agg(value order by key COLLATE "C") from jsonb_each(s->'publications')),'[]'),
  'net',coalesce((select jsonb_object_agg(id,net) from (
   select key id,coalesce((select sum(case when c->>'creditorId'=key then (c->>'units')::bigint else -(c->>'units')::bigint end)
    from jsonb_array_elements(s->'claims') c where key in (c->>'debtorId',c->>'creditorId')),0) net from jsonb_each(s->'members')) n),'{}'));
$$;


-- Source: schemas/functions/public/duty_compensation.sql
CREATE OR REPLACE FUNCTION public.duty_compensation(p_operation jsonb, p_source_key text, p_reason text, p_revision bigint, p_fingerprint text DEFAULT NULL, p_cutoff bigint DEFAULT NULL) RETURNS jsonb
 LANGUAGE sql SET search_path TO '' AS $$
 select duty_private.compensation(p_operation,p_source_key,p_reason,p_revision,p_fingerprint,p_cutoff);
$$;


-- Source: schemas/policies/duty_compensation_events.sql
CREATE POLICY duty_compensation_manager_read ON public.duty_compensation_events FOR SELECT TO authenticated USING ((SELECT duty_private.is_manager()));


-- Source: schemas/functions/duty_private/reconcile_publication_swaps.sql
CREATE OR REPLACE FUNCTION duty_private.reconcile_publication_swaps() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
 perform 1 from public.duty_workspace where id for update;
 perform duty_private.compensation_publication(new.month,new.current_publication_id,NULL,
  old.current_publication_id is not null and (new.current_publication_id is null or
   (select version from public.duty_publications where id=new.current_publication_id)<(select version from public.duty_publications where id=old.current_publication_id)));
 perform duty_private.reconcile_swaps(new.month);
 return new;
end $$;


-- Source: schemas/functions/duty_private/save_schedule.sql
CREATE OR REPLACE FUNCTION duty_private.save_schedule(p_state jsonb, p_revision bigint, p_publish text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare x record; item jsonb; d date; a public.duty_assignments; m public.duty_months; first_day date; last_day date; publication uuid; next_version integer;
begin
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 perform duty_private.check_revision(p_revision);
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 if jsonb_typeof(p_state->'duties') is distinct from 'array' or jsonb_typeof(p_state->'months') is distinct from 'object' or jsonb_typeof(p_state->'team') is distinct from 'array' or length(p_state::text)>2000000 then raise exception 'Invalid schedule'; end if;
 for x in select value,ordinality from jsonb_array_elements(p_state->'team') with ordinality loop
  -- Profile names and roles have separate checked operations.
  update public.duty_members set color=x.value->>'color',active=(x.value->>'active')::boolean,seniority=x.ordinality where id=(x.value->>'id')::uuid and status='approved';
  if not found then raise exception 'Unknown approved team member'; end if;
 end loop;
 perform duty_private.assert_admin_remains();
 for x in select * from jsonb_each(p_state->'months') loop
  select * into m from public.duty_months where month=x.key;
  if m.status='published' and (x.value->>'status'='draft' or p_publish=x.key) then raise exception 'Reopen the draft first'; end if;
  if x.value->>'status'='published' and coalesce(m.status,'draft')='draft' and p_publish is distinct from x.key then raise exception 'Use Publish to publish a draft'; end if;
  insert into public.duty_months(month,deadline,generated) values(x.key,(x.value->>'deadline')::date,coalesce((x.value->>'generated')::boolean,false))
  on conflict(month) do update set deadline=excluded.deadline,generated=case when duty_months.status='published' then true else excluded.generated end;
 end loop;
 -- A scoped save cannot erase drafts omitted from the request or materialize a
 -- published schedule as working rows. Status transitions use checked operations.
 delete from public.duty_assignments working where working.publication_id is null
 and p_state->'months' ? duty_private.duty_owner(working.day)
 and exists(select 1 from public.duty_months owning where owning.month=duty_private.duty_owner(working.day) and owning.status='draft')
 and working.day not in (select (value->>'day')::date from jsonb_array_elements(p_state->'duties'));
 for item in select value from jsonb_array_elements(p_state->'duties') loop
  if not (p_state->'months' ? duty_private.duty_owner((item->>'day')::date)) or not exists(select 1 from public.duty_months where month=duty_private.duty_owner((item->>'day')::date) and status='draft') then raise exception 'Duty requires its owning month draft'; end if;
  insert into public.duty_assignments(day,end_day,primary_id,secondary_id,manager_override,title,extra_points)
  values((item->>'day')::date,(item->>'end_day')::date,nullif(item->>'primary_id','')::uuid,nullif(item->>'secondary_id','')::uuid,coalesce((item->>'manager_override')::boolean,false),coalesce(item->>'title',''),coalesce((item->>'extra_points')::numeric,0))
  on conflict(publication_id,day) do update set end_day=excluded.end_day,primary_id=excluded.primary_id,secondary_id=excluded.secondary_id,manager_override=excluded.manager_override,title=excluded.title,extra_points=excluded.extra_points;
 end loop;
 if exists(select 1 from public.duty_assignments first_duty join public.duty_assignments other_duty on first_duty.day<other_duty.day and first_duty.end_day>other_duty.day where first_duty.publication_id is null and other_duty.publication_id is null) then raise exception 'Duty dates overlap'; end if;
 if p_publish is not null then
  if not (p_state->'months' ? p_publish) or not exists(select 1 from public.duty_months where month=p_publish and status='draft') then raise exception 'An open month draft is required'; end if;
  first_day:=(p_publish||'-01')::date; last_day:=(first_day+interval '1 month'-interval '1 day')::date;
  -- Validate only this month's owned dates, including its final Friday's Saturday.
  if extract(dow from first_day)=6 then first_day:=first_day+1; end if;
  if extract(dow from last_day)=5 then last_day:=last_day+1; end if;
  for d in select generate_series(first_day,last_day,interval '1 day')::date loop
   select * into a from public.duty_assignments where publication_id is null and day<=d and end_day>d;
   if a.primary_id is null or not exists(select 1 from public.duty_members where id=a.primary_id and status='approved' and active) then raise exception 'An active engineer is required on %',d; end if;
   if a.secondary_id is not null and not exists(select 1 from public.duty_members where id=a.secondary_id and status='approved' and active) then raise exception 'Emergency engineer is inactive on %',d; end if;
   if not a.manager_override and exists(select 1 from public.duty_constraints where member_id in (a.primary_id,a.secondary_id) and day=d and kind='no') then raise exception 'Availability conflict on %',d; end if;
  end loop;
  update public.duty_months set publication_sequence=publication_sequence+1 where month=p_publish returning publication_sequence into next_version;
  insert into public.duty_publications(month,version,published_by) values(p_publish,next_version,auth.uid()) returning id into publication;
  insert into public.duty_assignments(publication_id,day,end_day,primary_id,secondary_id,manager_override,title,extra_points)
  select publication,day,end_day,primary_id,secondary_id,manager_override,title,extra_points from public.duty_assignments where publication_id is null and duty_private.duty_owner(day)=p_publish;
  delete from public.duty_assignments where publication_id is null and duty_private.duty_owner(day)=p_publish;
  perform duty_private.compensation_publication(p_publish,publication,p_state->'compensation');
  update public.duty_months set current_publication_id=publication,status='published',generated=true where month=p_publish;
 end if;
 update public.duty_workspace set revision=revision+1 where id;
end $$;


-- Source: schemas/grants/functions.sql
REVOKE ALL ON FUNCTION duty_private.assert_admin_remains() FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION duty_private.check_revision(p_revision bigint) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION duty_private.current_duties() FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION duty_private.delete_publication(p_publication uuid, p_revision bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION duty_private.delete_publication(p_publication uuid, p_revision bigint) TO authenticated;

REVOKE ALL ON FUNCTION duty_private.duty_owner(p_day date) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION duty_private.is_manager() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION duty_private.is_manager() TO authenticated;

REVOKE ALL ON FUNCTION duty_private.is_member() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION duty_private.is_member() TO authenticated;

REVOKE ALL ON FUNCTION duty_private.join_team(p_name text) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION duty_private.join_team(p_name text) TO authenticated;

REVOKE ALL ON FUNCTION duty_private.reconcile_publication_swaps() FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION duty_private.reconcile_swaps(p_month text) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION duty_private.rename_self(p_name text, p_revision bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION duty_private.rename_self(p_name text, p_revision bigint) TO authenticated;

REVOKE ALL ON FUNCTION duty_private.request_swap(p_from uuid, p_to uuid, p_explanation text, p_revision bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION duty_private.request_swap(p_from uuid, p_to uuid, p_explanation text, p_revision bigint) TO authenticated;

REVOKE ALL ON FUNCTION duty_private.resolve_swap(p_request uuid, p_action text, p_revision bigint, p_override_reason text) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION duty_private.resolve_swap(p_request uuid, p_action text, p_revision bigint, p_override_reason text) TO authenticated;

REVOKE ALL ON FUNCTION duty_private.restore_publication(p_publication uuid, p_revision bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION duty_private.restore_publication(p_publication uuid, p_revision bigint) TO authenticated;

REVOKE ALL ON FUNCTION duty_private.review_member(p_member uuid, p_status text, p_revision bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION duty_private.review_member(p_member uuid, p_status text, p_revision bigint) TO authenticated;

REVOKE ALL ON FUNCTION duty_private.save_schedule(p_state jsonb, p_revision bigint, p_publish text) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION duty_private.save_schedule(p_state jsonb, p_revision bigint, p_publish text) TO authenticated;

REVOKE ALL ON FUNCTION duty_private.set_constraints(p_member uuid, p_days date[], p_kind text, p_note text, p_revision bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION duty_private.set_constraints(p_member uuid, p_days date[], p_kind text, p_note text, p_revision bigint) TO authenticated;

REVOKE ALL ON FUNCTION duty_private.set_role(p_member uuid, p_role text, p_revision bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION duty_private.set_role(p_member uuid, p_role text, p_revision bigint) TO authenticated;

REVOKE ALL ON FUNCTION duty_private.validate_swap(p_from uuid, p_to uuid, p_publication uuid, p_override boolean) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.duty_delete_publication(p_publication uuid, p_revision bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.duty_delete_publication(p_publication uuid, p_revision bigint) TO authenticated;
GRANT ALL ON FUNCTION public.duty_delete_publication(p_publication uuid, p_revision bigint) TO service_role;

REVOKE ALL ON FUNCTION public.duty_join(p_name text) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.duty_join(p_name text) TO authenticated;
GRANT ALL ON FUNCTION public.duty_join(p_name text) TO service_role;

REVOKE ALL ON FUNCTION public.duty_load() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.duty_load() TO authenticated;
GRANT ALL ON FUNCTION public.duty_load() TO service_role;

REVOKE ALL ON FUNCTION public.duty_rename_self(p_name text, p_revision bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.duty_rename_self(p_name text, p_revision bigint) TO authenticated;
GRANT ALL ON FUNCTION public.duty_rename_self(p_name text, p_revision bigint) TO service_role;

REVOKE ALL ON FUNCTION public.duty_request_swap(p_from uuid, p_to uuid, p_explanation text, p_revision bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.duty_request_swap(p_from uuid, p_to uuid, p_explanation text, p_revision bigint) TO service_role;
GRANT ALL ON FUNCTION public.duty_request_swap(p_from uuid, p_to uuid, p_explanation text, p_revision bigint) TO authenticated;

REVOKE ALL ON FUNCTION public.duty_resolve_swap(p_request uuid, p_action text, p_revision bigint, p_override_reason text) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.duty_resolve_swap(p_request uuid, p_action text, p_revision bigint, p_override_reason text) TO service_role;
GRANT ALL ON FUNCTION public.duty_resolve_swap(p_request uuid, p_action text, p_revision bigint, p_override_reason text) TO authenticated;

REVOKE ALL ON FUNCTION public.duty_restore_publication(p_publication uuid, p_revision bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.duty_restore_publication(p_publication uuid, p_revision bigint) TO authenticated;
GRANT ALL ON FUNCTION public.duty_restore_publication(p_publication uuid, p_revision bigint) TO service_role;

REVOKE ALL ON FUNCTION public.duty_review_member(p_member uuid, p_status text, p_revision bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.duty_review_member(p_member uuid, p_status text, p_revision bigint) TO authenticated;
GRANT ALL ON FUNCTION public.duty_review_member(p_member uuid, p_status text, p_revision bigint) TO service_role;

REVOKE ALL ON FUNCTION public.duty_save_schedule(p_state jsonb, p_revision bigint, p_publish text) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.duty_save_schedule(p_state jsonb, p_revision bigint, p_publish text) TO authenticated;
GRANT ALL ON FUNCTION public.duty_save_schedule(p_state jsonb, p_revision bigint, p_publish text) TO service_role;

REVOKE ALL ON FUNCTION public.duty_set_constraints(p_member uuid, p_days date[], p_kind text, p_note text, p_revision bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.duty_set_constraints(p_member uuid, p_days date[], p_kind text, p_note text, p_revision bigint) TO authenticated;
GRANT ALL ON FUNCTION public.duty_set_constraints(p_member uuid, p_days date[], p_kind text, p_note text, p_revision bigint) TO service_role;

REVOKE ALL ON FUNCTION public.duty_set_role(p_member uuid, p_role text, p_revision bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.duty_set_role(p_member uuid, p_role text, p_revision bigint) TO authenticated;
GRANT ALL ON FUNCTION public.duty_set_role(p_member uuid, p_role text, p_revision bigint) TO service_role;

REVOKE ALL ON FUNCTION duty_private.cancel_draft(text, bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION duty_private.cancel_draft(text, bigint) TO authenticated;
REVOKE ALL ON FUNCTION public.duty_cancel_draft(text, bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.duty_cancel_draft(text, bigint) TO authenticated, service_role;

-- Compensation persistence privileges.
REVOKE ALL ON FUNCTION duty_private.compensation(jsonb, text, text, bigint, text, bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION duty_private.compensation(jsonb, text, text, bigint, text, bigint) TO authenticated;
REVOKE ALL ON FUNCTION duty_private.compensation_append(jsonb, jsonb, text, bigint, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION duty_private.compensation_apply(jsonb, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION duty_private.compensation_atoms(jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION duty_private.compensation_consume(jsonb, jsonb, bigint, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION duty_private.compensation_exclude(jsonb, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION duty_private.compensation_immutable() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION duty_private.compensation_locate(jsonb, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION duty_private.compensation_lot(jsonb, jsonb, text, text, text, bigint, jsonb, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION duty_private.compensation_members() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION duty_private.compensation_normalize(jsonb, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION duty_private.compensation_now() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION duty_private.compensation_publication(text, uuid, jsonb, boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION duty_private.compensation_reconcile(jsonb, bigint, boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION duty_private.compensation_record(jsonb, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION duty_private.compensation_reserve(jsonb, jsonb, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION duty_private.compensation_segment(jsonb, jsonb, boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION duty_private.compensation_slice(jsonb, bigint, bigint) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION duty_private.compensation_snapshot(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION duty_private.compensation_state() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION duty_private.compensation_transition(jsonb, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION duty_private.compensation_units(jsonb, boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION duty_private.compensation_view(jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.duty_compensation(jsonb, text, text, bigint, text, bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.duty_compensation(jsonb, text, text, bigint, text, bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.duty_compensation(jsonb, text, text, bigint, text, bigint) TO service_role;


-- Source: schemas/grants/tables.sql
-- Client writes are permitted only through checked RPCs. Explicit grants override platform defaults.
REVOKE ALL ON TABLE public.duty_roles FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.duty_roles TO authenticated;
GRANT ALL ON TABLE public.duty_roles TO service_role;
REVOKE ALL ON TABLE public.duty_member_statuses FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.duty_member_statuses TO authenticated;
GRANT ALL ON TABLE public.duty_member_statuses TO service_role;
REVOKE ALL ON TABLE public.duty_month_statuses FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.duty_month_statuses TO authenticated;
GRANT ALL ON TABLE public.duty_month_statuses TO service_role;
REVOKE ALL ON TABLE public.duty_constraint_types FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.duty_constraint_types TO authenticated;
GRANT ALL ON TABLE public.duty_constraint_types TO service_role;
REVOKE ALL ON TABLE public.duty_members FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.duty_members TO authenticated;
GRANT ALL ON TABLE public.duty_members TO service_role;
REVOKE ALL ON TABLE public.duty_workspace FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.duty_workspace TO authenticated;
GRANT ALL ON TABLE public.duty_workspace TO service_role;
REVOKE ALL ON TABLE public.duty_months FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.duty_months TO authenticated;
GRANT ALL ON TABLE public.duty_months TO service_role;
REVOKE ALL ON TABLE public.duty_publications FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.duty_publications TO authenticated;
GRANT ALL ON TABLE public.duty_publications TO service_role;
REVOKE ALL ON TABLE public.duty_assignments FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.duty_assignments TO authenticated;
GRANT ALL ON TABLE public.duty_assignments TO service_role;
REVOKE ALL ON TABLE public.duty_constraints FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.duty_constraints TO authenticated;
GRANT ALL ON TABLE public.duty_constraints TO service_role;
REVOKE ALL ON TABLE public.duty_swap_requests FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.duty_swap_requests TO authenticated;
GRANT ALL ON TABLE public.duty_swap_requests TO service_role;

-- Compensation audit privileges. Even service_role cannot rewrite history.
REVOKE ALL ON TABLE public.duty_compensation_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.duty_compensation_events TO authenticated, service_role;


-- Source: schemas/triggers/duty_compensation.sql
-- AFTER INSERT excludes INSERT ... ON CONFLICT DO NOTHING retries. Updates run
-- BEFORE the participation change so earned work is reconciled before a freeze.
CREATE TRIGGER duty_compensation_member_insert AFTER INSERT ON public.duty_members
 FOR EACH ROW EXECUTE FUNCTION duty_private.compensation_members();
CREATE TRIGGER duty_compensation_member_update BEFORE UPDATE OF active,status ON public.duty_members
 FOR EACH ROW EXECUTE FUNCTION duty_private.compensation_members();
CREATE TRIGGER duty_compensation_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON public.duty_compensation_events
 FOR EACH STATEMENT EXECUTE FUNCTION duty_private.compensation_immutable();

-- Establish participation and current publication facts only. All balances start
-- at zero; no historical fairness import, resets, deletions or user changes.
DO $cutover$
declare members jsonb; p record;
begin
 perform 1 from public.duty_workspace where id for update;
 select jsonb_agg(jsonb_build_object('id',id,'active',active and status='approved') order by id) into members from public.duty_members;
 if members is not null then
  perform duty_private.compensation_record(jsonb_build_object('kind','members','members',members),'cutover/members');
  for p in select month,current_publication_id from public.duty_months where current_publication_id is not null order by month loop
   perform duty_private.compensation_publication(p.month,p.current_publication_id);
  end loop;
  update public.duty_workspace set revision=revision+1 where id;
 end if;
end $cutover$;

RESET check_function_bodies;
NOTIFY pgrst, 'reload schema';
