CREATE FUNCTION public.duty_add_temporary_member(p_name text, p_revision bigint) RETURNS uuid
 LANGUAGE sql SET search_path TO '' AS $$select duty_private.add_temporary_member(p_name,p_revision)$$;
