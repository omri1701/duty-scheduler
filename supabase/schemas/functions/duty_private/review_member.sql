CREATE FUNCTION duty_private.review_member(p_member uuid, p_status text, p_revision bigint) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 perform duty_private.check_revision(p_revision);
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 if p_status not in ('approved','rejected') or p_status is null then raise exception 'Invalid review'; end if;
 update public.duty_members set status=p_status,active=(p_status='approved'),seniority=(select coalesce(max(seniority),0)+1 from public.duty_members) where id=p_member and role='engineer' and status='pending';
 if not found then raise exception 'This request is no longer pending'; end if;
 update public.duty_workspace set revision=revision+1 where id;
end $$;
