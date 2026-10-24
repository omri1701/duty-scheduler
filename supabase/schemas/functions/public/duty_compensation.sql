CREATE FUNCTION public.duty_compensation(p_operation jsonb, p_source_key text, p_reason text, p_revision bigint, p_fingerprint text DEFAULT NULL, p_cutoff bigint DEFAULT NULL) RETURNS jsonb
 LANGUAGE sql SET search_path TO '' AS $$
 select duty_private.compensation(p_operation,p_source_key,p_reason,p_revision,p_fingerprint,p_cutoff);
$$;
