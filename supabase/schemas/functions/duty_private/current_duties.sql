CREATE FUNCTION duty_private.current_duties() RETURNS SETOF public.duty_assignments
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
 select a.* from public.duty_assignments a
 join public.duty_months m on m.current_publication_id=a.publication_id
 where m.month=duty_private.duty_owner(a.day)
 or not exists(select 1 from public.duty_months owner where owner.month=duty_private.duty_owner(a.day) and owner.current_publication_id is not null)
$$;
