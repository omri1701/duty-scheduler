-- Web push (decision 2026-11-06). Members read only their own rows; every write goes
-- through a checked RPC (settings, devices) or SECURITY DEFINER triggers and the
-- scheduler (notifications, deliveries). Nothing here holds constraint notes.

-- Per-member switches; a missing row means every default (all on, 18:00 and 08:30).
CREATE TABLE public.duty_notification_settings (
    member_id uuid NOT NULL,
    deadlines boolean DEFAULT true NOT NULL,
    published boolean DEFAULT true NOT NULL,
    swaps boolean DEFAULT true NOT NULL,
    edits boolean DEFAULT true NOT NULL,
    evening boolean DEFAULT true NOT NULL,
    evening_time time without time zone DEFAULT '18:00:00'::time without time zone NOT NULL,
    morning boolean DEFAULT true NOT NULL,
    morning_time time without time zone DEFAULT '08:30:00'::time without time zone NOT NULL,
    members boolean DEFAULT true NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT duty_notification_settings_minutes_check CHECK (((EXTRACT(second FROM evening_time) = (0)::numeric) AND (EXTRACT(second FROM morning_time) = (0)::numeric)))
);

ALTER TABLE ONLY public.duty_notification_settings
    ADD CONSTRAINT duty_notification_settings_pkey PRIMARY KEY (member_id);

ALTER TABLE ONLY public.duty_notification_settings
    ADD CONSTRAINT duty_notification_settings_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.duty_members(id) ON DELETE CASCADE;

ALTER TABLE public.duty_notification_settings ENABLE ROW LEVEL SECURITY;

-- One row per device (browser push subscription). An endpoint belongs to whoever
-- registered it last; the push service's 404/410 deletes it.
CREATE TABLE public.duty_push_subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    member_id uuid NOT NULL,
    endpoint text NOT NULL,
    p256dh text NOT NULL,
    auth text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT duty_push_subscriptions_endpoint_check CHECK (((length(endpoint) >= 20) AND (length(endpoint) <= 1000) AND (endpoint ~ '^https://[^/?#@]+/'::text))),
    CONSTRAINT duty_push_subscriptions_p256dh_check CHECK ((p256dh ~ '^[A-Za-z0-9_-]{80,100}$'::text)),
    CONSTRAINT duty_push_subscriptions_auth_check CHECK ((auth ~ '^[A-Za-z0-9_-]{16,44}$'::text))
);

ALTER TABLE ONLY public.duty_push_subscriptions
    ADD CONSTRAINT duty_push_subscriptions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.duty_push_subscriptions
    ADD CONSTRAINT duty_push_subscriptions_endpoint_key UNIQUE (endpoint);

CREATE INDEX duty_push_subscriptions_member ON public.duty_push_subscriptions USING btree (member_id, last_seen_at DESC);

ALTER TABLE ONLY public.duty_push_subscriptions
    ADD CONSTRAINT duty_push_subscriptions_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.duty_members(id) ON DELETE CASCADE;

ALTER TABLE public.duty_push_subscriptions ENABLE ROW LEVEL SECURITY;

-- What was decided for whom: one row per member and event. The unique dedupe key
-- makes every trigger and scheduler run idempotent. Params hold only dates, the
-- month, a version number and (for admins) a joining member's name; the text is
-- written in the member's language when it is sent (lib/push/messages.ts).
CREATE TABLE public.duty_push_notifications (
    id bigint NOT NULL GENERATED ALWAYS AS IDENTITY,
    member_id uuid NOT NULL,
    kind text NOT NULL,
    dedupe_key text NOT NULL,
    params jsonb DEFAULT '{}'::jsonb NOT NULL,
    url text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_at timestamp with time zone,
    CONSTRAINT duty_push_notifications_kind_check CHECK ((kind = ANY (ARRAY['deadline_3'::text, 'deadline_1'::text, 'published'::text, 'republished'::text, 'edit'::text, 'swap_new'::text, 'swap_accepted'::text, 'swap_awaiting_admin'::text, 'swap_declined'::text, 'swap_rejected'::text, 'swap_approved'::text, 'remind_evening'::text, 'remind_morning'::text, 'member_waiting'::text, 'test'::text]))),
    CONSTRAINT duty_push_notifications_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'dispatched'::text, 'skipped'::text, 'expired'::text]))),
    CONSTRAINT duty_push_notifications_url_check CHECK ((url ~ '^/\?[a-z]+=[A-Za-z0-9=&_-]*$'::text)),
    CONSTRAINT duty_push_notifications_params_check CHECK (((jsonb_typeof(params) = 'object'::text) AND (length((params)::text) <= 500)))
);

ALTER TABLE ONLY public.duty_push_notifications
    ADD CONSTRAINT duty_push_notifications_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.duty_push_notifications
    ADD CONSTRAINT duty_push_notifications_dedupe_key_key UNIQUE (dedupe_key);

CREATE INDEX duty_push_notifications_member ON public.duty_push_notifications USING btree (member_id, created_at DESC);

CREATE INDEX duty_push_notifications_pending ON public.duty_push_notifications USING btree (created_at) WHERE (status = 'pending'::text);

ALTER TABLE ONLY public.duty_push_notifications
    ADD CONSTRAINT duty_push_notifications_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.duty_members(id) ON DELETE CASCADE;

ALTER TABLE public.duty_push_notifications ENABLE ROW LEVEL SECURITY;

-- One row per notification and device. 'sending' carries the pg_net request whose
-- response settles it. Only explicit refusals before any send are retried
-- ('failed'); a lost response is 'unknown' and never resent, so nothing repeats.
CREATE TABLE public.duty_push_deliveries (
    id bigint NOT NULL GENERATED ALWAYS AS IDENTITY,
    notification_id bigint NOT NULL,
    subscription_id uuid,
    status text DEFAULT 'queued'::text NOT NULL,
    request_id bigint,
    http_status integer,
    attempts integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT duty_push_deliveries_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'sending'::text, 'sent'::text, 'failed'::text, 'gone'::text, 'rejected'::text, 'unknown'::text, 'abandoned'::text])))
);

ALTER TABLE ONLY public.duty_push_deliveries
    ADD CONSTRAINT duty_push_deliveries_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.duty_push_deliveries
    ADD CONSTRAINT duty_push_deliveries_notification_subscription_key UNIQUE (notification_id, subscription_id);

CREATE INDEX duty_push_deliveries_open ON public.duty_push_deliveries USING btree (status, updated_at) WHERE (status = ANY (ARRAY['queued'::text, 'sending'::text, 'failed'::text]));

CREATE INDEX duty_push_deliveries_request ON public.duty_push_deliveries USING btree (request_id);

CREATE INDEX duty_push_deliveries_subscription ON public.duty_push_deliveries USING btree (subscription_id);

ALTER TABLE ONLY public.duty_push_deliveries
    ADD CONSTRAINT duty_push_deliveries_notification_id_fkey FOREIGN KEY (notification_id) REFERENCES public.duty_push_notifications(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.duty_push_deliveries
    ADD CONSTRAINT duty_push_deliveries_subscription_id_fkey FOREIGN KEY (subscription_id) REFERENCES public.duty_push_subscriptions(id) ON DELETE SET NULL;

ALTER TABLE public.duty_push_deliveries ENABLE ROW LEVEL SECURITY;
