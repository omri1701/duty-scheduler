-- Supabase owns auth, storage, extensions and public. Only our private schema is created here.
CREATE SCHEMA duty_private;
REVOKE ALL ON SCHEMA duty_private FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA duty_private TO authenticated;
