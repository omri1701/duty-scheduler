CREATE TABLE public.duty_members (
    id uuid NOT NULL,
    email text,
    name text NOT NULL,
    role text DEFAULT 'engineer'::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    active boolean DEFAULT false NOT NULL,
    seniority integer DEFAULT 0 NOT NULL,
    color text DEFAULT '#adc9ee'::text NOT NULL,
    joined_at timestamp with time zone DEFAULT now() NOT NULL,
    is_temporary boolean DEFAULT false NOT NULL,
    -- The sign-in that owns this row: its own id for a member who joined, the linked sign-up
    -- for a former temporary member (duty_private.link_temporary_member), NULL while temporary.
    auth_user_id uuid GENERATED ALWAYS AS (CASE WHEN is_temporary THEN NULL::uuid ELSE COALESCE(linked_user_id, id) END) STORED,
    -- Standing admin setting: Generate never places this member on a weekend duty
    -- (lib/scheduling/domain.ts, duty_private.generation_validate).
    no_weekends boolean DEFAULT false NOT NULL,
    -- Set when the setting is cleared (decision 2026-11-05): the weekend rotation ignores
    -- the member's duties in months before this one, so they rejoin level, like a new member.
    weekends_from text,
    -- The member's own app language (decision 2026-11-06): the default on sign-in and on a
    -- new device, and the language of their notifications. NULL until they first choose.
    -- Only duty_private.set_language writes it, for the caller's own row (and a link carries
    -- the sign-up's choice over).
    language text,
    -- Set once, only by duty_private.link_temporary_member (decision 2026-11-07): the sign-up
    -- that took over this former temporary member. The row keeps its id, so no history moves.
    linked_user_id uuid,
    CONSTRAINT duty_members_identity_check CHECK ((is_temporary AND email IS NULL AND role = 'engineer' AND status = 'approved') OR (NOT is_temporary AND email IS NOT NULL)),
    CONSTRAINT duty_members_link_check CHECK ((linked_user_id IS NULL OR NOT is_temporary)),
    CONSTRAINT duty_members_color_check CHECK ((color ~ '^#[0-9a-fA-F]{6}$'::text)),
    CONSTRAINT duty_members_name_check CHECK (((length(TRIM(BOTH FROM name)) >= 1) AND (length(TRIM(BOTH FROM name)) <= 80))),
    CONSTRAINT duty_members_seniority_check CHECK ((seniority >= 0)),
    CONSTRAINT duty_members_language_check CHECK ((language = ANY (ARRAY['en'::text, 'he'::text]))),
    CONSTRAINT duty_members_weekends_from_check CHECK ((weekends_from ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'::text))
);

ALTER TABLE ONLY public.duty_members
    ADD CONSTRAINT duty_members_email_key UNIQUE (email);

ALTER TABLE ONLY public.duty_members
    ADD CONSTRAINT duty_members_pkey PRIMARY KEY (id);

-- One member row per sign-in, linked or not.
CREATE UNIQUE INDEX duty_members_auth_user ON public.duty_members USING btree (auth_user_id);

CREATE INDEX duty_members_role ON public.duty_members USING btree (role);

CREATE INDEX duty_members_status ON public.duty_members USING btree (status);

ALTER TABLE ONLY public.duty_members
    ADD CONSTRAINT duty_members_id_fkey FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.duty_members
    ADD CONSTRAINT duty_members_role_fkey FOREIGN KEY (role) REFERENCES public.duty_roles(code);

ALTER TABLE ONLY public.duty_members
    ADD CONSTRAINT duty_members_status_fkey FOREIGN KEY (status) REFERENCES public.duty_member_statuses(code);

ALTER TABLE public.duty_members ENABLE ROW LEVEL SECURITY;
