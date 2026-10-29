CREATE TABLE public.duty_assignments (
    day date NOT NULL,
    primary_id uuid,
    secondary_id uuid,
    manager_override boolean DEFAULT false NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    publication_id uuid,
    end_day date NOT NULL,
    title text DEFAULT ''::text NOT NULL,
    extra_points numeric DEFAULT 0 NOT NULL,
    points numeric GENERATED ALWAYS AS ((
CASE
    WHEN (end_day = (day + 2)) THEN (1)::numeric
    WHEN (EXTRACT(dow FROM day) = ANY (ARRAY[(5)::numeric, (6)::numeric])) THEN 0.5
    ELSE (1)::numeric
END + extra_points)) STORED,
    locked boolean DEFAULT false NOT NULL,
    CONSTRAINT duty_assignment_lock_primary CHECK (NOT locked OR primary_id IS NOT NULL),
    CONSTRAINT duty_assignment_span CHECK (((end_day = (day + 1)) OR ((EXTRACT(dow FROM day) = (5)::numeric) AND (end_day = (day + 2)) AND (extra_points = (0)::numeric) AND (title = ''::text)))),
    CONSTRAINT duty_assignments_check CHECK (((primary_id IS NULL) OR (primary_id IS DISTINCT FROM secondary_id))),
    CONSTRAINT duty_assignments_extra_points_check CHECK (((extra_points >= (0)::numeric) AND (extra_points <= (20)::numeric))),
    CONSTRAINT duty_assignments_title_check CHECK ((length(title) <= 60))
);

ALTER TABLE ONLY public.duty_assignments
    ADD CONSTRAINT duty_assignments_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX duty_assignment_version_day ON public.duty_assignments USING btree (publication_id, day) NULLS NOT DISTINCT;

CREATE INDEX duty_assignments_primary ON public.duty_assignments USING btree (primary_id);

CREATE INDEX duty_assignments_secondary ON public.duty_assignments USING btree (secondary_id);

ALTER TABLE ONLY public.duty_assignments
    ADD CONSTRAINT duty_assignments_primary_id_fkey FOREIGN KEY (primary_id) REFERENCES public.duty_members(id);

ALTER TABLE ONLY public.duty_assignments
    ADD CONSTRAINT duty_assignments_publication_id_fkey FOREIGN KEY (publication_id) REFERENCES public.duty_publications(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.duty_assignments
    ADD CONSTRAINT duty_assignments_secondary_id_fkey FOREIGN KEY (secondary_id) REFERENCES public.duty_members(id);

ALTER TABLE public.duty_assignments ENABLE ROW LEVEL SECURITY;
