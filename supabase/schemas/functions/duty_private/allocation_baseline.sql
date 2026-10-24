CREATE FUNCTION duty_private.allocation_baseline(f jsonb, baseline jsonb) RETURNS void
 LANGUAGE plpgsql IMMUTABLE SET search_path TO '' AS $$
declare weights integer[]; capacities integer[]; n integer; total integer; cost bigint; quantum integer:=0; w integer;
begin
 select array_agg((d->>'units')::integer order by (d->>'units')::integer desc),sum((d->>'units')::integer) into weights,total from jsonb_array_elements(f->'duties') d;
 select array_agg(value::integer order by value::integer desc) into capacities from jsonb_each(baseline);
 n:=cardinality(capacities);
 foreach w in array weights loop quantum:=gcd(quantum,w); end loop;
 select sum((n*x::bigint-total)^2)::bigint into cost from unnest(capacities) x;
 if not duty_private.allocation_partition(weights,capacities) or duty_private.allocation_better_baseline(weights,array_fill(0,array[n]),cost,quantum,total) then raise exception 'invalid-ordinary-baseline'; end if;
end $$;
