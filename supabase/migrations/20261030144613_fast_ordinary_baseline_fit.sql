-- Validate the ordinary baseline with an exact count-vector search. The decision is
-- unchanged; the original per-duty search remains only outside its exact domain.
-- Exact ordinary-baseline decision over remaining duty-count vectors: true when
-- the capacities partition the canonical weights and no partition has a lower
-- sum of squared shares (the allocation_partition/allocation_better_baseline
-- decision). Identical duties are one count, so equivalent assignments are
-- explored once. NULL outside the exact integer domain; the caller then uses the
-- original per-duty search.
CREATE FUNCTION duty_private.allocation_fit(weights integer[], capacities integer[]) RETURNS boolean
 LANGUAGE plpgsql IMMUTABLE SET search_path TO '' AS $$
declare vals bigint[]; counts bigint[]; radix bigint[]:='{1}'; n integer:=coalesce(cardinality(capacities),0); k integer; j integer; m integer; cap integer;
 total bigint; q bigint:=0; low bigint; high bigint; budget bigint; codes bigint[]; loads bigint[]; rests bigint[]; costs bigint[];
begin
 -- Beyond this domain the original search's float costs may round; defer to it.
 if coalesce(cardinality(weights),0) not between 1 and 64 or n=0 or array_position(capacities,null) is not null
  or exists(select 1 from unnest(weights) w where w is null or w<1) then return null; end if;
 select array_agg(v order by v desc),array_agg(c order by v desc),sum(v*c) into vals,counts,total from (select w::bigint v,count(*) c from unnest(weights) w group by w) g;
 if n*total>=2^25 then return null; end if;
 k:=cardinality(vals);
 for j in 1..k loop q:=gcd(q,vals[j]); radix[j+1]:=radix[j]*(counts[j]+1); end loop;
 -- A state is the remaining counts in mixed radix; duty value j is digit j.
 -- Exact partition: fill each capacity from the remaining counts, value by value.
 codes:=array[radix[k+1]-1];
 foreach cap in array capacities loop
  loads:=array_fill(0::bigint,array[cardinality(codes)]);
  for j in 1..k loop
   select array_agg(code-x*radix[j]),array_agg(load+x*vals[j]) into codes,loads
   from (select distinct code,load from unnest(codes,loads) s(code,load)) s,generate_series(0,least(code/radix[j]%(counts[j]+1),(cap-load)/vals[j])) x;
   if codes is null then return false; end if;
  end loop;
  select array_agg(distinct code) into codes from unnest(codes,loads) s(code,load) where load=cap;
  if codes is null then return false; end if;
 end loop;
 if not 0=any(codes) then return false; end if;
 -- Exact minimum: is any partition cheaper than this one? Each next share holds a
 -- largest remaining duty. Moving duty w from share A to B lowers the cost when
 -- A-B>w, so every optimum lies within the largest weight of the average. A state
 -- is dropped only when even the equal quantum split of its rest cannot beat it.
 select sum(c::bigint*c) into budget from unnest(capacities) c;
 low:=greatest(0,(total-n*vals[1]+n-1)/n); high:=(total+n*vals[1])/n;
 codes:=array[radix[k+1]-1]; rests:=array[total]; costs:='{0}';
 for m in 1..n loop
  loads:=array_fill(0::bigint,array[cardinality(codes)]);
  for j in 1..k loop
   select array_agg(code-x*radix[j]),array_agg(load+x*vals[j]),array_agg(rest),array_agg(cost) into codes,loads,rests,costs
   from unnest(codes,loads,rests,costs) s(code,load,rest,cost),lateral (select code/radix[j]%(counts[j]+1) have) h,
    generate_series(case when load=0 and have>0 then 1 else 0 end,least(have,(high-load)/vals[j])) x;
   if codes is null then return true; end if;
  end loop;
  select array_agg(code),array_agg(rest),array_agg(cost) into codes,rests,costs from (
   select code,rest-load rest,min(cost+load*load) cost from unnest(codes,loads,rests,costs) s(code,load,rest,cost)
   where load between low and high group by code,rest-load) s,
   lateral (select case when m<n then rest/((n-m)*q)*q end share) b,
   lateral (select case when m=n then case when rest=0 then 0 else budget end
    else (n-m-(rest-b.share*(n-m))/q)*b.share*b.share+(rest-b.share*(n-m))/q*(b.share+q)*(b.share+q) end bound) l
  where cost+l.bound<budget;
  if codes is null then return true; end if;
  if 0=any(codes) then return false; end if;
 end loop;
 return true;
end $$;

REVOKE ALL ON FUNCTION duty_private.allocation_fit(weights integer[], capacities integer[]) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION duty_private.allocation_baseline(f jsonb, baseline jsonb) RETURNS void
 LANGUAGE plpgsql IMMUTABLE SET search_path TO '' AS $$
declare weights integer[]; capacities integer[]; n integer; total integer; cost bigint; quantum integer:=0; w integer; fit boolean;
begin
 select array_agg((d->>'units')::integer order by (d->>'units')::integer desc),sum((d->>'units')::integer) into weights,total from jsonb_array_elements(f->'duties') d;
 select array_agg(value::integer order by value::integer desc) into capacities from jsonb_each(baseline);
 n:=cardinality(capacities);
 foreach w in array weights loop quantum:=gcd(quantum,w); end loop;
 select sum((n*x::bigint-total)^2)::bigint into cost from unnest(capacities) x;
 fit:=duty_private.allocation_fit(weights,capacities);
 -- Outside its exact domain, the original per-duty search decides.
 if fit is null then fit:=duty_private.allocation_partition(weights,capacities) and not duty_private.allocation_better_baseline(weights,array_fill(0,array[n]),cost,quantum,total); end if;
 if not fit then raise exception 'invalid-ordinary-baseline'; end if;
end $$;
