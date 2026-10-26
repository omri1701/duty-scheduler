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
    auth_user_id uuid GENERATED ALWAYS AS (CASE WHEN is_temporary THEN NULL::uuid ELSE id END) STORED,
    CONSTRAINT duty_members_identity_check CHECK ((is_temporary AND email IS NULL AND role = 'engineer' AND status = 'approved') OR (NOT is_temporary AND email IS NOT NULL)),
    CONSTRAINT duty_members_color_check CHECK ((color ~ '^#[0-9a-fA-F]{6}$'::text)),
    CONSTRAINT duty_members_name_check CHECK (((length(TRIM(BOTH FROM name)) >= 1) AND (length(TRIM(BOTH FROM name)) <= 80))),
    CONSTRAINT duty_members_seniority_check CHECK ((seniority >= 0))
);

ALTER TABLE ONLY public.duty_members
    ADD CONSTRAINT duty_members_email_key UNIQUE (email);

ALTER TABLE ONLY public.duty_members
    ADD CONSTRAINT duty_members_pkey PRIMARY KEY (id);

CREATE INDEX duty_members_role ON public.duty_members USING btree (role);

CREATE INDEX duty_members_status ON public.duty_members USING btree (status);

ALTER TABLE ONLY public.duty_members
    ADD CONSTRAINT duty_members_id_fkey FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.duty_members
    ADD CONSTRAINT duty_members_role_fkey FOREIGN KEY (role) REFERENCES public.duty_roles(code);

ALTER TABLE ONLY public.duty_members
    ADD CONSTRAINT duty_members_status_fkey FOREIGN KEY (status) REFERENCES public.duty_member_statuses(code);

ALTER TABLE public.duty_members ENABLE ROW LEVEL SECURITY;
