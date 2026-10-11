CREATE TABLE public.duty_constraints (
    member_id uuid NOT NULL,
    day date NOT NULL,
    kind text NOT NULL,
    note text DEFAULT ''::text NOT NULL,
    CONSTRAINT duty_constraints_note_check CHECK ((length(note) <= 300))
);

ALTER TABLE ONLY public.duty_constraints
    ADD CONSTRAINT duty_constraints_pkey PRIMARY KEY (member_id, day);

CREATE INDEX duty_constraints_day ON public.duty_constraints USING btree (day);

CREATE INDEX duty_constraints_kind ON public.duty_constraints USING btree (kind);

ALTER TABLE ONLY public.duty_constraints
    ADD CONSTRAINT duty_constraints_kind_fkey FOREIGN KEY (kind) REFERENCES public.duty_constraint_types(code);

ALTER TABLE ONLY public.duty_constraints
    ADD CONSTRAINT duty_constraints_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.duty_members(id);

ALTER TABLE public.duty_constraints ENABLE ROW LEVEL SECURITY;
