CREATE FUNCTION duty_private.cancel_draft(p_month text, p_revision bigint) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare m public.duty_months;
begin
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 perform duty_private.check_revision(p_revision);
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 select * into m from public.duty_months where month=p_month;
 if m.current_publication_id is null or m.status<>'draft' then raise exception 'A reopened published month is required'; end if;
 delete from public.duty_assignments where publication_id is null and duty_private.duty_owner(day)=p_month;
 update public.duty_months set status='published',generated=true where month=p_month;
 update public.duty_workspace set revision=revision+1 where id;
end $$;
