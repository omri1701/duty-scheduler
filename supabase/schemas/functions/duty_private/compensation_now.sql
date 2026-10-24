CREATE FUNCTION duty_private.compensation_now() RETURNS bigint
 LANGUAGE sql VOLATILE SET search_path TO '' AS $$
 select floor(extract(epoch from clock_timestamp())*1000)::bigint;
$$;
