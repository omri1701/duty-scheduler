-- The ledger is the only persisted compensation state. No balances/caches/FKs to
-- deletable publication rows: every operation contains its immutable provenance.
CREATE TABLE public.duty_compensation_events (
 sequence bigint PRIMARY KEY CHECK (sequence > 0),
 source_key text NOT NULL UNIQUE CHECK (length(source_key) BETWEEN 1 AND 240),
 at bigint NOT NULL CHECK (at BETWEEN 0 AND 9007199254740991),
 actor text NOT NULL CHECK (length(actor) BETWEEN 1 AND 80),
 reason text,
 operation jsonb NOT NULL CHECK (jsonb_typeof(operation) = 'object'),
 CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 2000)
);
ALTER TABLE public.duty_compensation_events ENABLE ROW LEVEL SECURITY;
