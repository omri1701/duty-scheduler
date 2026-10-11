CREATE FUNCTION duty_private.restore_publication(p_publication uuid, p_revision bigint) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare v public.duty_publications; first_day date; last_day date;
begin
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 perform duty_private.check_revision(p_revision);
 select * into v from public.duty_publications where id=p_publication;
 if v.id is null then raise exception 'Version no longer exists'; end if;
 select min(day),max(end_day) into first_day,last_day from public.duty_assignments where publication_id=p_publication;
 -- Restoring boundary weekends may also reopen the adjacent month's draft.
 update public.duty_months set status='draft' where (month||'-01')::date<last_day and (month||'-01')::date+interval '1 month'>first_day;
 -- Preserve the Friday half when restoring a version that starts on a split Saturday.
 update public.duty_months set status='draft' where month in (select to_char(day,'YYYY-MM') from public.duty_assignments where publication_id is null and day<first_day and end_day>first_day);
 update public.duty_assignments set end_day=first_day where publication_id is null and day<first_day and end_day>first_day;
 delete from public.duty_assignments where publication_id is null and day<last_day and end_day>first_day;
 insert into public.duty_assignments(day,end_day,primary_id,secondary_id,manager_override,title,extra_points)
 select day,end_day,primary_id,secondary_id,manager_override,title,extra_points from public.duty_assignments where publication_id=p_publication;
 update public.duty_months set status='draft',generated=true where month=v.month;
 update public.duty_workspace set revision=revision+1 where id;
end $$;
