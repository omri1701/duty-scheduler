CREATE FUNCTION public.duty_save_generation(p_month text, p_assignments jsonb, p_revision bigint, p_fingerprint text, p_seed integer) RETURNS jsonb
 LANGUAGE sql SET search_path TO '' AS $$
 select duty_private.save_generation(p_month,p_assignments,p_revision,p_fingerprint,p_seed);
$$;
