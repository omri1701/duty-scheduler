CREATE FUNCTION duty_private.compensation_append(s jsonb, op jsonb, key text, instant bigint, actor text, reason text DEFAULT NULL) RETURNS jsonb
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
