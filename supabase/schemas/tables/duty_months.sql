CREATE TABLE public.duty_months (
    month text NOT NULL,
    deadline date NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    generated boolean DEFAULT false NOT NULL,
    current_publication_id uuid,
    publication_sequence integer DEFAULT 0 NOT NULL,
    CONSTRAINT duty_months_month_check CHECK ((month ~ '^\d{4}-(0[1-9]|1[0-2])$'::text))
);

ALTER TABLE ONLY public.duty_months
    ADD CONSTRAINT duty_months_pkey PRIMARY KEY (month);

CREATE INDEX duty_months_publication ON public.duty_months USING btree (month, current_publication_id);

CREATE INDEX duty_months_status ON public.duty_months USING btree (status);

ALTER TABLE ONLY public.duty_months
    ADD CONSTRAINT duty_months_status_fkey FOREIGN KEY (status) REFERENCES public.duty_month_statuses(code);

ALTER TABLE public.duty_months ENABLE ROW LEVEL SECURITY;
