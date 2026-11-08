-- Accounting snapshots exclude secondary cover, titles and private notes. A combined
-- weekend also carries Saturday's own units so each date atom keeps its own points.
CREATE FUNCTION duty_private.compensation_snapshot(publication uuid) RETURNS jsonb
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $$
 select jsonb_build_object('id',p.id,'month',p.month,'intents','[]'::jsonb,'reservations','[]'::jsonb,'duties',coalesce(
  (select jsonb_agg(jsonb_build_object('startDate',a.day,'endDate',a.end_day,'primaryId',a.primary_id,'units',a.points*2)
    ||case when a.end_day=a.day+2 then jsonb_build_object('saturdayUnits',1+a.saturday_extra_points*2) else '{}'::jsonb end order by a.day)
   from public.duty_assignments a where a.publication_id=p.id and duty_private.duty_owner(a.day)=p.month),'[]'::jsonb))
 from public.duty_publications p where p.id=publication;
$$;
