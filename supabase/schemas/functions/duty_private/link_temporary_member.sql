-- Link a pending sign-up to a temporary member (decision 2026-11-07). The two become one
-- person: the temporary member's row keeps its id, so every duty, publication, ledger lot,
-- allocation, availability note and swap stays as it is, and it gains the sign-in. It keeps
-- its name, colour, No-weekends setting, seniority and active state, and becomes a normal
-- engineer. The sign-up's email and language move to it, with any personal settings it
-- already saved, and the pending row is removed. Open swap sides waiting on the temporary
-- member now wait on that person (resolve_swap stops letting admins answer once the row
-- is no longer temporary). Admins only; cannot be undone.
CREATE FUNCTION duty_private.link_temporary_member(p_pending uuid, p_temporary uuid, p_revision bigint) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare s public.duty_members; t public.duty_members;
begin
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 perform duty_private.check_revision(p_revision);
 if not duty_private.is_manager() then raise exception 'Admin access required' using errcode='42501'; end if;
 select * into s from public.duty_members where id=p_pending for update;
 select * into t from public.duty_members where id=p_temporary for update;
 if s.id is null or s.is_temporary or s.status<>'pending' or s.role<>'engineer' or s.linked_user_id is not null or s.auth_user_id is distinct from s.id then
  raise exception 'This request is no longer pending';
 end if;
 if t.id is null or not t.is_temporary then raise exception 'Temporary member required'; end if;
 -- The ledger has no foreign keys: a debt an admin recorded for the sign-up would stay on a
 -- deleted id. Refuse instead (it is normally empty for a pending sign-up).
 if exists(select 1 from jsonb_each(duty_private.compensation_state()->'lots') l where s.id::text in (l.value->>'debtorId',l.value->>'creditorId')) then
  raise exception 'link-has-balance';
 end if;
 -- A pending sign-up has no member access, so these are normally empty; carry them anyway.
 update public.duty_push_subscriptions set member_id=t.id where member_id=s.id;
 update public.duty_notification_settings set member_id=t.id where member_id=s.id
  and not exists(select 1 from public.duty_notification_settings where member_id=t.id);
 update public.duty_calendar_feeds set member_id=t.id where member_id=s.id
  and not exists(select 1 from public.duty_calendar_feeds where member_id=t.id);
 -- Fails closed (foreign keys) if the sign-up somehow owns duties, availability or swaps.
 delete from public.duty_members where id=s.id;
 update public.duty_members set is_temporary=false,linked_user_id=s.id,email=s.email,language=coalesce(s.language,t.language)
  where id=t.id;
 update public.duty_workspace set revision=revision+1 where id;
end $$;
