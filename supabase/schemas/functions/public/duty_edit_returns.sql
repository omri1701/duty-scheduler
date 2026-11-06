CREATE FUNCTION public.duty_edit_returns(p_publication uuid, p_day date) RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$select duty_private.edit_returns(p_publication,p_day)$$;
