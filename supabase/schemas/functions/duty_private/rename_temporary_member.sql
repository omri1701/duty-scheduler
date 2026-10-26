CREATE FUNCTION duty_private.rename_temporary_member(p_member uuid, p_name text, p_revision bigint) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
begin
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 perform duty_private.check_revision(p_revision);
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 if length(trim(coalesce(p_name,''))) not between 1 and 80 then raise exception 'Use a name between 1 and 80 characters'; end if;
 update public.duty_members set name=trim(p_name) where id=p_member and is_temporary;
 if not found then raise exception 'Temporary member required'; end if;
 update public.duty_workspace set revision=revision+1 where id;
end $$;
