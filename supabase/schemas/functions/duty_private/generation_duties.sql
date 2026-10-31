-- Canonicalize persisted calendar facts, filling absent ordinary blocks. Saturday
-- belongs to Friday's owner, even across a year. No client weights enter here.
CREATE FUNCTION duty_private.generation_duties(p_month text) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
declare d date; until_day date; finish date; pub uuid; a public.duty_assignments;
 result jsonb:='[]'; split boolean; half boolean; units bigint; extra numeric; other numeric;
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
  -- Both halves of a hand-split weekend carry the weekend's extra; differing halves are not canonical.
  half:=extract(dow from d) in (5,6) and until_day=d+1; extra:=coalesce(a.extra_points,0);
  if half then
   select extra_points into other from public.duty_assignments where publication_id is not distinct from pub and day=case when extract(dow from d)=5 then d+1 else d-1 end;
   if a.id is not null and other is not null and other<>extra then raise exception 'noncanonical-duty'; end if;
   extra:=greatest(extra,coalesce(other,0));
  end if;
  -- Combined weekend or weekday: 1 + extra. Hand-split halves: Friday 0.5 + ceil(extra)/2, Saturday 0.5 + floor(extra)/2.
  units:=duty_private.compensation_units(to_jsonb((case when until_day=d+2 then 1+extra
   when extract(dow from d)=5 then 0.5+ceil(extra)/2 when extract(dow from d)=6 then 0.5+floor(extra)/2
   else 1+extra end)*2),true);
  result:=result||jsonb_build_array(jsonb_build_object('id',d,'startDate',d,'endDate',until_day,'units',units,
   'primary',a.primary_id,'secondary',a.secondary_id,'title',coalesce(a.title,''),'extra',extra,
   'weekendId',case when extract(dow from d)=5 then d when extract(dow from d)=6 then d-1 end));
  d:=until_day;
 end loop;
 if exists(select 1 from public.duty_assignments x where x.publication_id is not distinct from pub and duty_private.duty_owner(x.day)=p_month
  and not exists(select 1 from jsonb_array_elements(result) r where r->>'id'=x.day::text)) then raise exception 'noncanonical-duty'; end if;
 return result;
end $$;
