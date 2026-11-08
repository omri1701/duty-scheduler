CREATE FUNCTION public.duty_calendar_status() RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$select duty_private.calendar_status()$$;
