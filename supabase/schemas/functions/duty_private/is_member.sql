CREATE FUNCTION duty_private.is_member() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
 select auth.uid() is not null and exists(select 1 from public.duty_members where auth_user_id=auth.uid() and status='approved' and active)
$$;
