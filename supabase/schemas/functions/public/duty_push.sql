CREATE FUNCTION public.duty_set_language(p_language text) RETURNS void
    LANGUAGE sql
    SET search_path TO ''
    AS $$select duty_private.set_language(p_language)$$;

CREATE FUNCTION public.duty_notification_settings() RETURNS jsonb
    LANGUAGE sql
    SET search_path TO ''
    AS $$select duty_private.notification_settings()$$;

CREATE FUNCTION public.duty_set_notification_settings(p_settings jsonb) RETURNS jsonb
    LANGUAGE sql
    SET search_path TO ''
    AS $$select duty_private.set_notification_settings(p_settings)$$;

CREATE FUNCTION public.duty_save_push_subscription(p_endpoint text, p_p256dh text, p_auth text) RETURNS void
    LANGUAGE sql
    SET search_path TO ''
    AS $$select duty_private.save_push_subscription(p_endpoint,p_p256dh,p_auth)$$;

CREATE FUNCTION public.duty_delete_push_subscription(p_endpoint text) RETURNS void
    LANGUAGE sql
    SET search_path TO ''
    AS $$select duty_private.delete_push_subscription(p_endpoint)$$;
