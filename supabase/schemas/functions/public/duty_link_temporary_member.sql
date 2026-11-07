CREATE FUNCTION public.duty_link_temporary_member(p_pending uuid, p_temporary uuid, p_revision bigint) RETURNS void
    LANGUAGE sql
    SET search_path TO ''
    AS $$select duty_private.link_temporary_member(p_pending,p_temporary,p_revision)$$;
