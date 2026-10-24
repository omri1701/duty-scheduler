CREATE FUNCTION duty_private.compensation_state() RETURNS jsonb
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
