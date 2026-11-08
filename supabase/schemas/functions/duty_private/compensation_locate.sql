CREATE FUNCTION duty_private.compensation_locate(s jsonb, ref jsonb) RETURNS jsonb
 LANGUAGE plpgsql STABLE SET search_path TO '' AS $$
#variable_conflict use_column
declare checked jsonb;
begin
 checked:=duty_private.compensation_segment(ref,'{"at":0,"sequence":0,"lotId":"reference"}');
 return (select c from jsonb_array_elements(s->'claims') c where c->>'debtorId'=checked->>'debtorId' and c->>'creditorId'=checked->>'creditorId'
  and jsonb_array_length(c->'path')=jsonb_array_length(checked->'path') and not exists(
   select 1 from jsonb_array_elements(checked->'path') with ordinality a(p,i) where p->>'lotId'<>c->'path'->(i::int-1)->>'lotId'
    or (p->>'offset')::bigint<(c->'path'->(i::int-1)->>'offset')::bigint
    or (p->>'offset')::bigint+(p->>'units')::bigint>(c->'path'->(i::int-1)->>'offset')::bigint+(c->>'units')::bigint
    or (p->>'offset')::bigint-(c->'path'->(i::int-1)->>'offset')::bigint<>(checked->'path'->0->>'offset')::bigint-(c->'path'->0->>'offset')::bigint) limit 1);
end $$;
