CREATE FUNCTION public.duty_calendar_language(p_language text) RETURNS void
    LANGUAGE sql
    SET search_path TO ''
    AS $$select duty_private.calendar_language(p_language)$$;
