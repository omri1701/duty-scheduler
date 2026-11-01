CREATE TABLE public.duty_swap_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    month text NOT NULL,
    source_publication_id uuid,
    from_duty_id uuid,
    to_duty_id uuid,
    requester_id uuid NOT NULL,
    other_id uuid NOT NULL,
    from_day date NOT NULL,
    from_end_day date NOT NULL,
    to_day date NOT NULL,
    to_end_day date NOT NULL,
    explanation text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'awaiting_engineer'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    resolved_by uuid,
    result_publication_id uuid,
    override_reason text DEFAULT ''::text NOT NULL,
    accepted_by uuid,
    accepted_at timestamp with time zone,
    proposed_by uuid,
    requester_accepted_at timestamp with time zone,
    CONSTRAINT duty_swap_requests_check CHECK ((requester_id <> other_id)),
    CONSTRAINT duty_swap_requests_check1 CHECK ((from_day <> to_day)),
    CONSTRAINT duty_swap_requests_explanation_check CHECK ((length(explanation) <= 1000)),
    CONSTRAINT duty_swap_requests_override_reason_check CHECK ((length(override_reason) <= 1000)),
    CONSTRAINT duty_swap_requests_status_check CHECK ((status = ANY (ARRAY['awaiting_engineer'::text, 'awaiting_admin'::text, 'approved'::text, 'declined'::text, 'rejected'::text, 'cancelled'::text, 'invalidated'::text]))),
    CONSTRAINT duty_swaps_consent_check CHECK ((((status <> 'awaiting_admin'::text) OR ((accepted_by IS NOT NULL) AND (accepted_by = other_id) AND (accepted_at IS NOT NULL) AND ((proposed_by IS NULL) OR (requester_accepted_at IS NOT NULL)))) AND ((status <> 'awaiting_engineer'::text) OR (((accepted_by IS NULL) = (accepted_at IS NULL)) AND ((accepted_by IS NULL) OR ((accepted_by = other_id) AND (proposed_by IS NOT NULL) AND (requester_accepted_at IS NULL))))))),
    CONSTRAINT duty_swaps_proposer_check CHECK ((((proposed_by IS NULL) OR (proposed_by <> requester_id)) AND ((requester_accepted_at IS NULL) OR (proposed_by IS NOT NULL))))
);

ALTER TABLE ONLY public.duty_swap_requests
    ADD CONSTRAINT duty_swap_requests_pkey PRIMARY KEY (id);

CREATE INDEX duty_swaps_acceptor ON public.duty_swap_requests USING btree (accepted_by);

CREATE INDEX duty_swaps_proposer ON public.duty_swap_requests USING btree (proposed_by);

CREATE INDEX duty_swaps_from ON public.duty_swap_requests USING btree (from_duty_id);

CREATE INDEX duty_swaps_month ON public.duty_swap_requests USING btree (month);

CREATE INDEX duty_swaps_other ON public.duty_swap_requests USING btree (other_id);

CREATE INDEX duty_swaps_pending_month ON public.duty_swap_requests USING btree (month) WHERE (status = ANY (ARRAY['awaiting_engineer'::text, 'awaiting_admin'::text]));

CREATE UNIQUE INDEX duty_swaps_pending_pair ON public.duty_swap_requests USING btree (month, requester_id, from_day, to_day) WHERE (status = ANY (ARRAY['awaiting_engineer'::text, 'awaiting_admin'::text]));

CREATE INDEX duty_swaps_requester ON public.duty_swap_requests USING btree (requester_id, created_at DESC);

CREATE INDEX duty_swaps_resolver ON public.duty_swap_requests USING btree (resolved_by);

CREATE INDEX duty_swaps_result ON public.duty_swap_requests USING btree (result_publication_id);

CREATE INDEX duty_swaps_source ON public.duty_swap_requests USING btree (source_publication_id);

CREATE INDEX duty_swaps_to ON public.duty_swap_requests USING btree (to_duty_id);

ALTER TABLE ONLY public.duty_swap_requests
    ADD CONSTRAINT duty_swap_requests_accepted_by_fkey FOREIGN KEY (accepted_by) REFERENCES public.duty_members(id);

ALTER TABLE ONLY public.duty_swap_requests
    ADD CONSTRAINT duty_swap_requests_from_duty_id_fkey FOREIGN KEY (from_duty_id) REFERENCES public.duty_assignments(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.duty_swap_requests
    ADD CONSTRAINT duty_swap_requests_month_fkey FOREIGN KEY (month) REFERENCES public.duty_months(month);

ALTER TABLE ONLY public.duty_swap_requests
    ADD CONSTRAINT duty_swap_requests_proposed_by_fkey FOREIGN KEY (proposed_by) REFERENCES public.duty_members(id);

ALTER TABLE ONLY public.duty_swap_requests
    ADD CONSTRAINT duty_swap_requests_other_id_fkey FOREIGN KEY (other_id) REFERENCES public.duty_members(id);

ALTER TABLE ONLY public.duty_swap_requests
    ADD CONSTRAINT duty_swap_requests_requester_id_fkey FOREIGN KEY (requester_id) REFERENCES public.duty_members(id);

ALTER TABLE ONLY public.duty_swap_requests
    ADD CONSTRAINT duty_swap_requests_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.duty_members(id);

ALTER TABLE ONLY public.duty_swap_requests
    ADD CONSTRAINT duty_swap_requests_result_publication_id_fkey FOREIGN KEY (result_publication_id) REFERENCES public.duty_publications(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.duty_swap_requests
    ADD CONSTRAINT duty_swap_requests_source_publication_id_fkey FOREIGN KEY (source_publication_id) REFERENCES public.duty_publications(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.duty_swap_requests
    ADD CONSTRAINT duty_swap_requests_to_duty_id_fkey FOREIGN KEY (to_duty_id) REFERENCES public.duty_assignments(id) ON DELETE SET NULL;

ALTER TABLE public.duty_swap_requests ENABLE ROW LEVEL SECURITY;
