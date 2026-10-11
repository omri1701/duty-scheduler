CREATE FUNCTION public.duty_restore_publication(p_publication uuid, p_revision bigint) RETURNS void
    LANGUAGE sql
    SET search_path TO ''
    AS $$select duty_private.restore_publication(p_publication,p_revision)$$;
