CREATE TABLE public.duty_roles (
    code text NOT NULL,
    label text NOT NULL,
    can_manage boolean DEFAULT false NOT NULL
);

ALTER TABLE ONLY public.duty_roles
    ADD CONSTRAINT duty_roles_pkey PRIMARY KEY (code);

ALTER TABLE public.duty_roles ENABLE ROW LEVEL SECURITY;
