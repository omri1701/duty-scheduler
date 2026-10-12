CREATE TABLE public.duty_month_statuses (
    code text NOT NULL,
    label text NOT NULL
);

ALTER TABLE ONLY public.duty_month_statuses
    ADD CONSTRAINT duty_month_statuses_pkey PRIMARY KEY (code);

ALTER TABLE public.duty_month_statuses ENABLE ROW LEVEL SECURITY;
