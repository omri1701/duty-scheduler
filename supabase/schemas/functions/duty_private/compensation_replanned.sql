-- Whether a month was re-planned after a version of it was last published (decision
-- 2026-11-01): that version's ledger entries were reversed, so it can't become current
-- again by restoring or deleting versions; the month is re-planned instead.
CREATE FUNCTION duty_private.compensation_replanned(s jsonb, p_month text, version uuid) RETURNS boolean
 LANGUAGE sql STABLE SET search_path TO '' AS $$
 select exists(select 1 from jsonb_array_elements(s->'events') r
  where starts_with(r->>'sourceKey','replan/')
   and (r->>'sequence')::bigint>coalesce((select max((x->>'sequence')::bigint) from jsonb_array_elements(s->'events') x
    where x->'operation'->>'kind'='publication' and x->'operation'->'after'->>'id'=version::text),0)
   and ((r->'operation'->>'kind'='publication' and r->'operation'->>'month'=p_month)
    or (r->'operation'->>'kind'='correct' and s->'lots'->(r->'operation'->>'lotId')->>'sourceKey' in (select x->>'sourceKey'
     from jsonb_array_elements(s->'events') x where x->'operation'->>'kind'='publication' and x->'operation'->>'month'=p_month))))
$$;
