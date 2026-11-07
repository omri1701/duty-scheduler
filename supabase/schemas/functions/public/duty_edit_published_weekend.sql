CREATE FUNCTION public.duty_edit_published_weekend(p_publication uuid, p_friday date, p_friday_primary uuid, p_friday_extra numeric, p_saturday_primary uuid, p_saturday_extra numeric, p_kind text, p_revision bigint, p_override_reason text DEFAULT ''::text) RETURNS jsonb
    LANGUAGE sql
    SET search_path TO ''
    AS $$select duty_private.edit_published_weekend(p_publication,p_friday,p_friday_primary,p_friday_extra,p_saturday_primary,p_saturday_extra,p_kind,p_revision,p_override_reason)$$;
