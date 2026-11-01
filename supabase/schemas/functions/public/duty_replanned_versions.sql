CREATE FUNCTION public.duty_replanned_versions(p_month text) RETURNS jsonb
 LANGUAGE sql SET search_path TO '' AS $$
 select duty_private.replanned_versions(p_month);
$$;
