CREATE FUNCTION duty_private.check_revision(p_revision bigint) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare current_revision bigint;
begin
 if not duty_private.is_member() then raise exception 'Your membership is not approved' using errcode='42501'; end if;
 select revision into current_revision from public.duty_workspace where id for update;
 if current_revision is distinct from p_revision then raise exception 'The team data changed. Refresh and try again.' using errcode='40001'; end if;
end $$;


SET default_tablespace = '';

SET default_table_access_method = heap;
