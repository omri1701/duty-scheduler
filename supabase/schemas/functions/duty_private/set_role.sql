CREATE FUNCTION duty_private.set_role(p_member uuid, p_role text, p_revision bigint) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 perform duty_private.check_revision(p_revision);
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 update public.duty_members set role=p_role where id=p_member and status='approved';
 if not found then raise exception 'Approve this member first'; end if;
 perform duty_private.assert_admin_remains();
 update public.duty_workspace set revision=revision+1 where id;
end $$;
