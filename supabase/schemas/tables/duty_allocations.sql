-- One reviewed snapshot per working draft / immutable publication. Never expose
-- allocation reasons or counterpart trails through the ordinary calendar RPC.
CREATE TABLE public.duty_allocations (
 month text NOT NULL REFERENCES public.duty_months(month),
 publication_id uuid,
 allocation_id uuid NOT NULL DEFAULT gen_random_uuid(),
 allocation jsonb NOT NULL,
 locks jsonb NOT NULL DEFAULT '[]',
 approvals jsonb NOT NULL DEFAULT '[]',
 accounting_fingerprint text NOT NULL,
 calendar_fingerprint text NOT NULL,
 source_publication_id uuid,
 generation jsonb,
 origin text NOT NULL DEFAULT 'confirmed' CHECK (origin IN ('confirmed','restored','swap')),
 CONSTRAINT duty_allocations_publication_fkey FOREIGN KEY (month,publication_id)
  REFERENCES public.duty_publications(month,id) ON DELETE CASCADE,
 CONSTRAINT duty_allocations_shape CHECK (jsonb_typeof(allocation)='object'
  AND jsonb_typeof(locks)='array' AND jsonb_typeof(approvals)='array')
);
CREATE UNIQUE INDEX duty_allocation_version ON public.duty_allocations(month,publication_id) NULLS NOT DISTINCT;
ALTER TABLE public.duty_allocations ENABLE ROW LEVEL SECURITY;
