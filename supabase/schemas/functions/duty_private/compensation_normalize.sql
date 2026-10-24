-- Incremental graph normalization, in the same priority/DFS/Kahn order as PR #33.
CREATE FUNCTION duty_private.compensation_normalize(claims jsonb, members jsonb) RETURNS jsonb
 LANGUAGE plpgsql STABLE SET search_path TO '' AS $$
#variable_conflict use_column
declare edges jsonb:='[]'::jsonb; steps jsonb:='[]'::jsonb; e jsonb; a jsonb; b jsonb; part jsonb; paths jsonb;
 ids integer[]; i integer; j integer; amount bigint; vertices text[]; ordered text[]:=ARRAY[]::text[]; v text;
begin
 for e in select value from jsonb_array_elements(claims) loop
  edges:=edges||jsonb_build_array(duty_private.compensation_segment(e,e->'priority',
   not coalesce((members->(e->>'debtorId')->>'active')::boolean,false) or not coalesce((members->(e->>'creditorId')->>'active')::boolean,false)));
 end loop;
 if exists(select 1 from jsonb_array_elements(edges) with ordinality a(x,i),jsonb_array_elements(edges) with ordinality b(y,j),
  jsonb_array_elements(x->'path') p,jsonb_array_elements(y->'path') q where i<j and p->>'lotId'=q->>'lotId'
  and (p->>'offset')::bigint<(q->>'offset')::bigint+(q->>'units')::bigint and (q->>'offset')::bigint<(p->>'offset')::bigint+(p->>'units')::bigint) then raise exception 'overlapping-source-slices'; end if;
 -- Keep the live array sorted. Array ordinality is stable between selection/take.
 select coalesce(jsonb_agg(x order by (x->'priority'->>'at')::bigint,(x->'priority'->>'sequence')::bigint,
  x->'priority'->>'lotId' COLLATE "C",x->>'id' COLLATE "C"),'[]') into edges from jsonb_array_elements(edges) x;
 loop
  ids:=null;
  select array[aa.i::int-1,bb.i::int-1] into ids from jsonb_array_elements(edges) with ordinality aa(x,i)
   cross join jsonb_array_elements(edges) with ordinality bb(y,i)
   where not (x->>'frozen')::boolean and not (y->>'frozen')::boolean and (x->>'units')::bigint>0 and (y->>'units')::bigint>0
   and x->>'debtorId'=y->>'creditorId' and x->>'creditorId'=y->>'debtorId' order by aa.i,bb.i limit 1;
  exit when ids is null;
  amount:=least((edges->ids[1]->>'units')::bigint,(edges->ids[2]->>'units')::bigint); paths:='[]';
  foreach i in array ids loop
   e:=edges->i; paths:=paths||jsonb_build_array(duty_private.compensation_slice(e,amount)->'path');
   if (e->>'units')::bigint=amount then edges:=jsonb_set(edges,array[i::text,'units'],'0');
   else edges:=jsonb_set(edges,array[i::text],duty_private.compensation_segment(duty_private.compensation_slice(e,(e->>'units')::bigint-amount,amount),e->'priority')); end if;
  end loop;
  steps:=steps||jsonb_build_array(jsonb_build_object('kind','opposing','units',amount,'paths',paths));
 end loop;
 loop
  -- Enumerate sorted DFS walks. The first closed path has exactly the core DFS
  -- cycle order; prefix edges before its repeated vertex are not consumed.
  with recursive live as (select x,i::int-1 idx from jsonb_array_elements(edges) with ordinality a(x,i) where (x->>'units')::bigint>0 and not (x->>'frozen')::boolean),
  walks(vertex,visited,route,sortkey,cycle) as (
   select v,array[v],array[]::integer[],array[v]::text[],false from (select x->>'debtorId' v from live union select x->>'creditorId' from live) vs
   union all
   select l.x->>'creditorId',w.visited||(l.x->>'creditorId'),w.route||l.idx,
    w.sortkey||array[l.x->>'creditorId',lpad(l.idx::text,12,'0')],(l.x->>'creditorId')=any(w.visited)
   from walks w join live l on l.x->>'debtorId'=w.vertex where not w.cycle
  ) select route[array_position(visited,vertex):array_length(route,1)] into ids from walks where cycle order by sortkey COLLATE "C" limit 1;
  exit when ids is null;
  select min((edges->n->>'units')::bigint) into amount from unnest(ids) n; paths:='[]';
  foreach i in array ids loop
   e:=edges->i; paths:=paths||jsonb_build_array(duty_private.compensation_slice(e,amount)->'path');
   if (e->>'units')::bigint=amount then edges:=jsonb_set(edges,array[i::text,'units'],'0');
   else edges:=jsonb_set(edges,array[i::text],duty_private.compensation_segment(duty_private.compensation_slice(e,(e->>'units')::bigint-amount,amount),e->'priority')); end if;
  end loop;
  steps:=steps||jsonb_build_array(jsonb_build_object('kind','cycle','units',amount,'paths',paths));
 end loop;
 select array_agg(v order by v COLLATE "C") into vertices from (
  select x->>'debtorId' v from jsonb_array_elements(edges) x where (x->>'units')::bigint>0 and not (x->>'frozen')::boolean union
  select x->>'creditorId' from jsonb_array_elements(edges) x where (x->>'units')::bigint>0 and not (x->>'frozen')::boolean) a;
 while cardinality(ordered)<coalesce(cardinality(vertices),0) loop
  select node into v from unnest(vertices) node where not node=any(ordered) and not exists(
   select 1 from jsonb_array_elements(edges) x where (x->>'units')::bigint>0 and not (x->>'frozen')::boolean and x->>'creditorId'=node and not (x->>'debtorId')=any(ordered)) order by node COLLATE "C" limit 1;
  if v is null then raise exception 'normalization-cycle'; end if;
  ordered:=ordered||v;
 end loop;
 foreach v in array ordered loop
  loop
   select x,i::int-1 into a,i from jsonb_array_elements(edges) with ordinality q(x,i) where (x->>'units')::bigint>0 and not (x->>'frozen')::boolean and x->>'creditorId'=v
    order by (x->'priority'->>'at')::bigint,(x->'priority'->>'sequence')::bigint,x->'priority'->>'lotId' COLLATE "C",x->>'id' COLLATE "C" limit 1;
   select x,i::int-1 into b,j from jsonb_array_elements(edges) with ordinality q(x,i) where (x->>'units')::bigint>0 and not (x->>'frozen')::boolean and x->>'debtorId'=v
    order by (x->'priority'->>'at')::bigint,(x->'priority'->>'sequence')::bigint,x->'priority'->>'lotId' COLLATE "C",x->>'id' COLLATE "C" limit 1;
   exit when a is null or b is null;
   amount:=least((a->>'units')::bigint,(b->>'units')::bigint);
   paths:=jsonb_build_array(duty_private.compensation_slice(a,amount)->'path',duty_private.compensation_slice(b,amount)->'path');
   foreach i in array array[i,j] loop
    e:=edges->i;
    if (e->>'units')::bigint=amount then edges:=jsonb_set(edges,array[i::text,'units'],'0');
    else edges:=jsonb_set(edges,array[i::text],duty_private.compensation_segment(duty_private.compensation_slice(e,(e->>'units')::bigint-amount,amount),e->'priority')); end if;
   end loop;
   select x->'priority' into part from jsonb_array_elements(jsonb_build_array(a,b)) x order by (x->'priority'->>'at')::bigint,(x->'priority'->>'sequence')::bigint,x->'priority'->>'lotId' COLLATE "C" limit 1;
   edges:=edges||jsonb_build_array(duty_private.compensation_segment(jsonb_build_object('debtorId',a->'debtorId','creditorId',b->'creditorId','path',(paths->0)||(paths->1)),part));
   steps:=steps||jsonb_build_array(jsonb_build_object('kind','chain','units',amount,'paths',paths));
  end loop;
 end loop;
 select coalesce(jsonb_agg(x order by (x->'priority'->>'at')::bigint,(x->'priority'->>'sequence')::bigint,x->'priority'->>'lotId' COLLATE "C",x->>'id' COLLATE "C"),'[]') into edges from jsonb_array_elements(edges) x where (x->>'units')::bigint>0;
 return jsonb_build_object('claims',edges,'steps',steps);
end $$;
