CREATE FUNCTION duty_private.compensation_immutable() RETURNS trigger
 LANGUAGE plpgsql SET search_path TO '' AS $$
#variable_conflict use_column
begin
 raise exception 'Compensation audit history is append-only' using errcode='42501';
end $$;
