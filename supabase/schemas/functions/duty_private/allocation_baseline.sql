CREATE FUNCTION duty_private.allocation_baseline(f jsonb, baseline jsonb) RETURNS void
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
