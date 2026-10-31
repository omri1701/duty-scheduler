CREATE FUNCTION duty_private.restore_publication(p_publication uuid, p_revision bigint) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare v public.duty_publications;
begin
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 perform duty_private.check_revision(p_revision);
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 select * into v from public.duty_publications where id=p_publication;
 if v.id is null then raise exception 'Version no longer exists'; end if;
 -- Old versions may contain adjacent coverage. Only Friday-owned rows belong
 -- to this draft; retain the original historical publication byte-for-byte.
 delete from public.duty_assignments where publication_id is null and duty_private.duty_owner(day)=v.month;
 insert into public.duty_assignments(day,end_day,primary_id,secondary_id,manager_override,title,extra_points,saturday_extra_points,locked)
 select day,end_day,primary_id,secondary_id,manager_override,title,extra_points,saturday_extra_points,locked
 from public.duty_assignments where publication_id=p_publication and duty_private.duty_owner(day)=v.month;
 delete from public.duty_allocations where month=v.month and publication_id is null;
 insert into public.duty_allocations(month,publication_id,allocation_id,allocation,locks,approvals,accounting_fingerprint,calendar_fingerprint,source_publication_id,generation,origin)
 select month,null,allocation_id,allocation,locks,approvals,md5((duty_private.compensation_state()->'events')::text),calendar_fingerprint,p_publication,generation,'restored' from public.duty_allocations where publication_id=p_publication;
 update public.duty_months set status='draft',generated=true where month=v.month;
 update public.duty_workspace set revision=revision+1 where id;
end $$;
