CREATE FUNCTION duty_private.duty_owner(p_day date) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
 select to_char(case when extract(dow from p_day)=6 then p_day-1 else p_day end,'YYYY-MM')
$$;
