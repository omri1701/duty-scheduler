-- One re-plan event: appended for real, or applied to the state only.
CREATE FUNCTION duty_private.compensation_replan_step(s jsonb, op jsonb, key text, instant bigint, actor text, reason text, commit boolean) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
begin
 if commit then return duty_private.compensation_append(s,op,key,instant,actor,reason); end if;
 return duty_private.compensation_apply(s,jsonb_build_object('sequence',coalesce((s->'events'->-1->>'sequence')::bigint,0)+1,'sourceKey',key,'at',instant,'actor',actor,'operation',op)
  ||case when reason is null then '{}'::jsonb else jsonb_build_object('reason',reason) end);
end $$;
