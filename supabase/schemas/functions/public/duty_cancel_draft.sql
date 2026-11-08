CREATE FUNCTION public.duty_cancel_draft(p_month text, p_revision bigint) RETURNS void
    LANGUAGE sql
    SET search_path TO ''
    AS $$select duty_private.cancel_draft(p_month,p_revision)$$;
