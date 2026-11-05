CREATE FUNCTION duty_private.swap_availability(p_from uuid, p_to uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare a public.duty_assignments; b public.duty_assignments; admin boolean:=duty_private.is_manager();
begin
 if not duty_private.is_member() then raise exception 'Your membership is not approved' using errcode='42501'; end if;
 select * into a from public.duty_assignments where id=p_from;
 select * into b from public.duty_assignments where id=p_to;
 if a.publication_id is null or b.publication_id is distinct from a.publication_id
  or not exists(select 1 from public.duty_months where current_publication_id=a.publication_id) then
  raise exception 'Choose duties in the same current publication';
 end if;
 -- Only the two members (or an admin) learn whose availability blocks this swap,
 -- and members only for a pair they could still request.
 if not admin then
  if auth.uid() is distinct from a.primary_id and auth.uid() is distinct from b.primary_id then
   raise exception 'Choose your own primary duty' using errcode='42501';
  end if;
  if a.primary_id is null or b.primary_id is null or a.primary_id=b.primary_id
   or least(a.day,b.day)<(now() at time zone 'Asia/Jerusalem')::date then
   raise exception 'Choose duties starting today or later';
  end if;
 end if;
 -- Exactly the conflicts validate_swap refuses: which date, never the note. Members
 -- learn the two primaries by name; emergency cover stays anonymous to them.
 return coalesce((select jsonb_agg(jsonb_build_object('member',case when admin or c.member_id in (a.primary_id,b.primary_id) then c.member_id end,'day',c.day) order by c.day,c.member_id)
  from public.duty_constraints c where c.kind='no' and
  ((c.member_id in (b.primary_id,a.secondary_id) and c.day>=a.day and c.day<a.end_day)
   or (c.member_id in (a.primary_id,b.secondary_id) and c.day>=b.day and c.day<b.end_day))),'[]'::jsonb);
end $$;
