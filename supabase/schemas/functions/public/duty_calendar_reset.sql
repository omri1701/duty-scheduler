CREATE FUNCTION public.duty_calendar_reset(p_language text) RETURNS jsonb
    LANGUAGE sql
    SET search_path TO ''
    AS $$select duty_private.calendar_reset(p_language)$$;
