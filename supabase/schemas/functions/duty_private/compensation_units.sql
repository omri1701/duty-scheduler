CREATE FUNCTION duty_private.compensation_units(v jsonb, positive boolean DEFAULT false) RETURNS bigint
 LANGUAGE plpgsql IMMUTABLE SET search_path TO '' AS $$
#variable_conflict use_column
declare n numeric;
begin
 if jsonb_typeof(v) IS DISTINCT FROM 'number' then raise exception 'invalid-units'; end if;
 n:=v::numeric;
 if n<>trunc(n) or n<(case when positive then 1 else 0 end) or n>1000000000 then raise exception 'invalid-units'; end if;
 return n::bigint;
end $$;
