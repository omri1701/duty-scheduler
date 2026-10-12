CREATE TABLE public.duty_member_statuses (
    code text NOT NULL,
    label text NOT NULL
);

ALTER TABLE ONLY public.duty_member_statuses
    ADD CONSTRAINT duty_member_statuses_pkey PRIMARY KEY (code);

ALTER TABLE public.duty_member_statuses ENABLE ROW LEVEL SECURITY;
