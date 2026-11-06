-- Whether the caller has a calendar feed, and its language. Never returns the token or hash.
CREATE FUNCTION duty_private.calendar_status() RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
 select case when duty_private.is_member() then (select jsonb_build_object('createdAt',created_at,'language',language)
  from public.duty_calendar_feeds where member_id=auth.uid()) end
$$;
