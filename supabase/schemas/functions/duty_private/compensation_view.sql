CREATE FUNCTION duty_private.compensation_view(s jsonb) RETURNS jsonb
 LANGUAGE sql STABLE SET search_path TO '' AS $$
 select jsonb_build_object('events',s->'events','claims',s->'claims','normalizations',s->'normalizations',
  'members',coalesce((select jsonb_agg(value order by key COLLATE "C") from jsonb_each(s->'members')),'[]'),
  'lots',coalesce((select jsonb_agg(value order by (value->'priority'->>'sequence')::bigint,key COLLATE "C") from jsonb_each(s->'lots')),'[]'),
  'contributions',coalesce((select jsonb_agg(value order by key COLLATE "C") from jsonb_each(s->'contributions')),'[]'),
  'settlements',coalesce((select jsonb_agg(value order by key COLLATE "C") from jsonb_each(s->'settlements')),'[]'),
  'publications',coalesce((select jsonb_agg(value order by key COLLATE "C") from jsonb_each(s->'publications')),'[]'),
  'net',coalesce((select jsonb_object_agg(id,net) from (
   select key id,coalesce((select sum(case when c->>'creditorId'=key then (c->>'units')::bigint else -(c->>'units')::bigint end)
    from jsonb_array_elements(s->'claims') c where key in (c->>'debtorId',c->>'creditorId')),0) net from jsonb_each(s->'members')) n),'{}'));
$$;
