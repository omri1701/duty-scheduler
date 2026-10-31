-- System credit for an indivisible month (decision 2026-10-30): the fitted
-- ordinary baseline's excess over the plain equal split, owed as temporary
-- transfers. The baseline is compared rank by rank with the sorted plain split,
-- so the remainder choice itself never creates debt; only the fit's deviation
-- does. Among equal points the newest member takes the kinder plain share, so the
-- more senior one carries the difference. A creditor is credited only for the
-- extra it still carries after its net permanent loss, and a debtor owes only
-- while it still sits below the split after its net permanent gain (decision
-- 2026-10-31). Debtors: fewest points, most senior first. Creditors: most
-- points, most senior first. Pure and deterministic; the browser's
-- unevenTransfers derives the same list and confirm refuses any other.
CREATE FUNCTION duty_private.allocation_uneven(f jsonb, baseline jsonb, changes jsonb) RETURNS jsonb
 LANGUAGE plpgsql IMMUTABLE SET search_path TO '' AS $$
declare ids text[]; n integer; total bigint:=0; q bigint:=0; w bigint; share bigint; remainder integer; plain bigint[]:='{}'; points bigint[]:='{}'; perm bigint[]:='{}';
 excess bigint[]; deficit bigint[]; creditors integer[]; debtors integer[]; c integer; d integer; k integer; amount bigint; result jsonb:='[]';
begin
 select array_agg(x order by i) into ids from jsonb_array_elements_text(f->'seniority') with ordinality a(x,i);
 n:=coalesce(cardinality(ids),0);
 if n=0 then return result; end if;
 for w in select (x->>'units')::bigint from jsonb_array_elements(f->'duties') x loop total:=total+w; q:=gcd(q,w); end loop;
 if q=0 then q:=1; end if;
 share:=total/(n*q)*q; remainder:=((total-share*n)/q)::integer;
 for k in 1..n loop
  plain[k]:=share+case when k>n-remainder then q else 0 end;
  points[k]:=duty_private.compensation_units(baseline->ids[k]);
  perm[k]:=coalesce((changes->ids[k]->>'permanent')::numeric::bigint,0);
 end loop;
 select array_agg(greatest(0,points[i]-plain[n+1-rank]-greatest(0,-perm[i])) order by i) into excess
  from (select i,row_number() over (order by points[i] desc,i desc) rank from generate_series(1,n) i) r;
 select array_agg(greatest(0,plain[rank]-points[i]-greatest(0,perm[i])) order by i) into deficit
  from (select i,row_number() over (order by points[i],i desc) rank from generate_series(1,n) i) r;
 select array_agg(i order by points[i] desc,i) into creditors from generate_series(1,n) i where excess[i]>0;
 select array_agg(i order by points[i],i) into debtors from generate_series(1,n) i where deficit[i]>0;
 if creditors is null or debtors is null then return result; end if;
 foreach c in array creditors loop
  foreach d in array debtors loop
   exit when excess[c]=0;
   amount:=least(excess[c],deficit[d]);
   if amount=0 then continue; end if;
   result:=result||jsonb_build_array(jsonb_build_object('id','uneven/'||ids[d]||'/'||ids[c],'fromId',ids[d],'toId',ids[c],'units',amount));
   excess[c]:=excess[c]-amount; deficit[d]:=deficit[d]-amount;
  end loop;
 end loop;
 return result;
end $$;
