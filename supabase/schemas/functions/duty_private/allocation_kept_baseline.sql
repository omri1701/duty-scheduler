-- A stored ordinary baseline the manager keeps unchanged after the month's duties changed
-- shape (a weekend split by hand, decision 2026-11-07) only has to still split exactly into
-- the duties: fair shares are never re-fitted behind the manager's back, so a split's half
-- points never make the saved plan "unfair". Exact count-vector partition, as the first
-- half of allocation_fit; outside its domain the original per-duty search decides.
CREATE FUNCTION duty_private.allocation_kept_baseline(f jsonb, baseline jsonb) RETURNS void
 LANGUAGE plpgsql IMMUTABLE SET search_path TO '' AS $$
declare weights integer[]; capacities integer[]; vals bigint[]; counts bigint[]; radix bigint[]:='{1}'; k integer; j integer; cap integer;
 total bigint; q bigint:=0; codes bigint[]; loads bigint[];
begin
 select array_agg((d->>'units')::integer order by (d->>'units')::integer desc),sum((d->>'units')::integer) into weights,total from jsonb_array_elements(f->'duties') d;
 select array_agg(value::integer order by value::integer desc) into capacities from jsonb_each(baseline);
 if coalesce(cardinality(weights),0)=0 or coalesce(cardinality(capacities),0)=0 or array_position(capacities,null) is not null
  or exists(select 1 from unnest(weights) w where w is null or w<1) or exists(select 1 from unnest(capacities) c where c<0)
  or (select sum(c) from unnest(capacities) c)<>total then raise exception 'invalid-ordinary-baseline'; end if;
 select array_agg(v order by v desc),array_agg(c order by v desc) into vals,counts from (select w::bigint v,count(*) c from unnest(weights) w group by w) g;
 k:=cardinality(vals);
 for j in 1..k loop q:=gcd(q,vals[j]); radix[j+1]:=radix[j]*(counts[j]+1); end loop;
 -- A share the duties' common step can't make (half points in a whole-point month) never fits.
 if exists(select 1 from unnest(capacities) c where c%q<>0) then raise exception 'invalid-ordinary-baseline'; end if;
 if cardinality(weights)>64 or cardinality(capacities)*total>=2^25 then
  if not duty_private.allocation_partition(weights,capacities) then raise exception 'invalid-ordinary-baseline'; end if;
  return;
 end if;
 -- A state is the remaining counts in mixed radix; duty value j is digit j. Fill each
 -- share from the remaining counts, value by value.
 codes:=array[radix[k+1]-1];
 foreach cap in array capacities loop
  loads:=array_fill(0::bigint,array[cardinality(codes)]);
  for j in 1..k loop
   select array_agg(code-x*radix[j]),array_agg(load+x*vals[j]) into codes,loads
   from (select distinct code,load from unnest(codes,loads) s(code,load)) s,generate_series(0,least(code/radix[j]%(counts[j]+1),(cap-load)/vals[j])) x;
   if codes is null then raise exception 'invalid-ordinary-baseline'; end if;
  end loop;
  select array_agg(distinct code) into codes from unnest(codes,loads) s(code,load) where load=cap;
  if codes is null then raise exception 'invalid-ordinary-baseline'; end if;
 end loop;
 if not 0=any(codes) then raise exception 'invalid-ordinary-baseline'; end if;
end $$;
