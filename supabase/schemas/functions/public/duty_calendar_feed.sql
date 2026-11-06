CREATE FUNCTION public.duty_calendar_feed(p_token text) RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$select duty_private.calendar_feed(p_token)$$;
