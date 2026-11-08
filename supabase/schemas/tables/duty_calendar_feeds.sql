-- Personal calendar subscription (decision 2026-11-06). One revocable feed per member:
-- calendar apps cannot sign in, so the feed URL carries a long random token. Only its
-- SHA-256 hash is stored; resetting replaces the hash, so the old URL stops working.
-- Rows are written only by duty_private.calendar_reset/calendar_language for the caller.
CREATE TABLE public.duty_calendar_feeds (
    member_id uuid NOT NULL,
    token_hash bytea NOT NULL,
    language text DEFAULT 'en'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT duty_calendar_feeds_token_hash_check CHECK ((length(token_hash) = 32)),
    CONSTRAINT duty_calendar_feeds_language_check CHECK ((language = ANY (ARRAY['en'::text, 'he'::text])))
);

ALTER TABLE ONLY public.duty_calendar_feeds
    ADD CONSTRAINT duty_calendar_feeds_pkey PRIMARY KEY (member_id);

ALTER TABLE ONLY public.duty_calendar_feeds
    ADD CONSTRAINT duty_calendar_feeds_token_hash_key UNIQUE (token_hash);

ALTER TABLE ONLY public.duty_calendar_feeds
    ADD CONSTRAINT duty_calendar_feeds_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.duty_members(id) ON DELETE CASCADE;

ALTER TABLE public.duty_calendar_feeds ENABLE ROW LEVEL SECURITY;
