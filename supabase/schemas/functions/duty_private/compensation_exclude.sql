CREATE FUNCTION duty_private.compensation_exclude(excluded jsonb, cap jsonb) RETURNS jsonb
 LANGUAGE plpgsql STABLE SET search_path TO '' AS $$
#variable_conflict use_column
declare off bigint:=duty_private.compensation_units(cap->'offset'); n bigint:=duty_private.compensation_units(cap->'units',true); k text:=cap->>'date'; cells jsonb;
begin
 select jsonb_agg(i) into cells from generate_series(off,off+n-1) i;
 if exists(select 1 from jsonb_array_elements(coalesce(excluded->k,'[]')) a join jsonb_array_elements(cells) b on a=b) then raise exception 'overlapping-accounting-capacity'; end if;
 return excluded||jsonb_build_object(k,coalesce(excluded->k,'[]')||cells);
end $$;
