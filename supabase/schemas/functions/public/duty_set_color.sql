CREATE FUNCTION public.duty_set_color(p_color text, p_revision bigint) RETURNS void
    LANGUAGE sql
    SET search_path TO ''
    AS $$select duty_private.set_color(p_color,p_revision)$$;
