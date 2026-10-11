CREATE FUNCTION public.duty_review_member(p_member uuid, p_status text, p_revision bigint) RETURNS void
    LANGUAGE sql
    SET search_path TO ''
    AS $$select duty_private.review_member(p_member,p_status,p_revision)$$;
