CREATE FUNCTION public.duty_confirm_allocation(p_month text, p_allocation jsonb, p_locks jsonb, p_approvals jsonb, p_revision bigint, p_fingerprint text) RETURNS jsonb
 LANGUAGE sql SET search_path TO '' AS $$
 select duty_private.confirm_allocation(p_month,p_allocation,p_locks,p_approvals,p_revision,p_fingerprint);
$$;
