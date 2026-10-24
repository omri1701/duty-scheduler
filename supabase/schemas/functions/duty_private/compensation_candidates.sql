-- Unreserved normalized slices, oldest first. Held reservations remain exclusive.
CREATE FUNCTION duty_private.compensation_candidates(s jsonb) RETURNS jsonb
 LANGUAGE plpgsql STABLE SET search_path TO '' AS $$
declare c jsonb; r jsonb; a jsonb; b jsonb; ranges int8multirange; part int8range; result jsonb:='[]'; lo bigint; hi bigint;
begin
 for c in select value from jsonb_array_elements(s->'claims') where not (value->>'frozen')::boolean
  order by (value->'priority'->>'at')::bigint,(value->'priority'->>'sequence')::bigint,value->'priority'->>'lotId' COLLATE "C",value->>'id' COLLATE "C" loop
  ranges:=int8multirange(int8range(0,(c->>'units')::bigint,'[)'));
  for r in select value from jsonb_each(s->'contributions') where value->>'status' in ('pending','held') loop
   for a in select value from jsonb_array_elements(c->'path') loop
    for b in select value from jsonb_array_elements(r->'claim'->'path') where value->>'lotId'=a->>'lotId' loop
     lo:=greatest(0,(b->>'offset')::bigint-(a->>'offset')::bigint); hi:=least((c->>'units')::bigint,(b->>'offset')::bigint+(b->>'units')::bigint-(a->>'offset')::bigint);
     if hi>lo then ranges:=ranges-int8multirange(int8range(lo,hi,'[)')); end if;
    end loop;
   end loop;
  end loop;
  for part in select unnest(ranges) loop result:=result||jsonb_build_array(duty_private.compensation_segment(duty_private.compensation_slice(c,upper(part)-lower(part),lower(part)),c->'priority')); end loop;
 end loop;
 return result;
end $$;
