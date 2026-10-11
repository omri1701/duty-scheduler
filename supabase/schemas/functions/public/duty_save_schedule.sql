CREATE FUNCTION public.duty_save_schedule(p_state jsonb, p_revision bigint, p_publish text DEFAULT NULL::text) RETURNS void
    LANGUAGE sql
    SET search_path TO ''
    AS $$select duty_private.save_schedule(p_state,p_revision,p_publish)$$;
