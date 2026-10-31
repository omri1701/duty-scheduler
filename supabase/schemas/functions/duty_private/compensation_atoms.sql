CREATE FUNCTION duty_private.compensation_atoms(p jsonb) RETURNS jsonb
 LANGUAGE plpgsql STABLE SET search_path TO '' AS $$
#variable_conflict use_column
declare result jsonb:='{}'::jsonb; d jsonb; first_day date; end_day date; day date; amount bigint; combined boolean; finish bigint; saturday bigint;
begin
 if p is null or p='null'::jsonb then return result; end if;
 for d in select value from jsonb_array_elements(p->'duties') order by value->>'startDate' loop
  first_day:=(d->>'startDate')::date; end_day:=(d->>'endDate')::date; amount:=duty_private.compensation_units(d->'units',true);
  combined:=extract(dow from first_day)=5 and end_day=first_day+2;
  if duty_private.duty_owner(first_day)<>p->>'month' or (not combined and (end_day<>first_day+1 or d ? 'saturdayUnits'))
   or amount<(case when not combined and extract(dow from first_day) in (5,6) then 1 else 2 end) or amount>(case when combined then 82 when extract(dow from first_day) in (5,6) then 41 else 42 end) then raise exception 'invalid-published-duty'; end if;
  finish:=(extract(epoch from ((end_day+time '09:00') at time zone 'Asia/Jerusalem'))*1000)::bigint;
  -- A combined weekend has one atom per date, each carrying its own date's points:
  -- Saturday its saturdayUnits (one plus twice its extra), Friday the rest.
  saturday:=case when combined then duty_private.compensation_units(coalesce(d->'saturdayUnits','1'::jsonb),true) else 0 end;
  if combined and (saturday>41 or amount-saturday<1 or amount-saturday>41) then raise exception 'invalid-published-duty'; end if;
  for day in select generate_series(first_day,end_day-1,interval '1 day')::date loop
   if result ? day::text then raise exception 'overlapping-published-duty'; end if;
   result:=result||jsonb_build_object(day::text,jsonb_build_object('date',day,'units',case when not combined then amount when day=first_day then amount-saturday else saturday end,'primaryId',d->'primaryId','endInstantMs',finish));
  end loop;
 end loop;
 return result;
end $$;
