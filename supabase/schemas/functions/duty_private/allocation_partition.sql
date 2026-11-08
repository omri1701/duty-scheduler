-- Exact canonical-weight partition check, independent of availability and solver
-- output. Equal residual bins are symmetric; process largest duties first.
CREATE FUNCTION duty_private.allocation_partition(weights integer[], capacities integer[]) RETURNS boolean
 LANGUAGE plpgsql IMMUTABLE SET search_path TO '' AS $$
declare i integer; previous integer:=-1; next_bins integer[]; weight integer:=weights[1];
begin
 if coalesce(cardinality(weights),0)=0 then return not exists(select 1 from unnest(capacities) x where x<>0); end if;
 for i in 1..cardinality(capacities) loop
  if capacities[i]<weight or capacities[i]=previous then continue; end if;
  previous:=capacities[i]; next_bins:=capacities; next_bins[i]:=next_bins[i]-weight;
  select array_agg(x order by x desc) into next_bins from unnest(next_bins) x;
  if duty_private.allocation_partition(weights[2:],next_bins) then return true; end if;
 end loop;
 return false;
end $$;
