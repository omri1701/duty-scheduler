CREATE TABLE public.duty_publications (
    month text NOT NULL,
    published_at timestamp with time zone DEFAULT now() NOT NULL,
    published_by uuid NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    version integer NOT NULL,
    CONSTRAINT duty_publications_version_check CHECK ((version > 0))
);

ALTER TABLE ONLY public.duty_publications
    ADD CONSTRAINT duty_publications_month_id_key UNIQUE (month, id);

ALTER TABLE ONLY public.duty_publications
    ADD CONSTRAINT duty_publications_month_version_key UNIQUE (month, version);

ALTER TABLE ONLY public.duty_publications
    ADD CONSTRAINT duty_publications_pkey PRIMARY KEY (id);

CREATE INDEX duty_publications_author ON public.duty_publications USING btree (published_by);

ALTER TABLE ONLY public.duty_publications
    ADD CONSTRAINT duty_publications_month_fkey FOREIGN KEY (month) REFERENCES public.duty_months(month);

ALTER TABLE ONLY public.duty_publications
    ADD CONSTRAINT duty_publications_published_by_fkey FOREIGN KEY (published_by) REFERENCES public.duty_members(id);

ALTER TABLE public.duty_publications ENABLE ROW LEVEL SECURITY;
