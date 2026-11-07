-- The caller's own member row id (decision 2026-11-07). Equal to auth.uid() for a member who
-- joined; a sign-up linked to a former temporary member owns that member's original id.
-- NULL when signed out or without a row. Never use auth.uid() as a member id.
CREATE FUNCTION duty_private.current_member_id() RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
 select id from public.duty_members where auth.uid() is not null and auth_user_id=auth.uid()
$$;
