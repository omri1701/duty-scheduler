CREATE FUNCTION duty_private.compensation_segment(c jsonb, priority jsonb, frozen boolean DEFAULT false) RETURNS jsonb
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
