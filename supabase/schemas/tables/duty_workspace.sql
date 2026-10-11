CREATE TABLE public.duty_workspace (
    id boolean DEFAULT true NOT NULL,
    revision bigint DEFAULT 0 NOT NULL,
    CONSTRAINT duty_workspace_id_check CHECK (id)
);

ALTER TABLE ONLY public.duty_workspace
    ADD CONSTRAINT duty_workspace_pkey PRIMARY KEY (id);

ALTER TABLE public.duty_workspace ENABLE ROW LEVEL SECURITY;
