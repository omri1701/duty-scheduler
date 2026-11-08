-- Supabase owns auth, storage, extensions and public. Only our private schema is created here.
CREATE SCHEMA duty_private;
REVOKE ALL ON SCHEMA duty_private FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA duty_private TO authenticated;
-- The anonymous role resolves the schema only to reach duty_private.calendar_feed, the one
-- function it may execute (tests/schema.sql refuses any other anonymous EXECUTE grant).
GRANT USAGE ON SCHEMA duty_private TO anon;
