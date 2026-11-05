CREATE FUNCTION public.duty_set_no_weekends(p_member uuid, p_no_weekends boolean, p_revision bigint) RETURNS void
 LANGUAGE sql SET search_path TO '' AS $$select duty_private.set_no_weekends(p_member,p_no_weekends,p_revision)$$;
