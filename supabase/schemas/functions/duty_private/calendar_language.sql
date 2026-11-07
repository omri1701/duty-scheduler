-- The caller's feed follows the language they use the app in; the URL stays the same.
CREATE FUNCTION duty_private.calendar_language(p_language text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
 if not duty_private.is_member() then raise exception 'calendar-member-required' using errcode='42501'; end if;
 if p_language is null or p_language not in ('en','he') then raise exception 'invalid-calendar-language'; end if;
 update public.duty_calendar_feeds set language=p_language where member_id=duty_private.current_member_id();
end $$;
