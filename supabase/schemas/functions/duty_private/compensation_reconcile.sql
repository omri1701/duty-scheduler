CREATE FUNCTION duty_private.compensation_reconcile(s jsonb, instant bigint, persist boolean DEFAULT true) RETURNS jsonb
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
