CREATE FUNCTION public.duty_resolve_swap(p_request uuid, p_action text, p_revision bigint, p_override_reason text DEFAULT ''::text) RETURNS text
    LANGUAGE sql
    SET search_path TO ''
    AS $$select duty_private.resolve_swap(p_request,p_action,p_revision,p_override_reason)$$;
