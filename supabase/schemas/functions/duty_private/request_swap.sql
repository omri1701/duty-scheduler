CREATE FUNCTION duty_private.request_swap(p_from uuid, p_to uuid, p_explanation text, p_revision bigint) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare a public.duty_assignments; b public.duty_assignments; m text;
begin
 perform duty_private.check_revision(p_revision);
 -- Recheck after lock acquisition, including a membership change while waiting.
 if not duty_private.is_member() then raise exception 'Your membership is not approved' using errcode='42501'; end if;
 select * into a from public.duty_assignments where id=p_from;
 select * into b from public.duty_assignments where id=p_to;
 if a.primary_id is distinct from auth.uid() then raise exception 'Choose your own primary duty' using errcode='42501'; end if;
 if a.publication_id is null or b.publication_id is distinct from a.publication_id then raise exception 'Choose duties in the same current publication'; end if;
 perform duty_private.validate_swap(p_from,p_to,a.publication_id,false);
 select month into m from public.duty_months where current_publication_id=a.publication_id;
 insert into public.duty_swap_requests(month,source_publication_id,from_duty_id,to_duty_id,requester_id,other_id,from_day,from_end_day,to_day,to_end_day,explanation)
 values(m,a.publication_id,a.id,b.id,auth.uid(),b.primary_id,a.day,a.end_day,b.day,b.end_day,trim(coalesce(p_explanation,'')));
 update public.duty_workspace set revision=revision+1 where id;
end $$;
