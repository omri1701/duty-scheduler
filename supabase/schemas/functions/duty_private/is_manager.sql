CREATE FUNCTION duty_private.is_manager() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
 select auth.uid() is not null and exists(select 1 from public.duty_members m join public.duty_roles r on r.code=m.role where m.auth_user_id=auth.uid() and r.can_manage and m.status='approved' and m.active)
$$;
