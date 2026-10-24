CREATE FUNCTION duty_private.compensation_slice(c jsonb, amount bigint, off bigint DEFAULT 0) RETURNS jsonb
 LANGUAGE plpgsql STABLE SET search_path TO '' AS $$
#variable_conflict use_column
begin
 if amount<=0 or off<0 or off+amount>(c->'path'->0->>'units')::bigint then raise exception 'claim-slice-out-of-range'; end if;
 return jsonb_build_object('debtorId',c->'debtorId','creditorId',c->'creditorId','path',
  (select jsonb_agg(jsonb_build_object('lotId',p->'lotId','offset',(p->>'offset')::bigint+off,'units',amount) order by i)
   from jsonb_array_elements(c->'path') with ordinality a(p,i)));
end $$;
