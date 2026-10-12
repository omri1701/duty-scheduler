CREATE FUNCTION public.duty_rename_self(p_name text, p_revision bigint) RETURNS void
    LANGUAGE sql
    SET search_path TO ''
    AS $$select duty_private.rename_self(p_name,p_revision)$$;
