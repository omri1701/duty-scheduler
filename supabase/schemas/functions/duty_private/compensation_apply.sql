-- Pure replay primitive. Never granted to API roles; commands enter through the
-- checked adapter, which derives actor, time, membership and publication facts.
CREATE FUNCTION duty_private.compensation_apply(s jsonb, e jsonb) RETURNS jsonb
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
