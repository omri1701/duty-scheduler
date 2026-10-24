-- Exact branch-and-bound decision: does ANY canonical partition have lower
-- ordinary squared cost? The water-filled quantum relaxation is only a pruning
-- lower bound; it is never accepted as a feasible partition or solver proof.
CREATE FUNCTION duty_private.allocation_better_baseline(weights integer[], bins integer[], ceiling_cost bigint, quantum integer, total integer) RETURNS boolean
 LANGUAGE plpgsql IMMUTABLE SET search_path TO '' AS $$
declare relaxed integer[]:=bins; remaining integer; i integer; j integer; previous integer:=-1; cost bigint; next_bins integer[]; n integer:=cardinality(bins);
begin
 select coalesce(sum(w),0) into remaining from unnest(weights) w;
 -- Distribute remaining indivisible quantum units into the lightest bin. This
 -- permits splitting actual duties and therefore only bounds the search below.
 for i in 1..(remaining/quantum) loop
  select k into j from generate_subscripts(relaxed,1) k order by relaxed[k],k limit 1;
  relaxed[j]:=relaxed[j]+quantum;
 end loop;
 select sum((n*x::bigint-total)^2)::bigint into cost from unnest(relaxed) x;
 if cost>=ceiling_cost then return false; end if;
 if coalesce(cardinality(weights),0)=0 then return true; end if;
 for i in 1..n loop
  if bins[i]=previous then continue; end if; previous:=bins[i];
  next_bins:=bins; next_bins[i]:=next_bins[i]+weights[1];
  select array_agg(x order by x) into next_bins from unnest(next_bins) x;
  if duty_private.allocation_better_baseline(weights[2:],next_bins,ceiling_cost,quantum,total) then return true; end if;
 end loop;
 return false;
end $$;
