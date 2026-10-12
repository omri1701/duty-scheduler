CREATE FUNCTION duty_private.assert_admin_remains() RETURNS void
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
 if not exists(select 1 from public.duty_members m join public.duty_roles r on r.code=m.role where m.active and m.status='approved' and r.can_manage) then raise exception 'Keep at least one active admin'; end if;
end $$;
