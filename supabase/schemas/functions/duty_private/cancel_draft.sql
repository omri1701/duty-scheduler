CREATE FUNCTION duty_private.cancel_draft(p_month text, p_revision bigint) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare m public.duty_months; d date; conflict record;
begin
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 perform duty_private.check_revision(p_revision);
 select * into m from public.duty_months where month=p_month;
 if m.current_publication_id is null or m.status<>'draft' then raise exception 'A reopened published month is required'; end if;
 -- The pointer is read under the workspace revision lock, never supplied by a client.
 -- Saturday (including a special/split Saturday) belongs to its Friday's month.
 for d in select generate_series((p_month||'-01')::date, (p_month||'-01')::date+interval '1 month',interval '1 day')::date loop
  if duty_private.duty_owner(d)=p_month and (select count(*) from public.duty_assignments a where a.publication_id=m.current_publication_id and duty_private.duty_owner(a.day)=p_month and a.day<=d and a.end_day>d)<>1 then
   raise exception 'Published coverage is inconsistent on %; no changes were made',d;
  end if;
 end loop;
 select a.day,a.end_day,b.day as other_day,b.end_day as other_end into conflict
 from public.duty_assignments a join public.duty_assignments b on a.day<b.end_day and b.day<a.end_day
 where a.publication_id=m.current_publication_id and duty_private.duty_owner(a.day)=p_month
 and b.publication_id is null and duty_private.duty_owner(b.day)<>p_month limit 1;
 if found then raise exception 'Published duty [% - %) conflicts with another month duty [% - %); no changes were made',conflict.day,conflict.end_day,conflict.other_day,conflict.other_end; end if;
 delete from public.duty_assignments where publication_id is null and duty_private.duty_owner(day)=p_month;
 insert into public.duty_assignments(day,end_day,primary_id,secondary_id,manager_override,title,extra_points)
 select day,end_day,primary_id,secondary_id,manager_override,title,extra_points from public.duty_assignments
 where publication_id=m.current_publication_id and duty_private.duty_owner(day)=p_month;
 update public.duty_months set status='published',generated=true where month=p_month;
 update public.duty_workspace set revision=revision+1 where id;
end $$;
