-- Independent validator: no solver witness, proof status, client calendar,
-- eligibility, point total or override boolean is authoritative.
CREATE FUNCTION duty_private.generation_validate(f jsonb, targets jsonb, assignments jsonb) RETURNS jsonb
 LANGUAGE plpgsql STABLE SET search_path TO '' AS $$
#variable_conflict use_column
declare d jsonb; a jsonb; l jsonb; approval jsonb; n jsonb; previous jsonb; m jsonb; denied jsonb;
 ids jsonb:=f->'seniority'; totals jsonb:='{}'; weekends jsonb; fixed_weekends jsonb; k text; engineer text;
 total bigint:=0; assigned bigint:=0; amount bigint; scopes text[]:='{}'; scope text; locked_points bigint;
begin
 if jsonb_typeof(targets) IS DISTINCT FROM 'object' or jsonb_typeof(assignments) IS DISTINCT FROM 'object'
  or jsonb_typeof(f->'locks') IS DISTINCT FROM 'array' or jsonb_typeof(f->'approvals') IS DISTINCT FROM 'array'
  or jsonb_array_length(ids)=0 then raise exception 'invalid-generation-input'; end if;
 if (select count(*) from jsonb_each(targets))<>jsonb_array_length(ids) or exists(select 1 from jsonb_each(targets) where not ids ? key) then raise exception 'invalid-target-members'; end if;
 for k in select jsonb_array_elements_text(ids) loop
  amount:=duty_private.compensation_units(targets->k); total:=total+amount; totals:=totals||jsonb_build_object(k,0);
 end loop;
 if total<>(select sum((x->>'units')::bigint) from jsonb_array_elements(f->'duties') x) then raise exception 'target-total-mismatch'; end if;
 if (select count(*) from jsonb_each(assignments))<>jsonb_array_length(f->'duties')
  or exists(select 1 from jsonb_each(assignments) where not exists(select 1 from jsonb_array_elements(f->'duties') d where d->>'id'=key)) then raise exception 'assignment-coverage-shape'; end if;
 for l in select value from jsonb_array_elements(f->'locks') loop
  if jsonb_typeof(l) IS DISTINCT FROM 'object' or l-array['dutyId','engineer']<>'{}' or not ids ? (l->>'engineer')
   or not exists(select 1 from jsonb_array_elements(f->'duties') d where d->>'id'=l->>'dutyId')
   or (select count(*) from jsonb_array_elements(f->'locks') x where x->>'dutyId'=l->>'dutyId')<>1 then raise exception 'invalid-lock'; end if;
 end loop;
 for approval in select value from jsonb_array_elements(f->'approvals') loop
  if jsonb_typeof(approval) IS DISTINCT FROM 'object' or jsonb_typeof(approval->'reason') IS DISTINCT FROM 'string' or coalesce(approval->>'reason','') !~ '[^[:space:]]' or length(approval->>'reason')>2000 then raise exception 'approval-reason-required'; end if;
  case approval->>'rule'
  when 'availability' then
   if approval-array['rule','reason','dutyId','engineer','dates']<>'{}' then raise exception 'invalid-approval'; end if;
   select x into d from jsonb_array_elements(f->'duties') x where x->>'id'=approval->>'dutyId';
   select coalesce(jsonb_agg(day::date::text order by day),'[]') into denied from generate_series((d->>'startDate')::date,(d->>'endDate')::date-1,interval '1 day') day
    where f->'constraints'->(approval->>'engineer')->>day::date::text='no';
   if denied='[]' or denied IS DISTINCT FROM (select jsonb_agg(x order by x) from jsonb_array_elements(approval->'dates') x)
    or not (f->'locks') @> jsonb_build_array(jsonb_build_object('dutyId',approval->'dutyId','engineer',approval->'engineer')) then raise exception 'invalid-availability-approval'; end if;
   scope:='availability/'||(approval->>'dutyId');
  when 'consecutive' then
   if approval-array['rule','reason','duties']<>'{}' or jsonb_array_length(approval->'duties')<>2 then raise exception 'invalid-pair-approval'; end if;
   select x into d from jsonb_array_elements(f->'duties') x where x->>'id'=approval->'duties'->>0;
   select x into previous from jsonb_array_elements(f->'duties') x where x->>'id'=approval->'duties'->>1;
   select x into l from jsonb_array_elements(f->'locks') x where x->>'dutyId'=d->>'id';
   if d is null or previous is null or d->>'endDate'<>previous->>'startDate' or l is null
    or not (f->'locks') @> jsonb_build_array(jsonb_build_object('dutyId',previous->'id','engineer',l->'engineer')) then raise exception 'invalid-pair-approval'; end if;
   scope:='consecutive/'||(d->>'id')||'/'||(previous->>'id');
  when 'boundary' then
   if approval-array['rule','reason','dutyId','neighborId']<>'{}' then raise exception 'invalid-boundary-approval'; end if;
   select x into d from jsonb_array_elements(f->'duties') x where x->>'id'=approval->>'dutyId';
   select x into n from jsonb_array_elements(f->'neighbors') x where x->>'id'=approval->>'neighborId';
   if d is null or n is null or not (d->>'endDate'=n->>'start' or d->>'startDate'=n->>'end')
    or not (f->'locks') @> jsonb_build_array(jsonb_build_object('dutyId',d->'id','engineer',n->'engineer')) then raise exception 'invalid-boundary-approval'; end if;
   scope:='boundary/'||(d->>'id')||'/'||(n->>'ownerMonth')||'/'||(n->>'start')||'/'||(n->>'end')||'/'||(n->>'engineer');
  when 'weekends' then
   if approval-array['rule','reason','engineer','weekends']<>'{}' then raise exception 'invalid-weekend-approval'; end if;
   select coalesce(jsonb_agg(w order by w),'[]') into fixed_weekends from (select distinct d->'weekendId' w from jsonb_array_elements(f->'duties') d
    join jsonb_array_elements(f->'locks') l on l->>'dutyId'=d->>'id' where l->>'engineer'=approval->>'engineer' and d->>'weekendId' is not null) q;
   if jsonb_array_length(fixed_weekends)<2 or fixed_weekends IS DISTINCT FROM (select jsonb_agg(x order by x) from jsonb_array_elements(approval->'weekends') x) then raise exception 'invalid-weekend-approval'; end if;
   scope:='weekends/'||(approval->>'engineer');
  else raise exception 'unknown-approval';
  end case;
  if scope=any(scopes) then raise exception 'duplicate-approval-scope'; end if; scopes:=array_append(scopes,scope);
 end loop;
 for d in select value from jsonb_array_elements(f->'duties') loop
  a:=assignments->(d->>'id'); engineer:=a->>'primary';
  if jsonb_typeof(a) IS DISTINCT FROM 'object' or a-array['primary','secondary']<>'{}' or not a ? 'primary'
   or coalesce(a->'secondary','null') IS DISTINCT FROM d->'secondary' then raise exception 'secondary-changed'; end if;
  select x into l from jsonb_array_elements(f->'locks') x where x->>'dutyId'=d->>'id';
  if l is not null and l->>'engineer' IS DISTINCT FROM engineer then raise exception 'lock-changed'; end if;
  if engineer is null then continue; end if;
  if not ids ? engineer or engineer=d->>'secondary' then raise exception 'ineligible-primary'; end if;
  if exists(select 1 from generate_series((d->>'startDate')::date,(d->>'endDate')::date-1,interval '1 day') day where f->'constraints'->engineer->>day::date::text='no')
   and not exists(select 1 from jsonb_array_elements(f->'approvals') v where v->>'rule'='availability' and v->>'dutyId'=d->>'id' and v->>'engineer'=engineer) then raise exception 'unavailable-primary'; end if;
  amount:=(totals->>engineer)::bigint+(d->>'units')::bigint;
  if amount>(targets->>engineer)::bigint then raise exception 'target-exceeded'; end if;
  totals:=jsonb_set(totals,array[engineer],to_jsonb(amount)); assigned:=assigned+(d->>'units')::bigint;
  for n in select value from jsonb_array_elements(f->'neighbors') where value->>'engineer'=engineer loop
   if (d->>'startDate')::date>(n->>'end')::date or (n->>'start')::date>(d->>'endDate')::date then continue; end if;
   if not exists(select 1 from jsonb_array_elements(f->'approvals') v join jsonb_array_elements(f->'neighbors') reviewed on reviewed->>'id'=v->>'neighborId'
     where v->>'rule'='boundary' and v->>'dutyId'=d->>'id' and reviewed-array['id','source']=n-array['id','source']) then raise exception 'neighbor-conflict'; end if;
  end loop;
 end loop;
 for k in select jsonb_array_elements_text(ids) loop
  select coalesce(jsonb_agg(w order by w),'[]') into weekends from (select distinct d->'weekendId' w from jsonb_array_elements(f->'duties') d
   where assignments->(d->>'id')->>'primary'=k and d->>'weekendId' is not null) q;
  select v into approval from jsonb_array_elements(f->'approvals') v where v->>'rule'='weekends' and v->>'engineer'=k;
  if (approval is null and jsonb_array_length(weekends)>1) or (approval is not null and not (approval->'weekends') @> weekends) then raise exception 'weekend-cap'; end if;
  previous:=null;
  for d in select value from jsonb_array_elements(f->'duties') where assignments->(value->>'id')->>'primary'=k order by value->>'startDate' loop
   if previous->>'endDate'=d->>'startDate' and not exists(select 1 from jsonb_array_elements(f->'approvals') v where v->>'rule'='consecutive' and v->'duties'=jsonb_build_array(previous->'id',d->'id')) then raise exception 'consecutive-primary'; end if;
   previous:=d;
  end loop;
 end loop;
 return jsonb_build_object('actualUnits',totals,'assignedUnits',assigned,'missingUnits',total-assigned,'complete',assigned=total);
end $$;
