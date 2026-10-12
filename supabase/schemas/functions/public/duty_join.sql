CREATE FUNCTION public.duty_join(p_name text) RETURNS void
    LANGUAGE sql
    SET search_path TO ''
    AS $$select duty_private.join_team(p_name)$$;
