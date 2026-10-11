CREATE TABLE public.duty_constraint_types (
    code text NOT NULL,
    label text NOT NULL
);

ALTER TABLE ONLY public.duty_constraint_types
    ADD CONSTRAINT duty_constraint_types_pkey PRIMARY KEY (code);

ALTER TABLE public.duty_constraint_types ENABLE ROW LEVEL SECURITY;
