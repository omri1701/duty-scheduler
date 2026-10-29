CREATE FUNCTION duty_private.delete_publication(p_publication uuid, p_revision bigint) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare v public.duty_publications; replacement uuid;
begin
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 perform duty_private.check_revision(p_revision);
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 select * into v from public.duty_publications where id=p_publication;
 if v.id is null then raise exception 'Version no longer exists'; end if;
 select id into replacement from public.duty_publications where month=v.month and id<>v.id order by version desc limit 1;
 -- Deleting the final publication must not silently discard the only schedule.
 -- Keep an already-open draft, otherwise copy the version before deleting it.
 if replacement is null and exists(select 1 from public.duty_months where current_publication_id=v.id and status='published') then
  insert into public.duty_assignments(day,end_day,primary_id,secondary_id,manager_override,title,extra_points,locked)
  select day,end_day,primary_id,secondary_id,manager_override,title,extra_points,locked from public.duty_assignments
  where publication_id=v.id and duty_private.duty_owner(day)=v.month;
  insert into public.duty_allocations(month,publication_id,allocation_id,allocation,locks,approvals,accounting_fingerprint,calendar_fingerprint,source_publication_id,generation)
  select month,null,allocation_id,allocation,locks,approvals,accounting_fingerprint,calendar_fingerprint,p_publication,generation from public.duty_allocations where publication_id=p_publication;
 end if;
 update public.duty_months set current_publication_id=replacement,status=case when replacement is null then 'draft' else status end where current_publication_id=v.id;
 delete from public.duty_publications where id=v.id;
 update public.duty_workspace set revision=revision+1 where id;
end $$;
