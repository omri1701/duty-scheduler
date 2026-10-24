CREATE FUNCTION duty_private.compensation_reserve(s jsonb, e jsonb, finish jsonb) RETURNS jsonb
 LANGUAGE plpgsql STABLE SET search_path TO '' AS $$
#variable_conflict use_column
declare key text; r jsonb; existing jsonb; atom jsonb; excluded jsonb:=finish->'excluded'; claim jsonb; historical boolean; carried boolean;
begin
 for key,r in select * from jsonb_each(finish->'proposed') order by key COLLATE "C" loop
  existing:=s->'contributions'->key; atom:=finish->'atoms'->(r->'capacity'->>'date');
  select exists(select 1 from jsonb_array_elements(coalesce(finish->'before'->'reservations','[]')) p where p->>'id'=key) into carried;
  if existing is not null then
   historical:=e->'operation'->>'mode'='delete' and existing->>'status' in ('cancelled','settled');
   if (not carried and not coalesce(historical,false)) or jsonb_build_object('id',existing->'id','capacity',existing->'capacity','claim',existing->'claim')<>r then raise exception 'reused-contribution'; end if;
  else
   if (atom->>'endInstantMs')::bigint<=(e->>'at')::bigint then raise exception 'reservation-already-completed'; end if;
   excluded:=duty_private.compensation_exclude(excluded,r->'capacity');
   claim:=duty_private.compensation_locate(s,r->'claim');
   if claim is null or (claim->>'frozen')::boolean or r->'capacity'->'units'<>r->'claim'->'path'->0->'units' then raise exception 'invalid-reservation-claim'; end if;
   if exists(select 1 from jsonb_each(s->'contributions') c,jsonb_array_elements(c.value->'claim'->'path') a,jsonb_array_elements(r->'claim'->'path') b
    where c.value->>'status' in ('pending','held') and a->>'lotId'=b->>'lotId' and (a->>'offset')::bigint<(b->>'offset')::bigint+(b->>'units')::bigint and (b->>'offset')::bigint<(a->>'offset')::bigint+(a->>'units')::bigint) then raise exception 'claim-already-reserved'; end if;
   s:=jsonb_set(s,array['contributions',key],r||jsonb_build_object('endInstantMs',atom->'endInstantMs','status','pending'));
  end if;
  if carried and s->'contributions'->key->>'status' in ('pending','held') then excluded:=duty_private.compensation_exclude(excluded,r->'capacity'); end if;
 end loop;
 return s;
end $$;
