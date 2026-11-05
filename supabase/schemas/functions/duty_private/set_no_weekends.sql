-- Standing non-weekend setting (decision 2026-11-01): Generate never places the member
-- on a weekend duty, and Plan the month proposes a +1 Permanent change each month.
-- Existing locked weekends are kept; the plan shows a warning for them.
-- Clearing it (decision 2026-11-05) rejoins the weekend rotation level with the team, like
-- a new member: weekends_from is the month after every month generated or published so far.
CREATE FUNCTION duty_private.set_no_weekends(p_member uuid, p_no_weekends boolean, p_revision bigint) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
begin
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 perform duty_private.check_revision(p_revision);
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 if p_no_weekends is null then raise exception 'Choose whether this member takes weekends'; end if;
 update public.duty_members set no_weekends=p_no_weekends,
  weekends_from=case when no_weekends and not p_no_weekends then coalesce((select to_char((max(month)||'-01')::date+interval '1 month','YYYY-MM')
   from public.duty_months where generated or current_publication_id is not null),weekends_from) else weekends_from end
  where id=p_member and status='approved';
 if not found then raise exception 'Approve this member first'; end if;
 update public.duty_workspace set revision=revision+1 where id;
end $$;
