CREATE FUNCTION public.duty_request_swap(p_from uuid, p_to uuid, p_explanation text, p_revision bigint) RETURNS void
    LANGUAGE sql
    SET search_path TO ''
    AS $$select duty_private.request_swap(p_from,p_to,p_explanation,p_revision)$$;
