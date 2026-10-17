-- Read-only clean-install gate. Run before onboarding or synthetic fixtures.
DO $schema$
DECLARE t record; f record;
BEGIN
  IF (SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'duty_%') <> 11 THEN
    RAISE EXCEPTION 'Expected exactly 11 application tables';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='duty_private' OR (n.nspname='public' AND p.proname LIKE 'duty_%')) <> 32 THEN
    RAISE EXCEPTION 'Expected exactly 32 application functions';
  END IF;
  IF (SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
      WHERE n.nspname='public' AND c.contype='f' AND c.conrelid::regclass::text LIKE 'duty_%') <> 21
    OR EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
      WHERE n.nspname='public' AND c.conrelid::regclass::text LIKE 'duty_%' AND NOT c.convalidated) THEN
    RAISE EXCEPTION 'Expected 21 validated application foreign keys';
  END IF;
  IF EXISTS (SELECT 1 FROM auth.users) OR EXISTS (SELECT 1 FROM auth.identities) THEN
    RAISE EXCEPTION 'Clean database requires zero Auth users and identities';
  END IF;
  FOR t IN SELECT c.oid,c.relname,c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r' AND c.relname LIKE 'duty_%' LOOP
    IF NOT t.relrowsecurity THEN RAISE EXCEPTION 'RLS missing: %',t.relname; END IF;
    IF has_table_privilege('anon',t.oid,'SELECT,INSERT,UPDATE,DELETE')
      OR has_table_privilege('authenticated',t.oid,'INSERT,UPDATE,DELETE')
      OR NOT has_table_privilege('authenticated',t.oid,'SELECT') THEN
      RAISE EXCEPTION 'Unexpected client table privileges: %',t.relname;
    END IF;
  END LOOP;
  FOR f IN SELECT p.oid,p.proname,p.prosecdef,p.proconfig,n.nspname FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='duty_private' OR (n.nspname='public' AND p.proname LIKE 'duty_%') LOOP
    IF has_function_privilege('anon',f.oid,'EXECUTE') THEN RAISE EXCEPTION 'Anonymous execute: %',f.proname; END IF;
    IF f.proconfig IS NULL OR NOT ('search_path=""'=ANY(f.proconfig)) THEN
      RAISE EXCEPTION 'Unsafe search_path: %',f.proname;
    END IF;
    IF f.nspname='public' AND (f.prosecdef OR NOT has_function_privilege('authenticated',f.oid,'EXECUTE')) THEN
      RAISE EXCEPTION 'Invalid public RPC access: %',f.proname;
    END IF;
  END LOOP;
  IF (SELECT jsonb_agg(to_jsonb(r) ORDER BY code) FROM public.duty_roles r) IS DISTINCT FROM
    '[{"code":"admin","label":"Admin","can_manage":true},{"code":"engineer","label":"Engineer","can_manage":false}]'::jsonb
    OR (SELECT jsonb_agg(to_jsonb(r) ORDER BY code) FROM public.duty_member_statuses r) IS DISTINCT FROM
    '[{"code":"approved","label":"Approved"},{"code":"pending","label":"Pending approval"},{"code":"rejected","label":"Declined"}]'::jsonb
    OR (SELECT jsonb_agg(to_jsonb(r) ORDER BY code) FROM public.duty_month_statuses r) IS DISTINCT FROM
    '[{"code":"draft","label":"Draft"},{"code":"published","label":"Published"}]'::jsonb
    OR (SELECT jsonb_agg(to_jsonb(r) ORDER BY code) FROM public.duty_constraint_types r) IS DISTINCT FROM
    '[{"code":"no","label":"Unavailable"},{"code":"prefer","label":"Prefer duty"}]'::jsonb
    OR (SELECT jsonb_agg(to_jsonb(r)) FROM public.duty_workspace r) IS DISTINCT FROM '[{"id":true,"revision":0}]'::jsonb THEN
    RAISE EXCEPTION 'Required reference data differs';
  END IF;
  IF EXISTS (SELECT 1 FROM public.duty_members) OR EXISTS (SELECT 1 FROM public.duty_assignments)
    OR EXISTS (SELECT 1 FROM public.duty_constraints) OR EXISTS (SELECT 1 FROM public.duty_months)
    OR EXISTS (SELECT 1 FROM public.duty_publications) OR EXISTS (SELECT 1 FROM public.duty_swap_requests) THEN
    RAISE EXCEPTION 'Operational data must be empty';
  END IF;
END
$schema$;
