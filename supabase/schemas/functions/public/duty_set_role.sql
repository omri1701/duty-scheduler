CREATE FUNCTION public.duty_set_role(p_member uuid, p_role text, p_revision bigint) RETURNS void
    LANGUAGE sql
    SET search_path TO ''
    AS $$select duty_private.set_role(p_member,p_role,p_revision)$$;
