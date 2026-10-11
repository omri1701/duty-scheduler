CREATE FUNCTION public.duty_set_constraints(p_member uuid, p_days date[], p_kind text, p_note text, p_revision bigint) RETURNS void
    LANGUAGE sql
    SET search_path TO ''
    AS $$select duty_private.set_constraints(p_member,p_days,p_kind,p_note,p_revision)$$;
