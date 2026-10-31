-- Holiday weekends: a special range touching a weekend no longer splits it. A
-- combined Friday–Saturday duty may carry a title and extra points and weighs
-- 1 + extra, exactly like one special day. A weekend the manager split by hand
-- keeps the same total: Friday takes 0.5 + ceil(extra)/2, Saturday
-- 0.5 + floor(extra)/2, so an odd half point goes to the first half. Weekday
-- duties are unchanged (1 + extra). lib/scheduling/calendar.ts canonicalDuties
-- and lib/rota/engine.ts blocks compute the same weights; duty_private
-- .generation_duties and the stored points column are the database's copies.
-- Stored points are recomputed for existing rows; only split weekend halves with
-- extra points change value.
ALTER TABLE public.duty_assignments DROP COLUMN points;
ALTER TABLE public.duty_assignments ADD COLUMN points numeric GENERATED ALWAYS AS ((
CASE
    WHEN (end_day = (day + 2)) THEN ((1)::numeric + extra_points)
    WHEN (EXTRACT(dow FROM day) = (5)::numeric) THEN (0.5 + (ceil(extra_points) / (2)::numeric))
    WHEN (EXTRACT(dow FROM day) = (6)::numeric) THEN (0.5 + (floor(extra_points) / (2)::numeric))
    ELSE ((1)::numeric + extra_points)
END)) STORED;
ALTER TABLE public.duty_assignments DROP CONSTRAINT duty_assignment_span;
ALTER TABLE public.duty_assignments ADD CONSTRAINT duty_assignment_span CHECK (((end_day = (day + 1)) OR ((EXTRACT(dow FROM day) = (5)::numeric) AND (end_day = (day + 2)))));

-- Canonicalize persisted calendar facts, filling absent ordinary blocks. Saturday
-- belongs to Friday's owner, even across a year. No client weights enter here.
CREATE OR REPLACE FUNCTION duty_private.generation_duties(p_month text) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
declare d date; until_day date; finish date; pub uuid; a public.duty_assignments;
 result jsonb:='[]'; split boolean; units bigint;
begin
 if p_month IS NULL or p_month !~ '^(19[0-9]{2}|[2-9][0-9]{3})-(0[1-9]|1[0-2])$' or p_month>='9999' then raise exception 'invalid-month'; end if;
 select case when status='published' then current_publication_id end into pub from public.duty_months where month=p_month;
 d:=(p_month||'-01')::date; finish:=(d+interval '1 month')::date;
 if extract(dow from d)=6 then d:=d+1; end if;
 if extract(dow from finish)=6 then finish:=finish+1; end if;
 while d<finish loop
  select * into a from public.duty_assignments where publication_id is not distinct from pub and day=d;
  split:=extract(dow from d)=5 and (coalesce(a.end_day=d+1,false) or exists(select 1 from public.duty_assignments where publication_id is not distinct from pub and day=d+1));
  until_day:=d+case when extract(dow from d)=5 and not split then 2 else 1 end;
  if a.id is not null and a.end_day<>until_day then raise exception 'noncanonical-duty'; end if;
  -- Combined weekend or weekday: 1 + extra. Hand-split halves: Friday 0.5 + ceil(extra)/2, Saturday 0.5 + floor(extra)/2.
  units:=duty_private.compensation_units(to_jsonb((case when until_day=d+2 then 1+coalesce(a.extra_points,0)
   when extract(dow from d)=5 then 0.5+ceil(coalesce(a.extra_points,0))/2 when extract(dow from d)=6 then 0.5+floor(coalesce(a.extra_points,0))/2
   else 1+coalesce(a.extra_points,0) end)*2),true);
  result:=result||jsonb_build_array(jsonb_build_object('id',d,'startDate',d,'endDate',until_day,'units',units,
   'primary',a.primary_id,'secondary',a.secondary_id,'title',coalesce(a.title,''),'extra',coalesce(a.extra_points,0),
   'weekendId',case when extract(dow from d)=5 then d when extract(dow from d)=6 then d-1 end));
  d:=until_day;
 end loop;
 if exists(select 1 from public.duty_assignments x where x.publication_id is not distinct from pub and duty_private.duty_owner(x.day)=p_month
  and not exists(select 1 from jsonb_array_elements(result) r where r->>'id'=x.day::text)) then raise exception 'noncanonical-duty'; end if;
 return result;
end $$;

-- Compensation date atoms of a combined weekend follow the same hand-split weights.
CREATE OR REPLACE FUNCTION duty_private.compensation_atoms(p jsonb) RETURNS jsonb
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
