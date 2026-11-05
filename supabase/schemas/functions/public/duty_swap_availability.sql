CREATE FUNCTION public.duty_swap_availability(p_from uuid, p_to uuid) RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$select duty_private.swap_availability(p_from,p_to)$$;
