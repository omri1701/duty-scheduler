CREATE FUNCTION duty_private.rename_self(p_name text, p_revision bigint) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
 perform duty_private.check_revision(p_revision);
 if length(trim(coalesce(p_name,''))) not between 1 and 80 then raise exception 'Use a name between 1 and 80 characters'; end if;
 update public.duty_members set name=trim(p_name) where id=auth.uid();
 update public.duty_workspace set revision=revision+1 where id;
end $$;
