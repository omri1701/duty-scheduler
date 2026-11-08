CREATE FUNCTION duty_private.allocation_part(t jsonb, amount bigint, off bigint DEFAULT 0) RETURNS jsonb
 LANGUAGE plpgsql STABLE SET search_path TO '' AS $$
declare claim jsonb:=nullif(t->'claim','null'); prior jsonb;
begin
 if amount<=0 or off<0 or off+amount>(t->>'units')::bigint then raise exception 'invalid-token-slice'; end if;
 if claim is not null then claim:=claim||duty_private.compensation_slice(claim,amount,off)||jsonb_build_object('units',amount); end if;
 select coalesce(jsonb_agg((p||jsonb_build_object('units',amount))||case when p ? 'deferredClaim' then jsonb_build_object('deferredClaim',duty_private.compensation_slice(p->'deferredClaim',amount,off)) else '{}' end order by i),'[]')
 into prior from jsonb_array_elements(t->'prior') with ordinality a(p,i);
 return t||jsonb_build_object('units',amount,'claim',claim,'prior',prior);
end $$;
