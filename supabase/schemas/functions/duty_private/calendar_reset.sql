-- Create or reset the caller's own calendar feed (decision 2026-11-06). Returns the new raw
-- token exactly once; only its hash is stored, so the previous URL stops working at once.
-- Personal, not team data: no workspace revision. 64 hex characters from two random UUIDs
-- (244 random bits, pg_strong_random).
CREATE FUNCTION duty_private.calendar_reset(p_language text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare token text:=replace(gen_random_uuid()::text||gen_random_uuid()::text,'-',''); saved public.duty_calendar_feeds;
begin
 if not duty_private.is_member() then raise exception 'calendar-member-required' using errcode='42501'; end if;
 if p_language is null or p_language not in ('en','he') then raise exception 'invalid-calendar-language'; end if;
 insert into public.duty_calendar_feeds(member_id,token_hash,language,created_at)
 values(duty_private.current_member_id(),sha256(convert_to(token,'UTF8')),p_language,now())
 on conflict (member_id) do update set token_hash=excluded.token_hash,language=excluded.language,created_at=excluded.created_at
 returning * into saved;
 return jsonb_build_object('token',token,'createdAt',saved.created_at,'language',saved.language);
end $$;
