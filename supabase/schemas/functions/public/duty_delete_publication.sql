CREATE FUNCTION public.duty_delete_publication(p_publication uuid, p_revision bigint) RETURNS void
    LANGUAGE sql
    SET search_path TO ''
    AS $$select duty_private.delete_publication(p_publication,p_revision)$$;
