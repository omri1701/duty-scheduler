-- The live lots a month's publications booked that a later published month's pending (or
-- held) repayment relies on (decision 2026-11-07), lot id order: a re-plan or a deletion of the
-- month keeps them live, and its new plan takes them as a fixed fact (`repaidLater`), checked
-- by allocation_compile. lib/compensation/replan.ts (repaidLater) is the same list.
CREATE FUNCTION duty_private.allocation_repaid_later(s jsonb, p_month text) RETURNS jsonb
 LANGUAGE sql STABLE SET search_path TO '' AS $$
 select coalesce(jsonb_agg(jsonb_build_object('id',l.key,'fromId',l.value->'debtorId','toId',l.value->'creditorId','units',(l.value->>'correctedUnits')::bigint) order by l.key COLLATE "C"),'[]'::jsonb)
 from jsonb_each(coalesce(s->'lots','{}'::jsonb)) l
 where (l.value->>'correctedUnits')::bigint>0
  and exists(select 1 from jsonb_array_elements(s->'events') x where x->'operation'->>'kind'='publication' and x->'operation'->>'month'=p_month and x->>'sourceKey'=l.value->>'sourceKey')
  and exists(select 1 from jsonb_each(coalesce(s->'contributions','{}'::jsonb)) c where c.value->>'status' in ('pending','held')
   and exists(select 1 from jsonb_array_elements(c.value->'claim'->'path') p where p->>'lotId'=l.key)
   and exists(select 1 from jsonb_each(coalesce(s->'publications','{}'::jsonb)) m where m.key<>p_month
    and exists(select 1 from jsonb_array_elements(m.value->'reservations') r where r->>'id'=c.key)))
$$;
