CREATE FUNCTION public.duty_generation_context(p_month text, p_revision bigint) RETURNS jsonb
 LANGUAGE sql SET search_path TO '' AS $$
 select duty_private.generation_context(p_month,p_revision);
$$;
