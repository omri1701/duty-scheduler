CREATE FUNCTION public.duty_balance() RETURNS jsonb
 LANGUAGE sql SET search_path TO '' AS $$
 select duty_private.balance();
$$;
