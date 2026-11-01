CREATE FUNCTION public.duty_edit_published_duty(p_publication uuid, p_day date, p_primary uuid, p_extra_points numeric, p_saturday_extra_points numeric, p_kind text, p_revision bigint, p_override_reason text DEFAULT ''::text) RETURNS jsonb
    LANGUAGE sql
    SET search_path TO ''
    AS $$select duty_private.edit_published_duty(p_publication,p_day,p_primary,p_extra_points,p_saturday_extra_points,p_kind,p_revision,p_override_reason)$$;
