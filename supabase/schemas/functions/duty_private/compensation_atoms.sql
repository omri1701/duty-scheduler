CREATE FUNCTION duty_private.compensation_atoms(p jsonb) RETURNS jsonb
 LANGUAGE plpgsql STABLE SET search_path TO '' AS $$
#variable_conflict use_column
declare result jsonb:='{}'::jsonb; d jsonb; first_day date; end_day date; day date; amount bigint; combined boolean; finish bigint; extra bigint;
begin
 if p is null or p='null'::jsonb then return result; end if;
 for d in select value from jsonb_array_elements(p->'duties') order by value->>'startDate' loop
  first_day:=(d->>'startDate')::date; end_day:=(d->>'endDate')::date; amount:=duty_private.compensation_units(d->'units',true);
  combined:=extract(dow from first_day)=5 and end_day=first_day+2;
  if duty_private.duty_owner(first_day)<>p->>'month' or (not combined and end_day<>first_day+1)
   or amount<(case when not combined and extract(dow from first_day) in (5,6) then 1 else 2 end) or amount>(case when not combined and extract(dow from first_day) in (5,6) then 41 else 42 end) then raise exception 'invalid-published-duty'; end if;
  finish:=(extract(epoch from ((end_day+time '09:00') at time zone 'Asia/Jerusalem'))*1000)::bigint;
  -- A combined weekend's date atoms follow the hand-split weights: the extra beyond
  -- the ordinary two units goes half to each date, the odd unit to Friday.
  extra:=case when combined then amount-2 else 0 end;
  for day in select generate_series(first_day,end_day-1,interval '1 day')::date loop
   if result ? day::text then raise exception 'overlapping-published-duty'; end if;
   result:=result||jsonb_build_object(day::text,jsonb_build_object('date',day,'units',case when not combined then amount when day=first_day then 1+(extra+1)/2 else 1+extra/2 end,'primaryId',d->'primaryId','endInstantMs',finish));
  end loop;
 end loop;
 return result;
end $$;
