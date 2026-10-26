CREATE FUNCTION public.duty_rename_temporary_member(p_member uuid, p_name text, p_revision bigint) RETURNS void
 LANGUAGE sql SET search_path TO '' AS $$select duty_private.rename_temporary_member(p_member,p_name,p_revision)$$;
